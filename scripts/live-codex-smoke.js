'use strict';

// Explicit opt-in: uses the existing BeAT login and makes real model requests.
// Run with BEAT_LIVE_TEST=1; never accepts or prints a password/token.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const core = require('../core');
const platform = require('../platform');
const { BeatRuntime } = require('../server');
const { launchCodex } = require('../codex');

async function main() {
  if (process.env.BEAT_LIVE_TEST !== '1') throw new Error('Set BEAT_LIVE_TEST=1 to explicitly enable real BeAT model requests.');
  if (!core.loadBeatSession({ optional: true })) throw new Error('Run beat login before the live test.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-live-codex-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  execFileSync('git', ['init', '--quiet'], { cwd: project });
  const a = crypto.randomInt(100, 999), b = crypto.randomInt(100, 999);
  fs.writeFileSync(path.join(project, 'input.json'), JSON.stringify({ a, b }));
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Only work inside this fixture. Do not use agents, network, plugins, or package installs. Read input.json, compute its sum using Node.js, write answer.txt with the decimal sum and a newline using apply_patch, then verify the file using Node.js. Also test asynchronous execution: use exec_command with yield_time_ms=100 to run node -e "setTimeout(() => console.log(\\\"WAIT_READY\\\"), 3500)", then use write_stdin with its returned session_id until WAIT_READY appears. Do not finish before both file and async output are verified.\n');
  if (process.env.BEAT_TEST_IMAGE) {
    if (!process.env.BEAT_TEST_IMAGE_TEXT) throw new Error('BEAT_TEST_IMAGE_TEXT is required with BEAT_TEST_IMAGE.');
    fs.copyFileSync(process.env.BEAT_TEST_IMAGE, path.join(project, 'visual.png'));
    fs.appendFileSync(path.join(project, 'AGENTS.md'), 'Also call view_image on visual.png, visually read the short marker, and write that marker only plus a newline to image.txt using apply_patch. Do not decode pixels with code or use external OCR.\n');
  }
  const runtime = new BeatRuntime({ concurrency: 1 });
  let requests = 0, lastAnswer = '';
  const observed = [];
  const chat = runtime.chat.bind(runtime);
  runtime.chat = async options => {
    requests++;
    if (requests > 12) throw new Error('Live smoke exceeded 12 model requests.');
    const result = await chat(options);
    lastAnswer = result.answer_plain;
    // Record only tool names and final-vs-call shape, never prompts or credentials.
    const raw = result.answer_plain.replace(/^```(?:json)?\s*\n|\n```\s*$/g, '');
    try {
      const decoded = JSON.parse(raw);
      observed.push(...(decoded.calls || []).map(call => call.name));
    } catch { /* A plain final answer is allowed. */ }
    console.error(`Live BeAT turn ${requests}: ${result.elapsed_seconds.toFixed(1)}s`);
    return result;
  };
  try {
    const models = await runtime.models();
    const model = core.resolveModel(process.env.BEAT_TEST_MODEL || 'sol', models);
    const installed = await platform.ensureCodex({ onProgress: console.error });
    const result = await launchCodex({
      installed, model, models, effort: 'low', home: path.join(directory, 'codex'), cwd: project, runtime,
      forwarded: ['exec', '--sandbox', 'workspace-write', '--json',
        'Read AGENTS.md and carry out its fixture task, including the asynchronous exec_command/write_stdin check. Use the actual tools, not BeAT internal tools. Do not guess the numbers or simulate tools. Finish with BEAT_LIVE_CODEX_OK only after verification.'],
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
    });
    if (result.code !== 0) throw new Error(`Codex failed (${result.code}): ${result.stderr.slice(-2000)}`);
    assert.ok(fs.existsSync(path.join(project, 'answer.txt')), `No output file. Last BeAT fixture response: ${lastAnswer.slice(0, 1600)}`);
    assert.equal(fs.readFileSync(path.join(project, 'answer.txt'), 'utf8'), `${a + b}\n`);
    assert.ok(observed.some(name => name.endsWith('exec_command')), 'Expected a real shell tool request');
    assert.ok(observed.some(name => name.endsWith('apply_patch')), 'Expected a real patch tool request');
    assert.ok(observed.some(name => name.endsWith('write_stdin')), 'Expected a real async session polling request');
    if (process.env.BEAT_TEST_IMAGE) {
      assert.ok(observed.some(name => name.endsWith('view_image')), 'Expected a real image tool request');
      assert.equal(fs.readFileSync(path.join(project, 'image.txt'), 'utf8').trim(), process.env.BEAT_TEST_IMAGE_TEXT);
    }
    assert.ok(result.stdout.includes('BEAT_LIVE_CODEX_OK'), 'Expected verified completion');
    console.log(JSON.stringify({ ok: true, codex: installed.version, model: model.key, transport: 'directline', requests, tools: observed, actual_file_verified: true }, null, 2));
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
