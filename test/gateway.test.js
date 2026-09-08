'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-http-'));
process.env.XDG_CONFIG_HOME = temporary;
const { createGateway, Semaphore, BeatRuntime } = require('../server');
const store = require('../api-store');
const OpenAI = require('openai');
const requests = [];
let answer = 'hello from BeAT', behavior;
const runtime = {
  async models() { return [{ key: 'chat_test', title: 'Test', efforts: ['high'], default_effort: 'high' }]; },
  async chat(request) {
    requests.push(request);
    if (behavior) return behavior(request);
    return { answer, answer_plain: answer, answer_markdown: answer, model: request.model, reasoning_effort: request.effort, conversation_id: crypto.randomUUID(), elapsed_seconds: 0 };
  },
  async close() {},
};
let gateway, base, client;
const key = 'unit-test-local-key';
const tools = [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
async function post(endpoint, body, headers = {}) {
  return fetch(`${base}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function sse(text) { return text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6))); }

test.before(async () => {
  gateway = createGateway({ config: { host: '127.0.0.1', port: 0, api_key: key, concurrency: 2, max_input_chars: 30000, max_upload_mb: 1 }, runtime });
  const address = await gateway.start(); base = `http://127.0.0.1:${address.port}`;
  client = new OpenAI({ apiKey: key, baseURL: `${base}/v1`, maxRetries: 0 });
});
test.beforeEach(() => { answer = 'hello from BeAT'; behavior = null; requests.length = 0; });
test.after(async () => { await gateway.close(); fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('health is available before launching a browser and identifies this service', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'beat-openai-gateway');
});
test('authenticated endpoints reject missing and non-Bearer credentials', async () => {
  for (const authorization of [undefined, key, `Basic ${key}`, 'Bearer wrong-key']) {
    const response = await fetch(`${base}/v1/models`, { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
  }
});
test('models endpoint is based on runtime catalog, not a static OpenAI list', async () => {
  const response = await client.models.list();
  assert.deepEqual(response.data.map((model) => model.id), ['chat_test']);
});
test('malformed and non-object JSON fail as client errors', async () => {
  for (const body of ['{broken', 'null', '[]', '"text"']) assert.equal((await post('/v1/responses', body)).status, 400);
});
test('compressed JSON requests are accepted with a decompressed size limit', async () => {
  const data = zlib.gzipSync(Buffer.from(JSON.stringify({ model: 'chat_test', input: 'gzip message', store: false })));
  const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: data });
  assert.equal(response.status, 200);
  assert.match(requests[0].prompt, /gzip message/);
});
test('Responses API works through the official SDK without OpenAI authentication', async () => {
  const response = await client.responses.create({ model: 'chat_test', input: 'SDK request', reasoning: { effort: 'high' }, store: false });
  assert.equal(response.output_text, 'hello from BeAT');
  assert.equal(response.output[0].type, 'message');
  assert.equal(requests[0].effort, 'high');
  assert.equal(response.x_beat.usage_estimated, true);
});
test('store=false does not create a local response record', async () => {
  const response = await client.responses.create({ model: 'chat_test', input: 'private ephemeral input', store: false });
  assert.ok(!Object.hasOwn(store.loadState().responses, response.id));
  const retrieval = await fetch(`${base}/v1/responses/${response.id}`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(retrieval.status, 404);
});
test('stored responses, listing and previous_response_id preserve history', async () => {
  const first = await client.responses.create({ model: 'chat_test', input: 'ORIGINAL_USER_MESSAGE' });
  const second = await client.responses.create({ model: 'chat_test', input: 'FOLLOW_UP', previous_response_id: first.id });
  assert.ok(second.id);
  assert.match(requests[1].prompt, /ORIGINAL_USER_MESSAGE/);
  assert.match(requests[1].prompt, /FOLLOW_UP/);
  assert.match(requests[1].prompt, /hello from BeAT/);
  const response = await fetch(`${base}/v1/responses`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.ok(listing.data.some((item) => item.id === first.id));
  assert.ok(!Object.hasOwn(listing.data[0], '_history'));
});
test('function-call outputs remain in the next request prompt', async () => {
  await client.responses.create({ model: 'chat_test', input: [{ type: 'function_call', call_id: 'call_actual', name: 'read_file', arguments: '{"path":"README.md"}' }, { type: 'function_call_output', call_id: 'call_actual', output: 'ACTUAL_FILE_CONTENT' }], store: false });
  assert.match(requests[0].prompt, /ACTUAL_FILE_CONTENT/);
  assert.match(requests[0].prompt, /call_actual/);
});
test('streamed function calls carry typed events with sequential sequence numbers', async () => {
  answer = JSON.stringify({ beat_protocol: 'tool_v1', calls: [{ name: 'read_file', arguments: { path: 'README.md' } }] });
  const response = await post('/v1/responses', { model: 'chat_test', input: 'read it', tools, stream: true, store: false });
  const events = sse(await response.text());
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.ok(events.some((event) => event.type === 'response.function_call_arguments.delta'));
  assert.ok(!events.some((event) => event.type === 'response.output_text.delta'));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[0].type, 'function_call');
});
test('streamed custom calls preserve raw input for apply_patch', async () => {
  answer = JSON.stringify({ beat_protocol: 'tool_v1', calls: [{ name: 'apply_patch', input: 'line one\nline two' }] });
  const response = await post('/v1/responses', { model: 'chat_test', input: 'patch', tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }], stream: true, store: false });
  const events = sse(await response.text());
  assert.equal(events.find((event) => event.type === 'response.custom_tool_call_input.delta').delta, 'line one\nline two');
  assert.equal(events.at(-1).response.output[0].type, 'custom_tool_call');
});
test('upstream failures are inside response.failed.response.error and close the stream', async () => {
  behavior = async () => { throw new Error('simulated backend failure'); };
  const response = await post('/v1/responses', { model: 'chat_test', input: 'test', stream: true, store: false });
  const events = sse(await response.text());
  assert.equal(events.at(-1).type, 'response.failed');
  assert.match(events.at(-1).response.error.message, /simulated backend failure/);
  assert.equal(events.at(-1).sequence_number, 1);
});
test('bad tool JSON does not produce a partially executable output item', async () => {
  answer = '{"beat_protocol":"tool_v1","calls":[';
  const response = await post('/v1/responses', { model: 'chat_test', input: 'read', tools, stream: true, store: false });
  const events = sse(await response.text());
  assert.ok(!events.some((event) => event.type === 'response.output_item.added'));
  assert.equal(events.at(-1).response.error.code, 'invalid_tool_output');
});
test('oversized prompt returns 413 instead of silently cutting off newest input', async () => {
  const response = await post('/v1/responses', { model: 'chat_test', input: 'x'.repeat(30001), store: false });
  assert.equal(response.status, 413);
  assert.equal(requests.length, 0);
});
test('unsupported built-in tools and unsupported input types are rejected explicitly', async () => {
  for (const extra of [{ tools: [{ type: 'web_search_preview' }] }, { input: [{ type: 'unrecognized_item' }] }]) {
    const response = await post('/v1/responses', { model: 'chat_test', input: 'test', ...extra, store: false });
    assert.equal(response.status, 400);
  }
  assert.equal(requests.length, 0);
});
test('Chat Completions text and function-call formats work through SDK', async () => {
  const first = await client.chat.completions.create({ model: 'chat_test', messages: [{ role: 'user', content: 'hello' }], store: false });
  assert.equal(first.choices[0].message.content, answer);
  answer = JSON.stringify({ beat_protocol: 'tool_v1', calls: [{ name: 'read_file', arguments: { path: 'x' } }] });
  const second = await client.chat.completions.create({ model: 'chat_test', messages: [{ role: 'user', content: 'read' }], tools: [{ type: 'function', function: tools[0] }], store: false });
  assert.equal(second.choices[0].finish_reason, 'tool_calls');
  assert.equal(second.choices[0].message.tool_calls[0].function.name, 'read_file');
});
test('Chat Completion streaming error closes instead of leaking a keep-alive timer', async () => {
  behavior = async () => { throw new Error('chat failed'); };
  const response = await post('/v1/chat/completions', { model: 'chat_test', messages: [{ role: 'user', content: 'test' }], stream: true, store: false });
  const text = await response.text();
  assert.match(text, /chat failed/);
  assert.match(text, /\[DONE\]/);
});
test('legacy completion stream uses text_completion, not chat.completion.chunk', async () => {
  const response = await post('/v1/completions', { model: 'chat_test', prompt: 'test', stream: true, store: false });
  const events = sse(await response.text());
  assert.equal(events[0].object, 'text_completion');
  assert.equal(events[0].choices[0].text, 'hello from BeAT');
});
test('multipart text upload, input_file, download and delete work end-to-end', async () => {
  const form = new FormData(); form.set('purpose', 'user_data'); form.set('file', new Blob(['UPLOADED_TEXT_CONTENT'], { type: 'text/plain' }), 'notes.txt');
  const uploaded = await fetch(`${base}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  assert.equal(uploaded.status, 200);
  const file = await uploaded.json();
  assert.equal(file.filename, 'notes.txt');
  const generated = await post('/v1/responses', { model: 'chat_test', input: [{ role: 'user', content: [{ type: 'input_file', file_id: file.id }, { type: 'input_text', text: 'read it' }] }], store: false });
  assert.equal(generated.status, 200, await generated.text());
  assert.match(requests.at(-1).prompt, /UPLOADED_TEXT_CONTENT/);
  const downloaded = await fetch(`${base}/v1/files/${file.id}/content`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(await downloaded.text(), 'UPLOADED_TEXT_CONTENT');
  const deleted = await fetch(`${base}/v1/files/${file.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await deleted.json()).deleted, true);
  assert.deepEqual(fs.readdirSync(store.TEMP_DIR), []);
});
test('oversized multipart uploads do not commit records or leave temporary files', async () => {
  const before = Object.keys(store.loadState().files).length;
  const form = new FormData(); form.set('file', new Blob([Buffer.alloc(1024 * 1024 + 100)]), 'large.bin');
  const response = await fetch(`${base}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  assert.equal(response.status, 413);
  assert.equal(Object.keys(store.loadState().files).length, before);
  assert.deepEqual(fs.readdirSync(store.TEMP_DIR), []);
});
test('uploading two files fails atomically and cleans all temporary paths', async () => {
  const before = Object.keys(store.loadState().files).length;
  const form = new FormData(); form.append('file', new Blob(['one']), 'one.txt'); form.append('file', new Blob(['two']), 'two.txt');
  const response = await fetch(`${base}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  assert.equal(response.status, 400);
  assert.equal(Object.keys(store.loadState().files).length, before);
  assert.deepEqual(fs.readdirSync(store.TEMP_DIR), []);
});
test('conversations preserve input items and generated output', async () => {
  const created = await post('/v1/conversations', { items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CONVERSATION_INITIAL' }] }] });
  const conversation = await created.json();
  const response = await post('/v1/responses', { model: 'chat_test', input: 'CONVERSATION_NEXT', conversation: conversation.id, store: false });
  assert.equal(response.status, 200);
  assert.match(requests[0].prompt, /CONVERSATION_INITIAL/);
  const items = await fetch(`${base}/v1/conversations/${conversation.id}/items`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await items.json()).data.length, 3);
});
test('client disconnection aborts in-flight backend work', async () => {
  let aborted = false;
  behavior = (request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => { aborted = true; reject(request.signal.reason); }, { once: true });
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/responses`, { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'chat_test', input: 'wait', stream: true, store: false }) });
  assert.equal(response.status, 200);
  controller.abort();
  for (let i = 0; i < 100 && !aborted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(aborted);
});
test('semaphore transfers slots fairly without a release/acquire race', async () => {
  const semaphore = new Semaphore(1);
  const releaseA = await semaphore.acquire();
  const waitingB = semaphore.acquire();
  releaseA();
  let cEntered = false;
  const waitingC = semaphore.acquire().then((release) => { cEntered = true; return release; });
  const releaseB = await waitingB;
  await Promise.resolve();
  assert.equal(semaphore.active, 1);
  assert.equal(cEntered, false);
  releaseB(); const releaseC = await waitingC;
  assert.equal(semaphore.active, 1);
  releaseC(); releaseC();
  assert.equal(semaphore.active, 0);
});
test('aborted queued requests are removed without consuming a slot', async () => {
  const semaphore = new Semaphore(1), controller = new AbortController();
  const release = await semaphore.acquire();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(semaphore.waiters.length, 0);
  release(); assert.equal(semaphore.active, 0);
});
test('concurrent runtime browser creation is shared and cleaned up', async () => {
  const core = require('../core');
  const original = core.launchBrowser;
  let launches = 0, closed = false;
  const browser = { isConnected: () => true, on() {}, async close() { closed = true; } };
  core.launchBrowser = async () => { launches += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return browser; };
  try {
    const real = new BeatRuntime({ concurrency: 2 });
    assert.deepEqual(await Promise.all([real.ensureBrowser(), real.ensureBrowser()]), [browser, browser]);
    assert.equal(launches, 1); await real.close(); assert.ok(closed);
  } finally { core.launchBrowser = original; }
});
