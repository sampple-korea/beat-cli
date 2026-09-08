'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lockfile = require('proper-lockfile');

// Deliberately pinned: updating BeAT must not silently replace a working agent.
const CODEX_VERSION = '0.153.4';

function dataHome(env = process.env) {
  return path.resolve(env.BEAT_DATA_HOME || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'beat-cli'));
}

function supportedPlatform(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Codex 자동 설치 미지원 환경: ${platform}/${arch}. 공식 바이너리가 있는 macOS/Linux/Windows x64 또는 arm64가 필요합니다.`);
  }
  return `${platform}-${arch}`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true,
      cwd: options.cwd, env: options.env || process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    const timer = options.timeout ? setTimeout(() => { timedOut = true; child.kill(); }, options.timeout) : null;
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve({ stdout, stderr, code });
      else reject(Object.assign(new Error(timedOut ? '명령 실행 시간이 초과되었습니다.' : `${path.basename(command)} 실행 실패 (${signal || code}): ${stderr.trim() || stdout.trim()}`), { exitCode: code || 1 }));
    });
  });
}

function npmInvocation(env = process.env) {
  // Avoid cmd.exe quoting/injection bugs on Windows and paths containing spaces.
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  const cli = candidates.find((file) => file && /npm-cli\.js$/i.test(file) && fs.existsSync(file));
  if (cli) return { command: process.execPath, args: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('npm-cli.js를 찾지 못했습니다. Node.js와 npm을 함께 설치한 뒤 다시 실행하세요.');
}

async function npm(args, options = {}) {
  const invocation = npmInvocation(options.env);
  return run(invocation.command, [...invocation.args, ...args], options);
}

function commandInPath(name, env = process.env) {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Try next candidate. */ }
    }
  }
  return null;
}

async function runElevated(command, args, options = {}) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return run(command, args, options);
  const sudo = commandInPath('sudo', options.env || process.env);
  if (!sudo) throw new Error(`시스템 패키지 설치에 관리자 권한이 필요합니다. sudo가 없으므로 root에서 다시 실행하거나 ${path.basename(command)}를 직접 실행하세요.`);
  return run(sudo, [command, ...args], options);
}

function linuxSandboxStatus(procRoot = '/proc/sys', platformName = process.platform) {
  if (platformName !== 'linux') return null;
  const read = (...parts) => {
    try { return fs.readFileSync(path.join(procRoot, ...parts), 'utf8').trim(); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
      throw error;
    }
  };
  const unprivileged = read('kernel', 'unprivileged_userns_clone');
  const maximum = read('user', 'max_user_namespaces');
  const apparmor = read('kernel', 'apparmor_restrict_unprivileged_userns');
  const issues = [];
  if (unprivileged === '0') issues.push('kernel.unprivileged_userns_clone=0');
  if (maximum !== null && /^\d+$/.test(maximum) && BigInt(maximum) === 0n) issues.push('user.max_user_namespaces=0');
  if (apparmor !== null && apparmor !== '0') issues.push(`kernel.apparmor_restrict_unprivileged_userns=${apparmor}`);
  return {
    ok: issues.length === 0,
    unprivileged_userns_clone: unprivileged,
    max_user_namespaces: maximum,
    apparmor_restrict_unprivileged_userns: apparmor,
    issues,
  };
}

function linuxChromiumInstaller(env = process.env, release) {
  const linux = require('./linux-setup');
  const plan = linux.browserInstallPlan(release || linux.currentRelease());
  if (plan.kind === 'playwright') return { playwright: true, name: 'apt/Playwright' };
  if (plan.kind === 'native') {
    const command = commandInPath(plan.command, env);
    if (command) return { command, args: plan.args, name: plan.command };
    // ID_LIKE can describe an older derivative whose preferred manager is
    // absent (for example yum-only CentOS). Fall through to actual PATH.
  }
  const manager = (name) => commandInPath(name, env);
  if (fs.existsSync('/etc/alpine-release') && manager('apk')) return { command: manager('apk'), args: ['add', 'chromium', 'nss', 'freetype', 'harfbuzz', 'ca-certificates', 'ttf-freefont'], name: 'apk' };
  if (manager('dnf')) return { command: manager('dnf'), args: ['install', '-y', 'chromium'], name: 'dnf' };
  if (manager('yum')) return { command: manager('yum'), args: ['install', '-y', 'chromium'], name: 'yum' };
  if (manager('pacman')) return { command: manager('pacman'), args: ['-S', '--needed', '--noconfirm', 'chromium'], name: 'pacman' };
  if (manager('zypper')) return { command: manager('zypper'), args: ['--non-interactive', 'install', 'chromium'], name: 'zypper' };
  if (manager('xbps-install')) return { command: manager('xbps-install'), args: ['-Sy', 'chromium'], name: 'xbps-install' };
  // apt-based systems are best handled by Playwright itself: it installs the
  // exact shared-library set needed by the bundled Chromium build.
  if (manager('apt-get')) return { playwright: true, name: 'apt/Playwright' };
  return null;
}

function validateVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?$/.test(String(value))) {
    throw new Error('Codex 버전은 0.153.4 같은 정확한 버전이어야 합니다. 최신 버전은 beat codex update로 선택하세요.');
  }
  return String(value);
}

function codexEntry(directory) {
  return path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

async function verifyCodex(directory, version) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'));
  if (metadata.name !== '@openai/codex' || metadata.version !== version) throw new Error('설치된 Codex 패키지의 이름 또는 버전이 일치하지 않습니다.');
  const entry = codexEntry(directory);
  const result = await run(process.execPath, [entry, '--version'], { timeout: 20000 });
  if (!result.stdout.includes(version)) throw new Error('설치된 Codex 실행 파일의 버전을 확인하지 못했습니다.');
  return { entry, version, directory };
}

async function ensureCodex(options = {}) {
  const target = supportedPlatform();
  const root = path.join(options.dataHome || dataHome(), 'codex-runtime');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const pointer = path.join(root, 'current.json');
  let version = options.version;
  if (options.update && !version) {
    const result = await npm(['view', '@openai/codex', 'version', '--json'], { timeout: 60000 });
    version = JSON.parse(result.stdout);
  }
  if (!version && !options.update) {
    try { version = JSON.parse(fs.readFileSync(pointer, 'utf8')).version; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Codex 설치 기록을 읽지 못했습니다: ${error.message}`); }
  }
  version = validateVersion(version || CODEX_VERSION);
  const directory = path.join(root, `${version}-${target}`);
  const savePointer = () => {
    const temporary = path.join(root, `.current-${process.pid}-${require('crypto').randomUUID()}.json`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version, platform: target })}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, pointer);
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  try {
    const installed = await verifyCodex(directory, version);
    if (!options.version && !options.update && fs.existsSync(pointer)) return installed;
  } catch { /* Install or repair below. */ }
  const release = await lockfile.lock(path.join(root, 'install'), {
    realpath: false, stale: 10 * 60 * 1000,
    retries: { retries: 600, factor: 1, minTimeout: 200, maxTimeout: 200 },
  });
  let staging;
  try {
    try {
      const installed = await verifyCodex(directory, version);
      savePointer();
      return installed;
    } catch { /* Another installer may have finished. */ }
    options.onProgress?.(`BeAT 전용 Codex ${version} 설치 중 (${target}, 전역 codex는 변경하지 않음)...`);
    staging = fs.mkdtempSync(path.join(root, '.install-'));
    // npm verifies registry tarball integrity. Lifecycle scripts are not needed by Codex.
    // Explicit --include=optional overrides environments that omit native packages.
    await npm(['install', '--prefix', staging, '--no-audit', '--no-fund', '--ignore-scripts', '--include=optional', '--save-exact', `@openai/codex@${version}`], {
      timeout: 10 * 60 * 1000,
      env: { ...process.env, npm_config_engine_strict: 'true' },
    });
    await verifyCodex(staging, version);
    // Do not remove any previous working version until the new binary is verified.
    if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.broken-${Date.now()}`);
    fs.renameSync(staging, directory);
    staging = null;
    savePointer();
    return await verifyCodex(directory, version);
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    await release();
  }
}

function chromiumCandidates(env = process.env, platform = process.platform) {
  let bundled;
  try { bundled = require('playwright-core').chromium.executablePath(); } catch { /* Dependencies not installed yet. */ }
  const candidates = [env.BEAT_CHROMIUM_PATH, bundled];
  if (platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      candidates.push(path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      candidates.push(path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
    }
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/snap/bin/chromium');
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, 'chromium'), path.join(dir, 'chromium-browser'), path.join(dir, 'google-chrome'));
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function findChromium() {
  const candidates = chromiumCandidates();
  // An explicit override is authoritative: never silently use a different browser.
  if (process.env.BEAT_CHROMIUM_PATH) candidates.splice(1);
  const found = candidates.find((file) => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!found) throw new Error('Chromium을 찾지 못했습니다. `beat setup`을 실행하거나 BEAT_CHROMIUM_PATH에 브라우저 실행 파일의 절대 경로를 지정하세요.');
  return found;
}

async function ensureChromium(options = {}) {
  if (process.env.BEAT_CHROMIUM_PATH) return findChromium();
  // --with-deps deliberately repairs missing shared libraries even when the
  // executable already exists; plain setup may reuse a working installation.
  try { if (!options.withDeps || process.platform !== 'linux') return findChromium(); } catch { /* Continue with installation. */ }
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  if (options.withDeps && process.platform === 'linux') {
    const installer = linuxChromiumInstaller(options.env || process.env);
    if (installer && !installer.playwright) {
      options.onProgress?.(`${installer.name}로 시스템 Chromium과 런타임 의존성을 준비합니다...`);
      try {
        await runElevated(installer.command, installer.args, { inherit: true, timeout: 15 * 60 * 1000, env: options.env });
        return findChromium();
      } catch (error) {
        throw new Error(`${installer.name} Chromium 설치 실패: ${error.message}\n현재 활성화된 배포판 저장소에서 chromium을 제공하는지 확인하세요. 시스템 저장소 추가나 전체 업데이트는 자동으로 하지 않습니다.`);
      }
    } else if (installer?.playwright) {
      options.onProgress?.('Playwright로 Chromium과 Linux 런타임 의존성을 준비합니다...');
      await run(process.execPath, [cli, 'install', '--with-deps', 'chromium'], { inherit: true, timeout: 15 * 60 * 1000, env: options.env });
      return findChromium();
    } else {
      options.onProgress?.('인식 가능한 Linux 패키지 관리자를 찾지 못해 Playwright Chromium을 설치합니다. 공유 라이브러리는 배포판에서 별도 설치가 필요할 수 있습니다.');
    }
  } else {
    options.onProgress?.('BeAT용 Chromium을 준비합니다. 시스템 의존성 설치는 --with-deps를 명시한 경우에만 진행합니다.');
  }
  if (process.platform === 'linux' && fs.existsSync('/etc/alpine-release')) throw new Error('Alpine/musl에서는 배포판 Chromium이 필요합니다. beat setup --with-deps 또는 apk add chromium을 사용하세요.');
  await run(process.execPath, [cli, 'install', 'chromium'], { inherit: true, timeout: 15 * 60 * 1000, env: options.env });
  return findChromium();
}

function browserSandboxEnabled(env = process.env) {
  return env.BEAT_CHROMIUM_NO_SANDBOX !== '1' && !(process.platform === 'linux' && process.getuid?.() === 0);
}

async function setup(args = []) {
  const allowed = new Set(['--with-deps', '--browser-only', '--help', '-h']);
  for (const arg of args) if (!allowed.has(arg)) throw new Error(`알 수 없는 setup 옵션: ${arg}`);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('beat setup [--with-deps] [--browser-only]\n사용자 전용 Codex와 Chromium 설치. --with-deps는 Linux 시스템 라이브러리 설치를 명시적으로 허용합니다.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 이상이 필요합니다.');
  const onProgress = (message) => process.stderr.write(`${message}\n`);
  if (!args.includes('--browser-only')) {
    const codex = await ensureCodex({ onProgress });
    console.log(`Codex: ${codex.version}`);
  }
  const browser = await ensureChromium({ withDeps: args.includes('--with-deps'), onProgress });
  // Detect missing shared libraries now, not after the user enters credentials.
  const launchArgs = ['--disable-dev-shm-usage'];
  if (!browserSandboxEnabled()) launchArgs.unshift('--no-sandbox');
  try {
    const instance = await require('playwright-core').chromium.launch({ executablePath: browser, headless: true, chromiumSandbox: browserSandboxEnabled(), args: launchArgs });
    await instance.close();
  } catch (error) {
    throw new Error(`Chromium 실행 검증 실패: ${error.message}\nLinux에서는 beat setup --with-deps로 시스템 라이브러리를 준비하세요. BEAT_CHROMIUM_PATH를 지정했다면 그 브라우저의 의존성을 확인하세요.`);
  }
  console.log('설치 및 브라우저 시작 확인 완료. BeAT 계정은 beat login <아이디>로 연결하세요.');
}

module.exports = { CODEX_VERSION, dataHome, supportedPlatform, run, npmInvocation, commandInPath, linuxSandboxStatus, linuxChromiumInstaller, browserSandboxEnabled, validateVersion, ensureCodex, chromiumCandidates, findChromium, ensureChromium, setup };
