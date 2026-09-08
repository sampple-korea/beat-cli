'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const linux = require('../linux-setup');

test('os-release parser handles quoted ID_LIKE without executing shell syntax', () => {
  const release = linux.parseOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9"\nIGNORED=$(touch nope)\n');
  assert.equal(release.ID, 'rocky');
  assert.equal(release.ID_LIKE, 'rhel centos fedora');
  assert.equal(release.PRETTY_NAME, 'Rocky Linux 9');
});

test('Linux browser setup selects native package managers for common distro families', () => {
  assert.deepEqual(linux.browserInstallPlan({ ID: 'alpine' }), {
    kind: 'native', command: 'apk', args: ['add', 'chromium', 'nss', 'freetype', 'harfbuzz', 'ca-certificates', 'ttf-freefont'],
  });
  assert.equal(linux.browserInstallPlan({ ID: 'arch' }).command, 'pacman');
  assert.equal(linux.browserInstallPlan({ ID: 'rocky', ID_LIKE: 'rhel centos fedora' }).command, 'dnf');
  assert.equal(linux.browserInstallPlan({ ID: 'opensuse-tumbleweed', ID_LIKE: 'suse opensuse' }).command, 'zypper');
});

test('Debian-family systems use Playwright dependency installation and unknown distros stay explicit', () => {
  assert.deepEqual(linux.browserInstallPlan({ ID: 'ubuntu', ID_LIKE: 'debian' }), { kind: 'playwright' });
  assert.deepEqual(linux.browserInstallPlan({ ID: 'nixos', PRETTY_NAME: 'NixOS' }), { kind: 'unknown', distribution: 'NixOS' });
});
