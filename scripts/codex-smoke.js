'use strict';

// Real Codex binary + real HTTP/SSE + deterministic fake BeAT backend.
// macOS/Linux: execute apply_patch and verify the resulting file.
// Windows: execute get_goal under read-only permissions. Native Windows
// workspace-write additionally depends on the user's Windows sandbox setup.
// No school/OpenAI account is used and no remote model request is made.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const testRoot = path.resolve(__dirname, '..', '.test-data');
fs.mkdirSync(testRoot, { recursive: true, mode: 0o700 });
const windows = process.platform === 'win32';
// Exercise a standalone workspace, not a gitignored subtree of this tool's own
// checkout. Keep the test project separate from the installation under test.
const temporary = fs.mkdtempSync(path.join(windows ? os.tmpdir() : path.resolve(__dirname, '..', '..'), '.beat-codex-smoke-'));
process.env.XDG_CONFIG_HOME = path.join(temporary, 'config');
process.env.BEAT_DATA_HOME = process.env.BEAT_TEST_RUNTIME_HOME || path.join(testRoot, 'runtime');
const platform = require('../platform');
const { launchCodex } = require('../codex');

async function main() {
  const installed = await platform.ensureCodex({ onProgress: console.error });
  const cwd = path.join(temporary, 'project with spaces');
  const original = path.join(temporary, 'ordinary-codex');
  const home = path.join(temporary, 'BeAT Codex');
  fs.mkdirSync(cwd, { recursive: true });
  // Codex's Linux workspace-write sandbox protects a workspace .git path.
  // A real minimal repository avoids the non-git cwd bwrap edge case while
  // still exercising the normal workspace-write + apply_patch path.
  if (!windows) execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  fs.mkdirSync(original, { recursive: true });
  const sentinel = 'DO NOT CHANGE ORDINARY CODEX\n';
  fs.writeFileSync(path.join(original, 'config.toml'), sentinel);
  fs.writeFileSync(path.join(original, 'auth.json'), JSON.stringify({ fake_test_sentinel: true }));
  const beforeAuth = fs.readFileSync(path.join(original, 'auth.json'), 'utf8');
  const model = { key: 'chat_beat_test', title: 'BeAT deterministic integration test', efforts: ['low', 'high'], default_effort: 'low' };
  let calls = 0, observedTools = [], closed = false;
  const runtime = {
    async models() { return [model]; },
    async chat(request) {
      calls += 1;
      assert.equal(request.model, model.key);
      assert.equal(request.effort, 'high', 'Reasoning effort must survive the real Codex request.');
      assert.ok(calls <= 4, 'Unexpected tool loop');
      let answer;
      if (calls === 1) {
        const raw = request.prompt.match(/Tool definitions:\n([^\n]+)/)?.[1];
        assert.ok(raw, 'The gateway must describe actual Codex tools.');
        const tools = JSON.parse(raw);
        observedTools = tools.map((tool) => `${tool.type}:${tool.name}`);
        const toolName = windows ? 'get_goal' : 'apply_patch';
        const tool = tools.find((entry) => entry.name.split('.').at(-1) === toolName);
        assert.ok(tool, `Codex did not advertise ${toolName}. Tools: ${observedTools.join(', ')}`);
        const input = '*** Begin Patch\n*** Add File: beat-codex-proof.txt\n+BEAT_CODEX_SMOKE_OK\n*** End Patch';
        const call = windows
          ? { name: tool.name, arguments: {} }
          : tool.type === 'custom' ? { name: tool.name, input } : { name: tool.name, arguments: { input } };
        answer = JSON.stringify({ beat_protocol: 'tool_v1', calls: [call] });
      } else {
        assert.ok(request.prompt.includes('도구 실행 결과'), 'Tool results must not be dropped on the next request.');
        if (windows) assert.ok(request.prompt.includes('[도구 실행 결과: '), 'Real Codex must execute get_goal and return its correlated result.');
        else {
          if (!fs.existsSync(path.join(cwd, 'beat-codex-proof.txt'))) process.stderr.write(`Codex tool result: ${request.prompt.slice(request.prompt.lastIndexOf('[도구 실행 결과: '), -1).slice(0, 8000)}\n`);
          assert.equal(fs.readFileSync(path.join(cwd, 'beat-codex-proof.txt'), 'utf8').trim(), 'BEAT_CODEX_SMOKE_OK');
        }
        answer = JSON.stringify({ beat_protocol: 'tool_v1', final: 'BEAT_CODEX_SMOKE_OK' });
      }
      return { answer, answer_plain: answer, answer_markdown: answer, model: model.key, reasoning_effort: request.effort, conversation_id: crypto.randomUUID(), elapsed_seconds: 0 };
    },
    async close() { closed = true; },
  };
  const result = await launchCodex({
    installed, model, effort: 'high', models: [model], home, cwd, runtime,
    env: { ...process.env, CODEX_HOME: original, OPENAI_API_KEY: 'invalid-test-sentinel', OPENAI_BASE_URL: 'http://127.0.0.1:1/not-openai' },
    forwarded: ['exec', '--skip-git-repo-check', '--sandbox', windows ? 'read-only' : 'workspace-write', '--json', windows ? 'Read the current session goal using get_goal, then report BEAT_CODEX_SMOKE_OK.' : 'Create beat-codex-proof.txt using apply_patch with the exact content BEAT_CODEX_SMOKE_OK, then report success.'],
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000,
  });
  if (result.code !== 0 || calls !== 2) process.stderr.write(`Codex stdout:\n${result.stdout}\nCodex stderr:\n${result.stderr}\n`);
  assert.equal(result.code, 0, 'Real Codex process must exit successfully.');
  assert.equal(calls, 2, 'Must perform a tool request, actual client action, and result-driven second turn.');
  if (!windows) assert.equal(fs.readFileSync(path.join(cwd, 'beat-codex-proof.txt'), 'utf8').trim(), 'BEAT_CODEX_SMOKE_OK');
  assert.equal(fs.readFileSync(path.join(original, 'config.toml'), 'utf8'), sentinel);
  assert.equal(fs.readFileSync(path.join(original, 'auth.json'), 'utf8'), beforeAuth);
  assert.ok(!fs.existsSync(path.join(home, 'auth.json')), 'BeAT must not create an OpenAI login file.');
  assert.ok(closed, 'Gateway runtime must close after Codex exits.');
  assert.ok(result.stdout.includes('BEAT_CODEX_SMOKE_OK'));
  console.log(JSON.stringify({ ok: true, codex_version: installed.version, platform: `${process.platform}/${process.arch}`, model: model.key, reasoning: 'high', requests: calls, real_patch_verified: !windows, real_read_tool_verified: windows, ordinary_codex_unchanged: true, openai_login_required: false, tools: observedTools }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
