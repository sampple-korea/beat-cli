'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../tool-bridge');

const functionTool = {
  type: 'function',
  name: 'exec_command',
  description: 'Run a command',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { cmd: { type: 'string', minLength: 1 } },
    required: ['cmd'],
  },
};

test('function tool calls are schema-validated and converted to Responses items', () => {
  const protocol = bridge.prepareTools([functionTool], 'auto', true);
  const decoded = bridge.decodeAnswer(JSON.stringify({
    beat_protocol: 'tool_v1', calls: [{ name: 'exec_command', arguments: { cmd: 'pwd' } }],
  }), protocol);
  assert.equal(decoded.toolCalls, true);
  assert.equal(decoded.output.length, 1);
  assert.equal(decoded.output[0].type, 'function_call');
  assert.equal(decoded.output[0].name, 'exec_command');
  assert.deepEqual(JSON.parse(decoded.output[0].arguments), { cmd: 'pwd' });
  assert.match(decoded.output[0].call_id, /^call_/);
});

test('invalid function arguments never become an executable tool call', () => {
  const protocol = bridge.prepareTools([functionTool], 'auto', true);
  assert.throws(() => bridge.decodeAnswer(JSON.stringify({
    beat_protocol: 'tool_v1', calls: [{ name: 'exec_command', arguments: { command: 'pwd' } }],
  }), protocol), (error) => error instanceof bridge.BridgeError && error.code === 'invalid_tool_output');
});

test('custom tool input preserves patch newlines exactly', () => {
  const protocol = bridge.prepareTools([{ type: 'custom', name: 'apply_patch', description: 'Apply patch', format: { type: 'text' } }]);
  const patch = '*** Begin Patch\n*** Add File: x.txt\n+hello\n*** End Patch';
  const decoded = bridge.decodeAnswer(JSON.stringify({ beat_protocol: 'tool_v1', calls: [{ name: 'apply_patch', input: patch }] }), protocol);
  assert.equal(decoded.output[0].type, 'custom_tool_call');
  assert.equal(decoded.output[0].input, patch);
});

test('namespace tools remain qualified in the text protocol and namespaced on output', () => {
  const protocol = bridge.prepareTools([{
    type: 'namespace', name: 'multi_agent_v1', tools: [{
      type: 'function', name: 'wait_agent', description: 'Wait',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    }],
  }]);
  const decoded = bridge.decodeAnswer(JSON.stringify({
    beat_protocol: 'tool_v1', calls: [{ name: 'multi_agent_v1.wait_agent', arguments: {} }],
  }), protocol);
  assert.equal(decoded.output[0].namespace, 'multi_agent_v1');
  assert.equal(decoded.output[0].name, 'wait_agent');
});

test('required tool choice rejects ordinary final text', () => {
  const protocol = bridge.prepareTools([functionTool], 'required');
  assert.throws(() => bridge.decodeAnswer('done', protocol), (error) => error.code === 'missing_tool_call');
});

test('tool results and reasoning history are preserved instead of silently dropped', () => {
  const normalized = bridge.normalizeInput([
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'checked repo' }] },
    { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'C:/repo' },
  ]);
  assert.equal(normalized.length, 3);
  assert.match(normalized[0].content, /checked repo/);
  assert.match(normalized[1].content, /이전 도구 호출/);
  assert.match(normalized[2].content, /call_1/);
  assert.match(normalized[2].content, /C:\/repo/);
});

test('unknown input item types fail loudly', () => {
  assert.throws(() => bridge.normalizeInput([{ type: 'future_magic_item' }]), (error) => error.code === 'unsupported_input_item');
});
