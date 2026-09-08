'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

if (process.platform === 'win32') {
  console.log('POSIX installer smoke test: skipped on native Windows; run on macOS/Linux.');
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "beat install ' spaces-"));
const source = path.resolve(__dirname, '..');
const installer = path.join(source, 'install.sh');
const home = path.join(root, 'home');
const data = path.join(root, "data with ' quote");
const bin = path.join(root, "bin with ' quote");
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, '.bashrc'), '# Preserve this existing user configuration.\n');
const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local', 'share'),
  BEAT_DATA_HOME: data, BEAT_BIN_DIR: bin, BEAT_SOURCE_DIR: source,
  BEAT_INSTALL_FORCE_NODE: process.env.BEAT_SMOKE_BOOTSTRAP_NODE || '0',
};
function run(command, args, changes = {}, expected = 0) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...changes }, encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== expected) process.stderr.write(`${result.stdout}\n${result.stderr}\n`);
  assert.equal(result.status, expected, `${command} ${args.join(' ')} failed`);
  return result;
}
try {
  run('/bin/sh', ['-n', installer]);
  run('/bin/sh', [installer, '--no-setup']);
  const command = path.join(bin, 'beat');
  assert.equal(run(command, ['version']).stdout.trim(), require('../package.json').version);
  const activated = run('/bin/sh', ['-c', '. "$1"; command -v beat; beat version', 'installer-test', path.join(data, 'env')]);
  assert.equal(fs.realpathSync(activated.stdout.trim().split('\n')[0]), fs.realpathSync(command));
  const first = fs.readFileSync(command, 'utf8');
  const config = path.join(env.XDG_CONFIG_HOME, 'beat-cli');
  fs.mkdirSync(config, { recursive: true });
  const sentinel = '{"test_sentinel":"must_not_change"}\n';
  fs.writeFileSync(path.join(config, 'credentials.json'), sentinel, { mode: 0o600 });
  run('/bin/sh', [installer, '--no-setup']);
  assert.equal(fs.readFileSync(path.join(config, 'credentials.json'), 'utf8'), sentinel);
  assert.equal(fs.readFileSync(path.join(data, 'previous-launcher'), 'utf8'), first);
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  assert.equal(bashrc.split('# BeAT CLI PATH').length - 1, 1, '.bashrc must not contain duplicate PATH blocks');
  assert.ok(bashrc.includes('Preserve this existing user configuration.'));
  assert.ok(!fs.existsSync(path.join(home, '.profile')), 'Installer must not create unused .profile when a profile already exists.');
  assert.ok(!fs.existsSync(path.join(home, '.zshrc')), 'Installer must not create an unused zsh profile.');
  const beforeFailure = fs.readFileSync(command, 'utf8');
  run('/bin/sh', [installer, '--no-setup'], { BEAT_SOURCE_DIR: path.join(root, 'missing-source') }, 1);
  assert.equal(fs.readFileSync(command, 'utf8'), beforeFailure, 'Failed upgrade must retain the previous working command.');
  assert.equal(run(command, ['version']).stdout.trim(), require('../package.json').version);
  assert.ok(!fs.existsSync(path.join(data, '.installer-lock')));
  const other = path.join(root, 'foreign-bin'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'beat'), '#!/bin/sh\necho another program\n', { mode: 0o755 });
  run('/bin/sh', [installer, '--no-setup'], { BEAT_BIN_DIR: other }, 1);
  assert.ok(fs.readFileSync(path.join(other, 'beat'), 'utf8').includes('another program'));
  console.log(JSON.stringify({ ok: true, platform: process.platform, quote_and_space_paths: true, outside_project_cwd: true, repeated_install: true, credentials_preserved: true, failed_upgrade_preserved: true, foreign_command_preserved: true, private_node_bootstrap: env.BEAT_INSTALL_FORCE_NODE === '1' }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
