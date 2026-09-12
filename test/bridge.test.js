'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../tool-bridge');
const tools = [
  { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
];
const protocol = bridge.prepareTools(tools);
const envelope = (calls) => JSON.stringify({ beat_protocol: 'tool_v1', calls });

test('function calls preserve names, call IDs and JSON arguments', () => {
  const value = bridge.decodeAnswer(envelope([{ name: 'read_file', arguments: { path: 'a file.txt' } }]), protocol);
  assert.equal(value.toolCalls, true);
  assert.equal(value.output[0].type, 'function_call');
  assert.equal(value.output[0].name, 'read_file');
  assert.ok(value.output[0].call_id.startsWith('call_'));
  assert.deepEqual(JSON.parse(value.output[0].arguments), { path: 'a file.txt' });
  assert.equal(value.text, '');
});
test('custom tools preserve raw patch newlines and Unicode', () => {
  const input = '*** Begin Patch\n*** Add File: 한글.txt\n+hello\n*** End Patch';
  const value = bridge.decodeAnswer(envelope([{ name: 'apply_patch', input }]), protocol);
  assert.equal(value.output[0].type, 'custom_tool_call');
  assert.equal(value.output[0].input, input);
});
test('namespace function calls round-trip namespace separately from the name', () => {
  const namespaced = bridge.prepareTools([{ type: 'namespace', name: 'functions', tools: [tools[0]] }]);
  const output = bridge.decodeAnswer(envelope([{ name: 'functions.read_file', arguments: { path: 'x' } }]), namespaced).output[0];
  assert.equal(output.namespace, 'functions');
  assert.equal(output.name, 'read_file');
});
test('tool calls cannot invoke an unadvertised tool', () => {
  assert.throws(() => bridge.decodeAnswer(envelope([{ name: 'not_registered', arguments: {} }]), protocol), { code: 'invalid_tool_output' });
});
test('tool argument JSON schema is enforced', () => {
  for (const args of [{}, { path: 2 }, { path: 'x', unexpected: true }, null]) assert.throws(() => bridge.decodeAnswer(envelope([{ name: 'read_file', arguments: args }]), protocol), { code: 'invalid_tool_output' });
});
test('malformed tool JSON fails without executing a partial call', () => {
  assert.throws(() => bridge.decodeAnswer('{"beat_protocol":"tool_v1","calls":[', protocol), { code: 'invalid_tool_output' });
});
test('ordinary JSON containing a calls property remains text without the protocol marker', () => {
  const text = '{"calls":[{"name":"read_file"}]}';
  const result = bridge.decodeAnswer(text, protocol);
  assert.equal(result.toolCalls, false);
  assert.equal(result.text, text);
});
test('fenced JSON envelope can be parsed without Markdown escaping the arguments', () => {
  const text = `\`\`\`json\n${envelope([{ name: 'read_file', arguments: { path: 'c:\\a\\b.txt' } }])}\n\`\`\``;
  assert.equal(JSON.parse(bridge.decodeAnswer(text, protocol).output[0].arguments).path, 'c:\\a\\b.txt');
});
test('required tool choice and named tool choice are enforced', () => {
  assert.throws(() => bridge.decodeAnswer('no tool', bridge.prepareTools(tools, 'required')), { code: 'missing_tool_call' });
  const named = bridge.prepareTools(tools, { type: 'function', name: 'read_file' });
  assert.throws(() => bridge.decodeAnswer(envelope([{ name: 'apply_patch', input: 'x' }]), named));
});
test('none and nonparallel tool choices are enforced', () => {
  const call = { name: 'read_file', arguments: { path: 'x' } };
  assert.throws(() => bridge.decodeAnswer(envelope([call]), bridge.prepareTools(tools, 'none')));
  assert.throws(() => bridge.decodeAnswer(envelope([call, call]), bridge.prepareTools(tools, 'auto', false)));
});
test('hosted tools and duplicate names fail explicitly', () => {
  assert.throws(() => bridge.prepareTools([{ type: 'web_search_preview' }]), { code: 'unsupported_tool' });
  assert.throws(() => bridge.prepareTools([tools[0], tools[0]]));
});
test('malformed JSON schemas fail before calling the model', () => {
  assert.throws(() => bridge.prepareTools([{ type: 'function', name: 'bad', parameters: { type: 'not-a-json-schema-type' } }]));
});
test('JSON Schema 2020-12 works', () => {
  const modern = bridge.prepareTools([{ type: 'function', name: 'modern', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }]);
  assert.equal(bridge.decodeAnswer(envelope([{ name: 'modern', arguments: { value: 'ok' } }]), modern).output[0].name, 'modern');
});
test('final envelopes produce assistant messages, not tool calls', () => {
  const result = bridge.decodeAnswer(JSON.stringify({ beat_protocol: 'tool_v1', final: '완료\n확인' }), protocol);
  assert.equal(result.output[0].type, 'message');
  assert.equal(result.text, '완료\n확인');
});
test('Responses function calls and outputs survive conversation normalization', () => {
  const input = [
    { type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"x"}' },
    { type: 'function_call_output', call_id: 'call_abc', output: 'actual result' },
    { type: 'custom_tool_call', call_id: 'call_def', name: 'apply_patch', input: 'patch text' },
    { type: 'custom_tool_call_output', call_id: 'call_def', output: 'patch complete' },
  ];
  const messages = bridge.normalizeInput(input);
  assert.equal(messages.length, 4);
  assert.match(messages[1].content, /call_abc/);
  assert.match(messages[1].content, /actual result/);
  assert.match(messages[3].content, /patch complete/);
});
test('Chat Completions tool results preserve the original call ID', () => {
  const messages = bridge.normalizeInput([{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'real result' }]);
  assert.ok(messages.some((item) => item.content.includes('call_1')));
  assert.equal(messages.at(-1).role, 'tool');
  assert.match(messages.at(-1).content, /real result/);
});
test('unsupported input is rejected instead of silently discarded', () => {
  for (const input of [null, {}, [null], [{ type: 'future_unsupported_item' }], [{ role: 'unexpected', content: 'x' }]]) assert.throws(() => bridge.normalizeInput(input));
});
test('opaque reasoning content is not reinterpreted as a user instruction', () => {
  assert.deepEqual(bridge.normalizeInput([{ type: 'reasoning', encrypted_content: 'opaque' }]), []);
});
test('view_image tool result arrays keep image data as multimodal content', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,example' };
  const normalized = bridge.normalizeInput([{ type: 'function_call_output', call_id: 'call_image', output: [
    { type: 'input_text', text: 'Image opened.' }, image,
  ] }]);
  assert.equal(normalized[0].role, 'tool');
  assert.match(normalized[0].content[0].text, /call_image/);
  assert.deepEqual(normalized[0].content[2], image);
  const chat = bridge.normalizeInput([{ role: 'tool', tool_call_id: 'call_image', content: [image] }]);
  assert.deepEqual(chat[0].content[1], image);
});
test('SSE tool output is typed and never streams the control envelope as output_text', () => {
  const output = bridge.decodeAnswer(envelope([{ name: 'read_file', arguments: { path: 'x' } }, { name: 'apply_patch', input: 'patch' }]), protocol).output;
  const events = [];
  bridge.emitOutput(output, (event) => events.push(event));
  assert.ok(events.some((event) => event.type === 'response.function_call_arguments.delta'));
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.delta'));
  assert.ok(!events.some((event) => event.type === 'response.output_text.delta'));
  assert.equal(events.filter((event) => event.type === 'response.output_item.done').length, 2);
});
test('SSE text output has a complete add/delta/done lifecycle', () => {
  const events = [];
  bridge.emitOutput(bridge.messageOutput('hello'), (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ['response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done']);
});
