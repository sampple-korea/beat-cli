'use strict';

const fs = require('fs');
const path = require('path');

function parseOsRelease(text) {
  const output = Object.create(null);
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    output[match[1]] = value;
  }
  return output;
}
function browserInstallPlan(release) {
  const ids = `${release.ID || ''} ${release.ID_LIKE || ''}`.toLowerCase().split(/\s+/);
  if (ids.includes('alpine')) return { kind: 'native', command: 'apk', args: ['add', 'chromium', 'nss', 'freetype', 'harfbuzz', 'ca-certificates', 'ttf-freefont'] };
  if (ids.some((id) => ['arch', 'manjaro', 'endeavouros'].includes(id))) return { kind: 'native', command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'chromium'] };
  if (ids.some((id) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(id))) return { kind: 'native', command: 'dnf', args: ['install', '-y', 'chromium'] };
  if (ids.some((id) => id === 'suse' || id.startsWith('opensuse'))) return { kind: 'native', command: 'zypper', args: ['--non-interactive', 'install', 'chromium'] };
  if (ids.some((id) => ['debian', 'ubuntu', 'linuxmint', 'pop'].includes(id))) return { kind: 'playwright' };
  return { kind: 'unknown', distribution: release.PRETTY_NAME || release.ID || 'unknown Linux' };
}
function currentRelease() {
  try { return parseOsRelease(fs.readFileSync('/etc/os-release', 'utf8')); }
  catch { return {}; }
}
function executable(command, env = process.env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command)).find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}
async function installNative(plan, run, onProgress = () => {}) {
  const manager = executable(plan.command);
  if (!manager) throw new Error(`${plan.command} 패키지 관리자를 찾지 못했습니다. 배포판 Chromium을 설치하고 BEAT_CHROMIUM_PATH를 지정하세요.`);
  const root = process.getuid?.() === 0;
  const sudo = root ? null : executable('sudo');
  if (!root && !sudo) throw new Error('시스템 패키지 설치에 필요한 sudo/root 권한이 없습니다. 관리자가 Chromium과 의존성을 설치한 뒤 다시 실행하세요.');
  onProgress(`명시한 --with-deps에 따라 실행: ${root ? '' : 'sudo '}${plan.command} ${plan.args.join(' ')}`);
  try {
    await run(root ? manager : sudo, root ? plan.args : [manager, ...plan.args], { inherit: true, timeout: 15 * 60 * 1000 });
  } catch (error) {
    throw new Error(`배포판 Chromium 설치 실패: ${error.message}\n현재 활성화된 공식 저장소에서 chromium을 제공하는지 확인하세요. 저장소 추가·전체 시스템 업데이트는 자동으로 하지 않습니다.`);
  }
}
module.exports = { parseOsRelease, browserInstallPlan, currentRelease, installNative };
