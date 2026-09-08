'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');
const core = require('./core');
const store = require('./api-store');
const platform = require('./platform');
const { createGateway } = require('./server');

const RECORD = path.join(core.PATHS.configDir, 'service-process.json');
const LOG = path.join(core.PATHS.configDir, 'service.log');
const RUNNER = path.join(__dirname, 'service-runner.js');
function urlFor(config) {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}
function readRecord() { return core.readJson(RECORD, { optional: true, label: '서비스 실행 기록' }); }
async function health(config, timeout = 2000) {
  const response = await fetch(`${urlFor(config)}/health`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json();
  if (value.service !== 'beat-openai-gateway') throw new Error('이 포트의 서비스는 BeAT 게이트웨이가 아닙니다.');
  return value;
}
async function status() {
  const record = readRecord();
  const config = store.loadServiceConfig({ create: false });
  if (!record) return { active: 'stopped', host: config?.host || '127.0.0.1', port: config?.port || 12124, health: null, log: LOG };
  try {
    const value = await health(record);
    if (value.instance_id !== record.instance_id || value.pid !== record.pid) throw new Error('서비스 인스턴스가 일치하지 않습니다. 다른 프로세스는 중지하지 않습니다.');
    return { active: 'active', ...record, health: value, log: LOG };
  } catch (error) { return { active: 'unreachable', ...record, health: null, error: error.message, log: LOG }; }
}
function clearRecord(instanceId) {
  if (readRecord()?.instance_id === instanceId) core.removeFile(RECORD);
}
async function runForeground() {
  const config = store.loadServiceConfig({ create: true });
  config.instance_id = process.env.BEAT_SERVICE_INSTANCE || crypto.randomUUID();
  let gateway, closing;
  const shutdown = () => {
    if (!closing) closing = (async () => { await gateway.close(); clearRecord(config.instance_id); })();
    return closing;
  };
  gateway = createGateway({ config, onShutdown: () => { shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }); } });
  const onSignal = () => { shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    await gateway.start();
    core.secureWriteJson(RECORD, { pid: process.pid, instance_id: config.instance_id, host: config.host, port: config.port, started_at: new Date().toISOString() });
    console.error(`[beat] ${new Date().toISOString()} ${urlFor(config)}/v1`);
  } catch (error) { await shutdown(); throw error; }
}
async function start(config) {
  const current = await status();
  if (current.active === 'active') return current;
  core.ensureConfigDir();
  const descriptor = fs.openSync(LOG, 'a', 0o600);
  const instance = crypto.randomUUID();
  let child;
  try { child = spawn(process.execPath, [RUNNER], { detached: true, stdio: ['ignore', descriptor, descriptor], windowsHide: true, env: { ...process.env, BEAT_SERVICE_INSTANCE: instance } }); }
  finally { fs.closeSync(descriptor); }
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`서비스가 종료되었습니다 (${child.exitCode}). beat service logs를 확인하세요.`);
      try { const value = await health(config, 700); if (value.instance_id === instance) return await status(); }
      catch { /* The server may still be starting. */ }
      await core.sleep(150);
    }
    throw new Error('서비스 시작을 확인하지 못했습니다. 포트 충돌과 beat service logs를 확인하세요.');
  } catch (error) { if (child.exitCode === null) child.kill(); clearRecord(instance); throw error; }
}
async function stop() {
  const current = await status();
  if (current.active === 'stopped') return false;
  if (current.active !== 'active') {
    try { process.kill(current.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { clearRecord(current.instance_id); return false; } throw error; }
    throw new Error('기록된 서비스의 신원을 확인하지 못했습니다. PID만 보고 다른 프로세스를 종료하지 않습니다. beat service logs와 실행 상태를 확인하세요.');
  }
  const config = store.loadServiceConfig({ create: false });
  const response = await fetch(`${urlFor(current)}/internal/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${config.api_key}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`서비스 중지 요청 실패: HTTP ${response.status}`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const value = await health(current, 300); if (value.instance_id !== current.instance_id) break; }
    catch { clearRecord(current.instance_id); return true; }
    await core.sleep(100);
  }
  throw new Error('서비스 종료를 확인하지 못했습니다. 실행 기록을 보존했습니다.');
}
function parse(args) {
  const action = args[0] || 'status', options = {};
  const values = new Map([['--host', 'host'], ['--port', 'port'], ['-p', 'port'], ['--concurrency', 'concurrency'], ['-c', 'concurrency'], ['--max-upload-mb', 'max_upload_mb'], ['--max-input-chars', 'max_input_chars'], ['--lines', 'lines'], ['-n', 'lines']]);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index], equals = arg.indexOf('=');
    const token = equals > 0 ? arg.slice(0, equals) : arg;
    if (['--json', '-j'].includes(arg)) options.json = true;
    else if (['--follow', '-f'].includes(arg)) options.follow = true;
    else if (arg === '--rotate') options.rotate = true;
    else if (values.has(token)) {
      const value = equals > 0 ? arg.slice(equals + 1) : args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${token} 값이 필요합니다.`);
      options[values.get(token)] = value;
    } else throw new Error(`알 수 없는 service 옵션: ${arg}`);
  }
  return { action, options };
}
function configure(options) {
  const changes = {};
  if (options.host !== undefined) { if (!/^[a-zA-Z0-9:._-]+$/.test(options.host)) throw new Error('잘못된 host입니다.'); changes.host = options.host; }
  const ranges = { port: [1, 65535], concurrency: [1, 8], max_upload_mb: [1, 1024], max_input_chars: [1000, 2000000] };
  for (const [key, [min, max]] of Object.entries(ranges)) if (options[key] !== undefined) {
    const value = Number(options[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key}는 ${min}~${max} 사이 정수여야 합니다.`);
    changes[key] = value;
  }
  return Object.keys(changes).length ? store.saveServiceConfig(changes) : store.loadServiceConfig({ create: true });
}
function xml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function unitQuote(value) { return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`; }
function startupFile() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', 'net.sampple.beat-cli.plist');
  if (process.platform === 'linux') return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'beat-openai.service');
  throw new Error('로그인 시 자동 시작은 macOS launchd와 Linux systemd --user에서 지원합니다. 이 환경에서는 beat service start 또는 beat service run을 사용하세요.');
}
function installStartup() {
  const filename = startupFile();
  const environment = { XDG_CONFIG_HOME: path.dirname(core.PATHS.configDir), BEAT_DATA_HOME: platform.dataHome() };
  const launcher = process.env.BEAT_LAUNCHER_PATH;
  const program = launcher && path.isAbsolute(launcher) && fs.existsSync(launcher)
    ? [launcher, 'service', 'run'] : [process.execPath, RUNNER];
  if (process.env.BEAT_CHROMIUM_NO_SANDBOX === '1') environment.BEAT_CHROMIUM_NO_SANDBOX = '1';
  if (process.env.BEAT_CHROMIUM_PATH) environment.BEAT_CHROMIUM_PATH = process.env.BEAT_CHROMIUM_PATH;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) environment.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const contents = process.platform === 'darwin' ? [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict><key>Label</key><string>net.sampple.beat-cli</string>',
    `<key>ProgramArguments</key><array>${program.map((value) => `<string>${xml(value)}</string>`).join('')}</array>`,
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    `<key>StandardOutPath</key><string>${xml(LOG)}</string><key>StandardErrorPath</key><string>${xml(LOG)}</string>`,
    `<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict></dict></plist>`, '',
  ].join('\n') : [
    '# Generated by beat service install; user-level, no root paths.', '[Unit]', 'Description=BeAT OpenAI-compatible gateway', 'After=network-online.target', '',
    '[Service]', 'Type=simple', `ExecStart=${program.map(unitQuote).join(' ')}`, ...Object.entries(environment).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`),
    'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=20', '', '[Install]', 'WantedBy=default.target', '',
  ].join('\n');
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, contents, { mode: 0o600 });
  return filename;
}
async function startup(action) {
  const filename = action === 'disable' ? startupFile() : installStartup();
  if (action === 'install') { console.log(filename); return; }
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    if (action === 'disable') {
      // LaunchAgents are discovered again at the next login. Removing only the
      // loaded job would therefore not actually disable persistence.
      await platform.run('launchctl', ['bootout', domain, filename]).catch(() => {});
      fs.rmSync(filename, { force: true });
    } else {
      // An already-loaded job is not an installation failure; bootout first when present.
      await platform.run('launchctl', ['bootout', domain, filename]).catch(() => {});
      await platform.run('launchctl', ['bootstrap', domain, filename], { inherit: true });
    }
  } else {
    await platform.run('systemctl', ['--user', 'daemon-reload'], { inherit: true });
    await platform.run('systemctl', ['--user', action, '--now', 'beat-openai.service'], { inherit: true });
  }
  console.log(action === 'enable' ? '사용자 로그인 시 자동 시작을 활성화했습니다.' : '사용자 자동 시작을 비활성화했습니다.');
}
async function logs(options) {
  const lines = Number(options.lines || 100);
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error('--lines는 1~10000 사이 정수여야 합니다.');
  if (process.platform === 'linux' && fs.existsSync(startupFile())) {
    let managed = false;
    try { await platform.run('systemctl', ['--user', 'is-active', '--quiet', 'beat-openai.service']); managed = true; } catch { /* Portable detached service uses the log file below. */ }
    if (managed) return platform.run('journalctl', ['--user', '-u', 'beat-openai.service', '-n', String(lines), '--no-pager', ...(options.follow ? ['-f'] : [])], { inherit: true });
  }
  let offset = 0;
  if (fs.existsSync(LOG)) {
    const size = fs.statSync(LOG).size, start = Math.max(0, size - 1024 * 1024);
    const fd = fs.openSync(LOG, 'r'), buffer = Buffer.alloc(size - start);
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    process.stdout.write(buffer.toString('utf8').split('\n').slice(-lines - 1).join('\n'));
    offset = size;
  }
  if (!options.follow) return;
  await new Promise((resolve) => {
    const stopFollow = () => { fs.unwatchFile(LOG); process.off('SIGINT', stopFollow); process.off('SIGTERM', stopFollow); resolve(); };
    process.once('SIGINT', stopFollow); process.once('SIGTERM', stopFollow);
    fs.watchFile(LOG, { interval: 500 }, (current) => {
      if (current.size < offset) offset = 0;
      if (current.size > offset) {
        const stream = fs.createReadStream(LOG, { start: offset, end: current.size - 1 });
        stream.on('error', stopFollow); stream.pipe(process.stdout, { end: false }); offset = current.size;
      }
    });
  });
}
async function command(args) {
  if (args.some((arg) => ['--help', '-h'].includes(arg))) { console.log('beat service start|run|stop|restart|status|logs|key|url|install|enable|disable|test\nstart/run: --host --port --concurrency --max-upload-mb --max-input-chars\nlogs: --lines N --follow; status: --json; key: --rotate\nstart/stop는 systemd 없이 작동합니다. enable/disable은 사용자 launchd/systemd가 필요합니다.'); return; }
  const { action, options } = parse(args);
  if (action === 'status') { const value = await status(); console.log(options.json ? JSON.stringify(value, null, 2) : `서비스: ${value.active}\n주소: ${urlFor(value)}/v1${value.error ? `\n${value.error}` : ''}\n로그: ${LOG}`); return; }
  if (action === 'logs') return logs(options);
  if (action === 'run') { configure(options); return runForeground(); }
  if (action === 'url') return console.log(`${urlFor(store.loadServiceConfig({ create: true }))}/v1`);
  if (action === 'key' && !options.rotate) return console.log(store.loadServiceConfig({ create: true }).api_key);
  if (['install', 'enable', 'disable'].includes(action)) {
    if (action === 'enable' && (await status()).active === 'active') await stop();
    return startup(action);
  }
  if (action === 'test') {
    const config = store.loadServiceConfig({ create: true });
    const response = await fetch(`${urlFor(config)}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: core.loadSettings().model, input: '연결 시험입니다. 짧게 확인이라고 답하세요.', store: false }), signal: AbortSignal.timeout(12 * 60 * 1000) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`); console.log(body.output_text); return;
  }
  if (!['start', 'restart', 'stop', 'key'].includes(action)) throw new Error(`알 수 없는 service 명령: ${action}`);
  core.ensureConfigDir();
  const release = await lockfile.lock(path.join(core.PATHS.configDir, 'service-control'), { realpath: false, retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 100 }, stale: 60000 });
  try {
    if (action === 'stop') { await stop(); console.log('BeAT 서비스를 중지했습니다.'); return; }
    if (action === 'key') {
      const wasRunning = (await status()).active === 'active';
      if (wasRunning) await stop();
      const config = store.rotateServiceKey(); if (wasRunning) await start(config); console.log(config.api_key); return;
    }
    if (action === 'restart') await stop();
    else if ((await status()).active === 'active') { console.log('이미 실행 중입니다. 설정 변경에는 beat service restart를 사용하세요.'); return; }
    const config = configure(options);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) console.error('주의: 외부 바인딩입니다. TLS, 방화벽, API 키 보호를 별도로 구성하세요.');
    const running = await start(config); console.log(`BeAT 서비스 실행 중: ${urlFor(running)}/v1`);
  } finally { await release(); }
}
module.exports = { command, runForeground, status, urlFor, configure, parse, RECORD, LOG };
