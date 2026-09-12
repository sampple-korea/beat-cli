'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { spawn } = require('child_process');
const core = require('./core');
const platform = require('./platform');
const { BeatRuntime, createGateway } = require('./server');

function codexHome(env = process.env) {
  const directory = path.resolve(env.BEAT_CODEX_HOME || path.join(core.PATHS.configDir, 'codex'));
  const canonical = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };
  const target = canonical(directory);
  for (const ordinary of [path.join(os.homedir(), '.codex'), env.CODEX_HOME].filter(Boolean)) {
    const normal = canonical(ordinary);
    if (target === normal || target.startsWith(`${normal}${path.sep}`)) throw new Error('BEAT_CODEX_HOME은 일반 CODEX_HOME/~/.codex와 별도 경로여야 합니다.');
  }
  return directory;
}
function locations(home = codexHome()) {
  return { home, preferences: path.join(home, 'beat-preferences.json'), cache: path.join(home, 'beat-models.json'), config: path.join(home, 'config.toml') };
}
function loadPreferences(home) { return core.readJson(locations(home).preferences, { optional: true, label: 'BeAT Codex 설정' }) || {}; }
function loadCache(home) {
  const cached = core.readJson(locations(home).cache, { optional: true, label: 'BeAT 모델 캐시' });
  if (!cached || !Array.isArray(cached.models) || !cached.models.length) throw new Error('BeAT 모델 캐시가 없습니다. 먼저 beat login <아이디>와 beat codex models를 실행하세요.');
  return cached;
}
function savePreferences(home, model, effort) {
  core.secureWriteJson(locations(home).preferences, { model: model.key, reasoning_effort: effort, updated_at: new Date().toISOString() });
}

