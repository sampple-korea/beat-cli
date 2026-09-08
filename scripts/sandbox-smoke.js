'use strict';

// Verify the native Codex sandbox independently of model transport. A failed
// sandbox is a failed test, never a reason to run a tool without isolation.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', '.test-data');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.BEAT_DATA_HOME = path.join(root, 'runtime');
const platform = require('../platform');

async function main() {
  if (process.platform !== 'linux') { console.log('Native Linux sandbox probe: not applicable.'); return; }
  const installed = await platform.ensureCodex({ onProgress: console.error });
  const temporary = fs.mkdtempSync(path.resolve(__dirname, '..', '..', '.beat-sandbox-'));
  const cwd = path.join(temporary, 'workspace with spaces');
  const home = path.join(temporary, 'private-config');
  const outside = path.join(temporary, 'outside.txt');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(outside, 'PRESERVE');
  const code = [
    'const fs=require("fs");',
    'console.log("sandbox cwd:",process.cwd());',
    'fs.writeFileSync("inside.txt","SANDBOX_OK");',
    'let denied=false;try{fs.writeFileSync(process.argv[1],"MUST_NOT_WRITE");}catch(e){denied=true;console.log("outside write denied:",e.code);}',
    'if(!denied)throw new Error("Sandbox allowed a write outside its workspace");',
    'console.log("SANDBOX_OK");',
  ].join('');
  try {
    const result = await platform.run(process.execPath, [installed.entry, 'sandbox', '--permission-profile', ':workspace', '-C', cwd, '--', process.execPath, '-e', code, outside], {
      cwd, env: { ...process.env, CODEX_HOME: home }, timeout: 45000,
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, 'inside.txt'), 'utf8'), 'SANDBOX_OK');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'PRESERVE');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
