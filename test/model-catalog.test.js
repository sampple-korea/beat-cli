'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelCatalog } = require('../model-catalog');

test('model catalog accepts the authoritative outer chat_* key regardless of inner key/order', () => {
  const payload = {
    catalog: {
      chat_alpha: {
        title: 'Alpha',
        reasoning_effort_default: 'high',
        unrelated: true,
        reasoning_efforts: ['low', 'high', 'high'],
        key: 'backend-alpha',
      },
    },
  };
  assert.deepEqual(parseModelCatalog(JSON.stringify(payload)), [{
    key: 'chat_alpha', title: 'Alpha', efforts: ['low', 'high'], default_effort: 'high',
  }]);
});

test('model catalog decodes escaped Next.js-style JSON fragments', () => {
  const inner = JSON.stringify({
    models: {
      chat_beta: { key: 'chat_beta', title: 'Beta', reasoning_efforts: ['none', 'medium'], reasoning_effort_default: 'medium' },
    },
  });
  const script = `self.__next_f.push([1,${JSON.stringify(inner)}]);`;
  assert.deepEqual(parseModelCatalog(script), [{
    key: 'chat_beta', title: 'Beta', efforts: ['none', 'medium'], default_effort: 'medium',
  }]);
});

test('model catalog rejects lookalike keys and malformed records', () => {
  const payload = JSON.stringify({
    not_chat: { key: 'not_chat', title: 'Nope', reasoning_efforts: ['high'] },
    chat_missing_title: { key: 'chat_missing_title', reasoning_efforts: ['high'] },
  });
  assert.deepEqual(parseModelCatalog(payload), []);
});
