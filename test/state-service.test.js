'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-state-service-'));
process.env.XDG_CONFIG_HOME = temporary;
const core = require('../core');
const store = require('../api-store');
const service = require('../service');
const linux = require('../linux-setup');
const beatPath = path.resolve(__dirname, '..', 'beat.js');

function child(args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
    processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
    processHandle.once('error', reject);
    processHandle.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Child exited ${code}: ${stderr || stdout}`)));
  });
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test.after(async () => {
  await child([beatPath, 'service', 'stop']).catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('asynchronous state mutations are serialized and failed mutations do not poison the queue', async () => {
  await assert.rejects(store.mutateState(() => { throw new Error('expected failure'); }), /expected failure/);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.mutateState(async (state) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    state.conversations[`async_${index}`] = { id: `async_${index}`, items: [] };
  })));
  assert.equal(Object.keys(store.loadState().conversations).filter((key) => key.startsWith('async_')).length, 12);
});
test('independent Node processes cannot lose each other state updates', async () => {
  const program = 'const store=require(process.argv[1]);store.mutateState(async s=>{await new Promise(r=>setTimeout(r,15));s.conversations[process.argv[2]]={id:process.argv[2],items:[]};}).catch(e=>{console.error(e);process.exitCode=1;});';
  await Promise.all(Array.from({ length: 8 }, (_, index) => child(['-e', program, require.resolve('../api-store'), `process_${index}`])));
  const state = store.loadState();
  for (let index = 0; index < 8; index += 1) assert.ok(Object.hasOwn(state.conversations, `process_${index}`));
});
test('expired files are hidden on reads and removed transactionally on mutation', async () => {
  const temp = store.makeTempFile('.txt');
  fs.writeFileSync(temp.filename, 'expires');
  const file = await store.storeUploadedFile(temp.filename, { filename: 'expires.txt', expiresAfterSeconds: 3600 });
  assert.ok(file.expires_at > file.created_at);
  const diskPath = store.getStoredFile(file.id).path;
  await store.mutateState((state) => { state.files[file.id].expires_at = 1; });
  assert.equal(store.getStoredFile(file.id), null);
  assert.ok(!store.listStoredFiles().data.some((item) => item.id === file.id));
  await store.cleanupExpiredFiles();
  assert.ok(!fs.existsSync(diskPath));
  assert.ok(!Object.hasOwn(store.loadState().files, file.id));
  store.cleanupTemp(temp.directory);
});
test('invalid file expiry does not leave a committed file or orphan blob', async () => {
  const before = fs.readdirSync(store.FILES_DIR);
  const temp = store.makeTempFile('.txt'); fs.writeFileSync(temp.filename, 'invalid');
  await assert.rejects(store.storeUploadedFile(temp.filename, { filename: 'x.txt', expiresAfterSeconds: 1 }));
  assert.deepEqual(fs.readdirSync(store.FILES_DIR), before);
  store.cleanupTemp(temp.directory);
});
test('metadata cannot cause file lookup or deletion outside the private blob directory', async () => {
  const outside = path.join(temporary, 'preserve.txt'); fs.writeFileSync(outside, 'preserve');
  await store.mutateState((state) => { state.files.file_bad = { id: 'file_bad', blob_path: path.join(store.FILES_DIR, '..', '..', '..', 'preserve.txt'), created_at: 1, filename: 'bad' }; });
  assert.equal(store.getStoredFile('file_bad'), null);
  await store.deleteStoredFile('file_bad');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(store.getStoredFile('__proto__'), null);
});
test('filename sanitization handles Windows separators on all operating systems', () => {
  assert.equal(store.safeFilename('C:\\Users\\someone\\private.txt'), 'private.txt');
  assert.equal(store.safeFilename('../../report.txt'), 'report.txt');
  assert.equal(store.safeFilename('line\nname.txt'), 'line_name.txt');
});
test('unknown state versions are not silently replaced', () => {
  const saved = fs.readFileSync(store.STATE_FILE, 'utf8');
  try {
    fs.writeFileSync(store.STATE_FILE, '{"version":999}');
    assert.throws(() => store.loadState());
    assert.equal(fs.readFileSync(store.STATE_FILE, 'utf8'), '{"version":999}');
  } finally { fs.writeFileSync(store.STATE_FILE, saved); }
});
test('Linux package plans distinguish distro families and do not execute os-release contents', () => {
  const cases = [
    ['ID=ubuntu\nID_LIKE=debian', 'playwright'], ['ID=alpine', 'apk'],
    ['ID=manjaro\nID_LIKE=arch', 'pacman'], ['ID=rocky\nID_LIKE="rhel centos fedora"', 'dnf'],
    ['ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"', 'zypper'], ['ID=nixos', 'unknown'],
  ];
  for (const [text, expected] of cases) {
    const plan = linux.browserInstallPlan(linux.parseOsRelease(text));
    assert.equal(plan.command || plan.kind, expected);
  }
  assert.equal(linux.parseOsRelease('PRETTY_NAME="$(touch must-not-run)"').PRETTY_NAME, '$(touch must-not-run)');
});
test('portable service starts cold without BeAT credentials, rotates its key, and stops cleanly', { timeout: 60000 }, async () => {
  const port = await unusedPort();
  await child([beatPath, 'service', 'start', '--host', '127.0.0.1', '--port', String(port)]);
  const first = await service.status();
  assert.equal(first.active, 'active');
  assert.equal(first.port, port);
  assert.equal(first.health.browser, 'cold');
  const oldKey = store.loadServiceConfig().api_key;
  const rotated = (await child([beatPath, 'service', 'key', '--rotate'])).trim();
  assert.notEqual(rotated, oldKey);
  assert.equal(rotated, store.loadServiceConfig().api_key);
  assert.equal((await service.status()).active, 'active');
  await child([beatPath, 'service', 'stop']);
  assert.equal((await service.status()).active, 'stopped');
  assert.ok(!fs.existsSync(service.RECORD));
});
test('service numeric options reject malformed values instead of quietly changing defaults', () => {
  for (const changes of [{ port: 'abc' }, { port: 0 }, { concurrency: 9 }, { max_upload_mb: -1 }, { host: '127.0.0.1; echo bad' }]) assert.throws(() => service.configure(changes));
});
test('REPL authentication failure closes the browser and does not leave a live process', async () => {
  const originalLaunch = core.launchBrowser, originalAuth = core.ensureAuthenticated;
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  let closed = false;
  core.launchBrowser = async () => ({ async close() { closed = true; } });
  core.ensureAuthenticated = async () => { throw new Error('expected auth failure'); };
  try {
    await assert.rejects(require('../beat').main(['repl']), /expected auth failure/);
    assert.ok(closed);
  } finally {
    core.launchBrowser = originalLaunch; core.ensureAuthenticated = originalAuth;
    if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY);
    else delete process.stdin.isTTY;
  }
});
