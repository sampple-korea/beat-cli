'use strict';
const test = require('node:test');
const assert = require('assert/strict');
const crypto = require('crypto');
const direct = require('../direct');

test('Flight parser respects UTF-8 lengths, embedded newlines and adjacent records', () => {
  const text = '한글\nline:with,"quotes"';
  const records = direct.flightRecords(`0:{"ok":true}\n1:T${Buffer.byteLength(text).toString(16)},${text}2:"next"\n`);
  assert.deepEqual(records.get('0'), { ok: true });
  assert.equal(records.get('1'), text);
  assert.equal(records.get('2'), 'next');
  assert.throws(() => direct.flightRecords('1:Tff,short'), /Truncated/);
});
test('Bootstrap resolves token references without evaluating web scripts', () => {
  const payload = {
    directLine: { conversationId: 'example-conversation', token: '$a', streamUrl: '$b' },
    user: { id: 'test-user', name: 'Test', accessToken: '$c' },
  };
  const flight = `1:${JSON.stringify(['$', 'div', null, payload])}\na:T3,JWTb:T19,wss://example.test/streamc:T4,USER`;
  const html = `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
  const parsed = direct.parseBootstrap(html);
  assert.equal(parsed.token, 'JWT');
  assert.equal(parsed.user.accessToken, 'USER');
  assert.equal(parsed.streamUrl, 'wss://example.test/stream');
});
test('HTTP client lifecycle does not launch Chromium', async () => {
  const client = new direct.HttpClient();
  const context = await client.newContext();
  assert.equal(typeof context.newPage, 'undefined');
  assert.deepEqual((await context.storageState()).cookies, []);
  await client.close();
  assert.equal(client.isConnected(), false);
  assert.equal(client.contexts.size, 0);
});
test('OnePass password wire format round trips CryptoJS-compatible AES', () => {
  const salt = Buffer.from('12345678'), password = 'example-only-한글';
  const encoded = Buffer.from(direct.encryptPassword(password, salt), 'base64');
  assert.equal(encoded.subarray(0, 8).toString(), 'Salted__');
  let material = Buffer.alloc(0), previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from('onepass987655432'), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  assert.equal(Buffer.concat([decipher.update(encoded.subarray(16)), decipher.final()]).toString(), password);
});
const bootstrap = { user: { accessToken: 'test', id: 'test', name: 'Test' } };
test('API mode requests disabled native assistant and preserves literal prompt', () => {
  const prompt = '{"content":"line\\n한글"}';
  const activity = direct.startActivity(bootstrap, prompt, 'chat_test', 'high', false, true);
  assert.equal(activity.value.params.new_assistant_enabled, false);
  assert.equal(activity.value.user_input, prompt);
  assert.equal(activity.value.answer_model, 'chat_test');
  assert.equal(activity.value.reasoning_effort, 'high');
});
test('continuation authenticates first then sends a real message without resending init input', () => {
  const [start, message] = direct.continuationActivities(bootstrap, 'follow up', 'chat_test', 'low', false);
  assert.equal(start.type, 'event');
  assert.equal(start.value.user_input, undefined);
  assert.equal(message.type, 'message');
  assert.equal(message.name, undefined);
  assert.equal(message.value.token, undefined);
  assert.equal(message.text, 'follow up');
  assert.equal(message.channelData.answer_model, 'chat_test');
});
test('poll wait aborts immediately and does not leave a timer', async () => {
  const controller = new AbortController();
  const pending = direct.pause(60000, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});
