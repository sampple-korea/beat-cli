'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-unit-'));
process.env.XDG_CONFIG_HOME = temporary;
const core = require('../core');
const cli = require('../beat');
const platform = require('../platform');
const codex = require('../codex');
const { parseModelCatalog } = require('../model-catalog');
const sample = { title: 'GPT Sol', reasoning_effort_default: 'high', reasoning_efforts: ['low', 'high'], key: 'chat_gpt5_6_sol' };
const models = [{ key: sample.key, title: sample.title, efforts: ['low', 'high'], default_effort: 'high' }];

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
test('catalog parser does not depend on property order', () => {
  assert.deepEqual(parseModelCatalog(JSON.stringify({ [sample.key]: sample })), models);
});
test('catalog parser reads escaped Next.js flight payloads', () => {
  const data = `x:${JSON.stringify({ [sample.key]: sample })}`;
  const script = `self.__next_f.push([1,${JSON.stringify(data)}]);`;
  assert.deepEqual(parseModelCatalog(script), models);
});
test('catalog parser handles braces and escaped quotes in model titles', () => {
  const value = { ...sample, title: 'A { brace } and "quote"' };
  assert.equal(parseModelCatalog(`prefix:${JSON.stringify({ [value.key]: value })}`)[0].title, value.title);
});
test('catalog parser rejects incomplete definitions without borrowing next model fields', () => {
  const input = JSON.stringify({ chat_bad: { key: 'chat_bad', title: 'incomplete' }, [sample.key]: sample });
  assert.deepEqual(parseModelCatalog(input), models);
});
test('catalog parser accepts an array and deduplicates efforts', () => {
  const input = [{ ...sample, reasoning_efforts: ['low', 'low', 'high'] }];
  assert.deepEqual(parseModelCatalog(JSON.stringify(input)), models);
});
test('model aliases and actual catalog availability are enforced', () => {
  assert.equal(core.resolveModel('sol', models).key, sample.key);
  assert.throws(() => core.resolveModel('nonexistent', models));
});
test('unsupported explicit reasoning is rejected; stale saved reasoning falls back', () => {
  assert.throws(() => core.resolveEffort('max', models[0], true));
  assert.equal(core.resolveEffort('max', models[0], false), 'high');
  assert.equal(core.resolveEffort('높음', models[0], true), 'high');
});
test('nonreasoning models accept none but reject fabricated effort levels', () => {
  const model = { key: 'chat_simple', title: 'Simple', efforts: [], default_effort: null };
  assert.equal(core.resolveEffort('none', model, true), null);
  assert.throws(() => core.resolveEffort('high', model, true));
});
test('conversation IDs include UUIDv7 and reject invalid identifiers', () => {
  assert.equal(core.validateConversationId('01948c77-7525-7000-8000-abcdef123456'), '01948c77-7525-7000-8000-abcdef123456');
  assert.throws(() => core.validateConversationId('../../arbitrary'));
});
test('atomic JSON writes use the destination directory', () => {
  const filename = path.join(temporary, 'nested', 'child', 'value.json');
  core.secureWriteJson(filename, { value: '한글' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { value: '한글' });
  core.secureWriteJson(filename, { value: 'overwrite' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { value: 'overwrite' });
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['value.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});
test('ordinary CLI parser does not swallow a following option as a value', () => {
  assert.throws(() => cli.parseArguments(['--model', '--json'], { ...cli.aliases('model', 'value', '--model'), ...cli.aliases('json', 'boolean', '--json') }), /값이 필요/);
});
test('Codex wrapper parses model and reasoning without consuming its prompt', () => {
  const parsed = codex.parseArguments(['exec', '-m', 'sol', '--reasoning=high', '--', '--literal-prompt']);
  assert.deepEqual(parsed.options, { model: 'sol', effort: 'high' });
  assert.deepEqual(parsed.forwarded, ['exec', '--', '--literal-prompt']);
});
test('Codex wrapper rejects missing values', () => {
  assert.throws(() => codex.parseArguments(['--model', '--choose']));
  assert.throws(() => codex.parseArguments(['--reasoning=']));
});
test('Codex provider overrides and accidental OpenAI login are blocked', () => {
  for (const args of [['login'], ['logout'], ['-c', 'model_provider="openai"'], ['exec', '--config=model_providers.beat.base_url="https://example.com"'], ['--oss']]) assert.throws(() => codex.validateForwarded(args));
  assert.doesNotThrow(() => codex.validateForwarded(['exec', '--sandbox', 'workspace-write', '--', '--config=model_provider=not-an-option']));
});
test('Codex child environment isolates state and removes OpenAI credentials', () => {
  const env = codex.childEnvironment('/isolated/home', 'local-key', { CODEX_HOME: '/ordinary/home', OPENAI_API_KEY: 'sentinel', OPENAI_BASE_URL: 'sentinel', PATH: 'preserved', NO_PROXY: 'example.com' });
  assert.equal(env.CODEX_HOME, '/isolated/home');
  assert.equal(env.BEAT_CODEX_API_KEY, 'local-key');
  assert.ok(!Object.hasOwn(env, 'OPENAI_API_KEY'));
  assert.ok(!Object.hasOwn(env, 'OPENAI_BASE_URL'));
  assert.equal(env.PATH, 'preserved');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
});
test('BeAT home cannot be the ordinary Codex home', () => {
  assert.throws(() => codex.codexHome({ BEAT_CODEX_HOME: path.join(os.homedir(), '.codex') }));
  const same = path.join(temporary, 'ordinary');
  assert.throws(() => codex.codexHome({ BEAT_CODEX_HOME: same, CODEX_HOME: same }));
});
test('model picker catalog contains dynamic reasoning and required Codex metadata', () => {
  const catalog = codex.modelCatalog(models, models[0].key);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map((item) => item.effort), ['low', 'high']);
  assert.ok(catalog.models[0].base_instructions);
  assert.equal(catalog.models[0].supported_in_api, true);
  assert.equal(catalog.models[0].shell_type, 'unified_exec');
});
test('preparing BeAT home preserves hand-edited private config and creates valid catalog', () => {
  const home = path.join(temporary, 'private with spaces');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), '# user settings\n');
  const catalog = codex.prepareHome(home, models, models[0].key);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), '# user settings\n');
  assert.equal(JSON.parse(fs.readFileSync(catalog, 'utf8')).models[0].slug, models[0].key);
});
test('supported platforms and exact version validation', () => {
  for (const osName of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) assert.equal(platform.supportedPlatform(osName, arch), `${osName}-${arch}`);
  for (const pair of [['linux', 'arm'], ['freebsd', 'x64'], ['android', 'arm64']]) assert.throws(() => platform.supportedPlatform(...pair));
  assert.equal(platform.validateVersion('0.153.4'), '0.153.4');
  for (const invalid of ['latest', '../1.2.3', '1.2.3;echo bad', '-g']) assert.throws(() => platform.validateVersion(invalid));
});
test('Linux Codex sandbox diagnostics detect user namespace and AppArmor blockers', () => {
  const procRoot = path.join(temporary, 'fake-proc-sys');
  fs.mkdirSync(path.join(procRoot, 'kernel'), { recursive: true });
  fs.mkdirSync(path.join(procRoot, 'user'), { recursive: true });
  fs.writeFileSync(path.join(procRoot, 'kernel', 'unprivileged_userns_clone'), '0\n');
  fs.writeFileSync(path.join(procRoot, 'kernel', 'apparmor_restrict_unprivileged_userns'), '1\n');
  fs.writeFileSync(path.join(procRoot, 'user', 'max_user_namespaces'), '0\n');
  const blocked = platform.linuxSandboxStatus(procRoot, 'linux');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.issues, [
    'kernel.unprivileged_userns_clone=0',
    'user.max_user_namespaces=0',
    'kernel.apparmor_restrict_unprivileged_userns=1',
  ]);
  fs.writeFileSync(path.join(procRoot, 'kernel', 'unprivileged_userns_clone'), '1\n');
  fs.writeFileSync(path.join(procRoot, 'kernel', 'apparmor_restrict_unprivileged_userns'), '0\n');
  fs.writeFileSync(path.join(procRoot, 'user', 'max_user_namespaces'), '65536\n');
  assert.equal(platform.linuxSandboxStatus(procRoot, 'linux').ok, true);
  assert.equal(platform.linuxSandboxStatus(procRoot, 'darwin'), null);
});
test('browser discovery includes macOS applications and Windows standard locations', () => {
  assert.ok(platform.chromiumCandidates({}, 'darwin').some((item) => item.includes('Google Chrome.app')));
  assert.ok(platform.chromiumCandidates({ LOCALAPPDATA: 'C:\\Test User' }, 'win32').some((item) => item.includes('chrome.exe')));
});
test('Linux Chromium dependency setup recognizes non-Debian package managers', () => {
  const bin = path.join(temporary, 'fake-linux-bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'dnf.exe' : 'dnf');
  fs.writeFileSync(executable, 'fake');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  const plan = platform.linuxChromiumInstaller({ PATH: bin }, { ID: 'fedora' });
  assert.equal(path.resolve(plan.command), path.resolve(executable));
  assert.equal(plan.name, 'dnf');
  assert.deepEqual(plan.args, ['install', '-y', 'chromium']);
});
test('explicit invalid browser overrides are not silently replaced', () => {
  const previous = process.env.BEAT_CHROMIUM_PATH;
  process.env.BEAT_CHROMIUM_PATH = path.join(temporary, 'missing-browser');
  try { assert.throws(() => platform.findChromium()); }
  finally { if (previous === undefined) delete process.env.BEAT_CHROMIUM_PATH; else process.env.BEAT_CHROMIUM_PATH = previous; }
});
test('selecting an already installed Codex version updates its private pointer', async () => {
  const dataHome = path.join(temporary, 'runtime-test');
  const root = path.join(dataHome, 'codex-runtime');
  for (const version of ['1.0.0', '1.0.1']) {
    const packageDir = path.join(root, `${version}-${platform.supportedPlatform()}`, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
    fs.writeFileSync(path.join(packageDir, 'bin', 'codex.js'), `console.log('codex-cli ${version}');`);
  }
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: '1.0.0' }));
  const installed = await platform.ensureCodex({ dataHome, version: '1.0.1' });
  assert.equal(installed.version, '1.0.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8')).version, '1.0.1');
});
test('help commands work from a different working directory without credentials or installs', () => {
  for (const args of [['help'], ['codex', '--help'], ['setup', '--help'], ['service', '--help']]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'beat.js'), ...args], { cwd: temporary, encoding: 'utf8', env: { ...process.env, BEAT_DATA_HOME: path.join(temporary, 'must-not-install') } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /beat/);
  }
  assert.ok(!fs.existsSync(path.join(temporary, 'must-not-install')));
});