function parseArguments(args) {
  const options = {}, forwarded = [];
  const actions = new Set(['install', 'update', 'setup', 'config', 'models', 'doctor']);
  const action = actions.has(args[0]) ? args[0] : 'run';
  let rest = action === 'run' ? [...args] : args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--') { forwarded.push(...rest.slice(index)); break; }
    const equals = arg.indexOf('=');
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    const values = { '-m': 'model', '--model': 'model', '-r': 'effort', '--reasoning': 'effort', '--reasoning-effort': 'effort', '--effort': 'effort', '--codex-version': 'version' };
    if (values[name]) {
      const value = equals > 0 ? arg.slice(equals + 1) : rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`${name} 뒤에 값이 필요합니다.`);
      options[values[name]] = value;
    } else if (['--help', '-h'].includes(arg)) options.help = true;
    else if (arg === '--version') options.showVersion = true;
    else if (arg === '--json') { if (action === 'run') forwarded.push(arg); else options.json = true; }
    else if (arg === '--choose') options.choose = true;
    else if (arg === '--no-prompt') options.noPrompt = true;
    else if (arg === '--cached') options.cached = true;
    else forwarded.push(arg);
  }
  return { action, options, forwarded };
}
function validateForwarded(args) {
  const valueOptions = new Set(['-c', '--config', '--enable', '--disable', '-i', '--image', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
  let subcommand = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (valueOptions.has(arg)) { index += 1; continue; }
    if (arg.startsWith('-')) continue;
    subcommand = arg;
    break;
  }
  if (['login', 'logout', 'cloud', 'app'].includes(subcommand)) {
    throw new Error('beat codex는 OpenAI 로그인·Codex Cloud·Desktop app을 사용하지 않습니다. BeAT 계정은 beat login / beat logout으로 관리하고 다른 Codex 서비스는 일반 codex 명령을 사용하세요.');
  }
  const forbiddenKeys = /^(model|review_model|model_reasoning_effort|model_reasoning_summary|model_provider|model_providers|model_catalog_json|forced_login_method|chatgpt_base_url|web_search)(\.|\s|=|$)/;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break; // Everything after this is a literal prompt, never a CLI option.
    if (['--oss', '--local-provider', '--search', '--remote', '--remote-auth-token-env'].includes(arg)
        || arg.startsWith('--local-provider=') || arg.startsWith('--remote=') || arg.startsWith('--remote-auth-token-env=')) {
      throw new Error('다른 공급자, 원격 app-server 또는 Codex 호스팅 검색을 사용하려면 일반 codex 명령을 사용하세요.');
    }
    let assignment;
    if (arg === '-c' || arg === '--config') assignment = args[++index];
    else if (arg.startsWith('--config=')) assignment = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) assignment = arg.slice(2);
    if (assignment !== undefined && forbiddenKeys.test(assignment.trim())) throw new Error('BeAT 전용 공급자, 인증 및 모델 목록 설정은 덮어쓸 수 없습니다.');
  }
}
function modelCatalog(models, selectedKey) {
  const sorted = [...models].sort((a, b) => (b.key === selectedKey ? 1 : 0) - (a.key === selectedKey ? 1 : 0));
  return { models: sorted.map((model, index) => ({
    slug: model.key, display_name: model.title, description: 'BeAT Direct Line adapter (tool calls are emulated from text)',
    default_reasoning_level: model.default_effort || 'none',
    supported_reasoning_levels: (model.efforts.length ? model.efforts : ['none']).map((effort) => ({ effort, description: effort === 'none' ? '추론 단계 없음' : `BeAT 추론 단계: ${effort}` })),
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: index,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'bytes', limit: 16000 },
    // Adapter-side operating budget, NOT a claim about the underlying model's native context limit.
    context_window: 32768, auto_compact_token_limit: 24000,
    experimental_supported_tools: [], input_modalities: ['text', 'image'],
    supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
    include_apps_usage_instructions: false, supports_search_tool: false,
    node_repl_disabled: true, tool_mode: 'direct',
    base_instructions: 'You are a coding assistant operating inside Codex. Work on the user request using the tools supplied in this conversation. Inspect relevant project instructions and existing code before editing, preserve unrelated changes, test your work, and distinguish verified results from assumptions. Tool execution and access are controlled by the client; respect its sandbox and approval decisions. Never claim that a tool ran until its result has been received. Follow the BeAT text-to-tool protocol supplied with each request when requesting a tool.',
  })) };
}
function providerConfig(baseURL) {
  return `{ name = "BeAT", base_url = ${JSON.stringify(baseURL)}, env_key = "BEAT_CODEX_API_KEY", wire_api = "responses", requires_openai_auth = false, supports_websockets = false, request_max_retries = 0, stream_max_retries = 0, stream_idle_timeout_ms = 900000 }`;
}
function prepareHome(home, models, selectedKey) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(home, 0o700);
  const config = locations(home).config;
  try {
    fs.writeFileSync(config, [
      '# BeAT-only Codex home. The launcher supplies a per-run loopback URL and key.',
      'model_provider = "beat"', 'web_search = "disabled"', 'check_for_update_on_startup = false',
      '[model_providers.beat]', 'name = "BeAT"', 'base_url = "http://127.0.0.1:1/v1"',
      'env_key = "BEAT_CODEX_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const catalog = modelCatalog(models, selectedKey);
  const hash = crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 20);
  const catalogPath = path.join(home, 'catalogs', `${hash}.json`);
  core.secureWriteJson(catalogPath, catalog);
  return catalogPath;
}
function runtimeArguments({ model, effort, catalogPath, baseURL, forwarded = [] }) {
  validateForwarded(forwarded);
  const assignments = [
    ['model_provider', '"beat"'], ['model_providers.beat', providerConfig(baseURL)],
    ['model_catalog_json', JSON.stringify(catalogPath)], ['model', JSON.stringify(model.key)],
    ['review_model', JSON.stringify(model.key)], ['model_reasoning_effort', JSON.stringify(effort || 'none')],
    ['model_reasoning_summary', '"none"'], ['web_search', '"disabled"'], ['check_for_update_on_startup', 'false'],
  ];
  return [...assignments.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...forwarded];
}
function childEnvironment(home, apiKey, env = process.env) {
  const clean = { ...env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'CODEX_API_KEY', 'CHATGPT_BASE_URL']) delete clean[key];
  clean.CODEX_HOME = home;
  clean.BEAT_CODEX_API_KEY = apiKey;
  // A global proxy should not divert the ephemeral local endpoint.
  clean.NO_PROXY = [clean.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  clean.no_proxy = [clean.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',');
  return clean;
}
async function launchCodex(options) {
  const { installed, model, effort, models, home = codexHome(), forwarded = [] } = options;
  const catalogPath = prepareHome(home, models, model.key);
  const apiKey = `beat_codex_${crypto.randomBytes(32).toString('base64url')}`;
  const config = { host: '127.0.0.1', port: 0, api_key: apiKey, concurrency: 2, max_input_chars: 200000, max_upload_mb: 100 };
  const gateway = createGateway({ config, runtime: options.runtime });
  let child;
  const handlers = new Map();
  try {
    const address = await gateway.start();
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const args = runtimeArguments({ model, effort, catalogPath, baseURL, forwarded });
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [installed.entry, ...args], { cwd: options.cwd || process.cwd(), env: childEnvironment(home, apiKey, options.env), stdio: options.stdio || 'inherit', windowsHide: false, shell: false });
      let stdout = '', stderr = '';
      const timer = options.timeout ? setTimeout(() => child.kill('SIGTERM'), options.timeout) : null;
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => { if (child.exitCode === null) child.kill(signal); };
        handlers.set(signal, handler); process.on(signal, handler);
      }
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 128 + (os.constants.signals[signal] || 1), signal, stdout, stderr }); });
    });
    return result;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await gateway.close();
  }
}
async function chooseModel(models, preferences, options) {
  let requested = options.model || preferences.model || core.loadSettings().model;
  let model;
  try { model = core.resolveModel(requested, models); }
  catch (error) {
    if (options.model) throw error;
    process.stderr.write(`저장된 모델 ${requested}이 현재 목록에 없어 ${models[0].title}을 사용합니다.\n`);
    model = models[0];
  }
  let effort = core.resolveEffort(options.effort ?? preferences.reasoning_effort ?? core.loadSettings().reasoning_effort, model, options.effort !== undefined);
  const prompt = !options.noPrompt && (options.choose || (!preferences.model && !options.model && process.stdin.isTTY));
  if (prompt) {
    if (!process.stdin.isTTY) throw new Error('--choose는 TTY에서 사용하세요. 자동 실행에서는 --model과 --reasoning을 지정하세요.');
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      models.forEach((item, index) => process.stderr.write(`${index + 1}. ${item.title} (${item.key})\n`));
      const answer = (await terminal.question(`모델 번호 또는 이름 [${model.title}]: `)).trim();
      if (answer) {
        model = /^\d+$/.test(answer) ? models[Number(answer) - 1] : core.resolveModel(answer, models);
        if (!model) throw new Error('모델 번호가 범위를 벗어났습니다.');
      }
      effort = core.resolveEffort(effort, model, false);
      if (model.efforts.length) {
        const chosen = (await terminal.question(`추론 단계 (${model.efforts.join(', ')}) [${effort}]: `)).trim();
        if (chosen) effort = core.resolveEffort(chosen, model, true);
      }
    } finally { terminal.close(); }
  }
  return { model, effort };
}
function help() {
  console.log([
    'beat codex [--model MODEL] [--reasoning EFFORT] [--choose] [Codex arguments...]',
    '', '  beat codex                         BeAT 전용 Codex 자동 설치 및 실행',
    '  beat codex config                  모델/추론 선택 후 기본값 저장',
    '  beat codex config --model sol --reasoning high --no-prompt',
    '  beat codex config show|reset        전용 설정 조회/초기화 (일반 codex는 유지)',
    '  beat codex setup                   설치, HTTP 연결, 모델 목록 및 설정 준비',
    '  beat codex install                 Codex만 설치 (BeAT 로그인 불필요)',
    '  beat codex update                  최신 Codex로 명시적 업데이트',
    '  beat codex update --codex-version 0.153.4   특정 버전 선택/복구',
    '  beat codex models [--json] [--cached]       모델 및 지원 추론 단계',
    '  beat codex doctor [--json]          네트워크 없는 설치 진단',
    '  beat codex exec -m sol -r high -- "이 저장소를 검토해줘"',
    '  beat codex resume --last            BeAT 전용 세션 이어가기',
    '', 'OpenAI 로그인이나 API 키는 필요하지 않습니다. 최초 BeAT 계정 연결은 beat login <아이디>로 합니다.',
    'Codex의 기존 승인 정책과 샌드박스를 유지합니다. 호스팅 웹 검색은 지원하지 않습니다.',
  ].join('\n'));
}
async function doctor(home, jsonOutput) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  try { add('platform', true, platform.supportedPlatform()); } catch (error) { add('platform', false, error.message); }
  add('isolated_home', true, home);
  if (process.platform === 'linux') {
    try {
      const sandbox = platform.linuxSandboxStatus();
      const observed = [
        `unprivileged_userns_clone=${sandbox.unprivileged_userns_clone ?? 'unknown'}`,
        `max_user_namespaces=${sandbox.max_user_namespaces ?? 'unknown'}`,
        `apparmor_restrict_unprivileged_userns=${sandbox.apparmor_restrict_unprivileged_userns ?? 'unknown'}`,
      ].join(', ');
      add('linux_codex_sandbox', sandbox.ok, sandbox.ok
        ? observed
        : `${sandbox.issues.join(', ')}. Codex bubblewrap용 unprivileged user namespace를 OS 관리자 정책에 맞게 허용해야 합니다. (${observed})`);
    } catch (error) { add('linux_codex_sandbox', false, `Linux sandbox 설정을 읽지 못했습니다: ${error.message}`); }
  }
  add('transport', true, 'HTTP / Direct Line (Chromium 불필요)');
  try {
    const root = path.join(platform.dataHome(), 'codex-runtime');
    const pointer = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
    const version = platform.validateVersion(pointer.version);
    const entry = path.join(root, `${version}-${platform.supportedPlatform()}`, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const result = await platform.run(process.execPath, [entry, '--version'], { timeout: 20000 });
    add('codex', true, result.stdout.trim());
  } catch (error) { add('codex', false, `beat codex install로 설치/복구하세요: ${error.message}`); }
  add('beat_auth_files', fs.existsSync(core.PATHS.session) || fs.existsSync(core.PATHS.credentials), '파일 존재 여부만 검사합니다. 실제 로그인 유효성은 beat status로 확인하세요.');
  if (jsonOutput) console.log(JSON.stringify(checks, null, 2));
  else checks.forEach((item) => console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}: ${item.detail}`));
  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
async function command(args) {
  const { action, options, forwarded } = parseArguments(args);
  if (options.help) return help();
  if (action === 'run') validateForwarded(forwarded);
  else if (forwarded.length && !(action === 'config' && forwarded.length === 1 && ['show', 'reset'].includes(forwarded[0]))) throw new Error(`알 수 없는 ${action} 인자: ${forwarded.join(' ')}`);
  const home = codexHome();
  if (action === 'doctor') return doctor(home, options.json);
  if (action === 'config' && forwarded[0] === 'show') return console.log(JSON.stringify({ ...loadPreferences(home), paths: locations(home) }, null, 2));
  if (action === 'config' && forwarded[0] === 'reset') { core.removeFile(locations(home).preferences); console.log('BeAT 모델/추론 기본값을 초기화했습니다. Codex 세션과 일반 Codex 설정은 유지됩니다.'); return; }
  const onProgress = (message) => process.stderr.write(`${message}\n`);
  let installed;
  if (['run', 'install', 'update', 'setup'].includes(action) || options.showVersion) {
    installed = await platform.ensureCodex({ version: options.version, update: action === 'update', onProgress });
    if (['install', 'update'].includes(action) || options.showVersion) {
      console.log(options.json ? JSON.stringify({ version: installed.version, entry: installed.entry }) : `BeAT Codex ${installed.version}: ${installed.entry}`);
      return;
    }
  }
  let runtime;
  try {
    let models;
    if (options.cached) {
      const cached = loadCache(home); models = cached.models;
      onProgress(`캐시 모델 목록 사용 (${cached.fetched_at}); 현재 계정의 접근 가능 여부는 실행 시 다시 확인합니다.`);
    } else {
      if (!core.loadBeatSession({ optional: true }) && !core.loadCredentials({ optional: true })) throw new Error('OpenAI 로그인은 필요하지 않습니다. BeAT 계정 연결을 위해 먼저 `beat login <아이디>`를 실행하세요.');
      runtime = new BeatRuntime({ concurrency: 2 });
      models = await runtime.models({ refresh: true });
      core.secureWriteJson(locations(home).cache, { fetched_at: new Date().toISOString(), models });
    }
    if (!models.length) throw new Error('BeAT에서 모델 목록을 읽지 못했습니다.');
    if (action === 'models') {
      if (options.json) console.log(JSON.stringify(models, null, 2));
      else models.forEach((model) => console.log(`${model.key}  ${model.title}  [${model.efforts.join(', ') || 'none'}] 기본=${model.default_effort || 'none'}`));
      return;
    }
    const preferences = loadPreferences(home);
    const selected = await chooseModel(models, preferences, { ...options, choose: options.choose || (action === 'config' && !options.model && !options.effort) });
    if (['setup', 'config'].includes(action) || !preferences.model || options.choose) savePreferences(home, selected.model, selected.effort);
    prepareHome(home, models, selected.model.key);
    if (action === 'setup' || action === 'config') { console.log(`BeAT Codex 기본값: ${selected.model.title} / ${selected.effort || 'none'}\n실행: beat codex`); return; }
    if (!runtime) runtime = new BeatRuntime({ concurrency: 2 });
    onProgress(`BeAT Codex: ${selected.model.title} / ${selected.effort || 'none'} (일반 codex와 분리됨)`);
    const result = await launchCodex({ installed, ...selected, models, home, forwarded, runtime });
    process.exitCode = result.code;
  } finally { await runtime?.close(); }
}
module.exports = { command, parseArguments, validateForwarded, codexHome, locations, modelCatalog, prepareHome, runtimeArguments, childEnvironment, launchCodex, chooseModel };
