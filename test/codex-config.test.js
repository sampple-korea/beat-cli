'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const codex = require('../codex');

const models = [{ key: 'chat_alpha', title: 'Alpha', efforts: ['low', 'high'], default_effort: 'low' }];

test('BeAT model catalog exposes only BeAT model slugs and their reasoning levels', () => {
  const catalog = codex.modelCatalog(models, 'chat_alpha');
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].slug, 'chat_alpha');
  assert.equal(catalog.models[0].default_reasoning_level, 'low');
  assert.deepEqual(catalog.models[0].supported_reasoning_levels.map((item) => item.effort), ['low', 'high']);
  assert.equal(catalog.models[0].shell_type, 'unified_exec');
  assert.equal(catalog.models[0].tool_mode, 'direct');
});

test('runtime arguments pin provider, catalog, model and reasoning before user arguments', () => {
  const args = codex.runtimeArguments({
    model: models[0], effort: 'high', catalogPath: path.join(os.tmpdir(), 'beat catalog.json'),
    baseURL: 'http://127.0.0.1:12345/v1', forwarded: ['exec', '--skip-git-repo-check', 'hello'],
  });
  const text = args.join('\n');
  assert.match(text, /model_provider="beat"/);
  assert.match(text, /model="chat_alpha"/);
  assert.match(text, /model_reasoning_effort="high"/);
  assert.match(text, /model_catalog_json=/);
  assert.deepEqual(args.slice(-3), ['exec', '--skip-git-repo-check', 'hello']);
});

test('forwarded Codex flags cannot escape the BeAT provider/model/search boundary', () => {
  for (const args of [
    ['-c', 'model="other"'],
    ['--config=model_provider="openai"'],
    ['-cmodel_reasoning_effort="low"'],
    ['-c', 'model_providers.evil={name="x"}'],
    ['--oss'],
    ['--search'],
    ['--remote', 'ws://127.0.0.1:9999'],
    ['--remote-auth-token-env=TOKEN'],
    ['login'],
    ['--no-alt-screen', 'login'],
    ['cloud'],
    ['app'],
  ]) assert.throws(() => codex.validateForwarded(args));
  assert.doesNotThrow(() => codex.validateForwarded(['exec', 'login']));
  assert.doesNotThrow(() => codex.validateForwarded(['exec', '--sandbox', 'read-only', '--', '--search is literal prompt text']));
});

test('child environment is isolated from ordinary Codex/OpenAI credentials', () => {
  const home = path.join(os.tmpdir(), 'beat-codex-home-test');
  const env = codex.childEnvironment(home, 'beat_test_key', {
    PATH: process.env.PATH,
    CODEX_HOME: path.join(os.tmpdir(), 'ordinary-codex'),
    OPENAI_API_KEY: 'do-not-forward', OPENAI_BASE_URL: 'https://example.invalid',
    OPENAI_ORG_ID: 'org-test', OPENAI_PROJECT_ID: 'proj-test', OTHER: 'kept', NO_PROXY: 'example.com',
  });
  assert.equal(env.CODEX_HOME, home);
  assert.equal(env.BEAT_CODEX_API_KEY, 'beat_test_key');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.OPENAI_ORG_ID, undefined);
  assert.equal(env.OPENAI_PROJECT_ID, undefined);
  assert.equal(env.OTHER, 'kept');
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
});

test('beat codex argument parser distinguishes wrapper actions from forwarded Codex arguments', () => {
  assert.deepEqual(codex.parseArguments(['config', '--model', 'sol', '--reasoning', 'high', '--no-prompt']), {
    action: 'config', options: { model: 'sol', effort: 'high', noPrompt: true }, forwarded: [],
  });
  assert.deepEqual(codex.parseArguments(['exec', '--json', '--', '--literal']), {
    action: 'run', options: {}, forwarded: ['exec', '--json', '--', '--literal'],
  });
});
