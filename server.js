#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const Busboy = require('busboy');
const core = require('./core');
const store = require('./api-store');
const bridge = require('./tool-bridge');
const VERSION = require('./package.json').version;
const JSON_BODY_LIMIT = 25 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = options.type || (status >= 500 ? 'server_error' : 'invalid_request_error');
    this.param = options.param ?? null;
    this.code = options.code || null;
  }
}
function apiError(status, message, options) { throw new ApiError(status, message, options); }
function now() { return Math.floor(Date.now() / 1000); }
function estimateTokens(value) { return Math.ceil(Buffer.byteLength(String(value || ''), 'utf8') / 4); }
function usageFor(input, output) {
  const inputTokens = estimateTokens(input), outputTokens = estimateTokens(output);
  return { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + outputTokens };
}
function publicError(error) {
  let status = error.status || 500;
  if (error instanceof core.BeatError) status = ['SESSION_EXPIRED', 'LOGIN_FAILED'].includes(error.code) ? 401 : error.code === 'ANSWER_TIMEOUT' ? 504 : error.code === 'NETWORK' ? 502 : 500;
  if (error.name === 'AbortError') status = 499;
  return { status, body: { error: { message: error.message || '서비스 오류', type: error.type || (status >= 500 ? 'server_error' : status === 401 ? 'authentication_error' : 'invalid_request_error'), param: error.param ?? null, code: error.code || 'beat_gateway_error' } } };
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
function setCors(res, config) {
  res.setHeader('Access-Control-Allow-Origin', config.cors_origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, OpenAI-Beta, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('X-BeAT-Compatibility', 'browser-adapter');
}
function secureEqual(first, second) {
  const left = Buffer.from(String(first || '')), right = Buffer.from(String(second || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function authenticate(req, config) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  const token = bearer?.[1] || req.headers['x-api-key'];
  if (!token || !secureEqual(token, config.api_key)) apiError(401, '올바른 Bearer API 키가 필요합니다.', { type: 'authentication_error', code: 'invalid_api_key' });
}
async function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  const encoding = String(req.headers['content-encoding'] || 'identity').toLowerCase();
  const factories = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
  let source = req;
  if (encoding !== 'identity') {
    if (!factories[encoding]) apiError(415, `지원하지 않는 Content-Encoding: ${encoding}`);
    source = req.pipe(factories[encoding]());
    req.once('error', (error) => source.destroy(error));
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of source) {
      length += chunk.length;
      if (length > limit) apiError(413, '요청 본문이 허용 크기를 초과했습니다.', { code: 'body_too_large' });
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    apiError(400, '요청 본문을 읽거나 압축 해제하지 못했습니다.', { code: 'invalid_body' });
  }
  let body;
  try { body = length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { apiError(400, '올바른 JSON이 아닙니다.', { code: 'invalid_json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) apiError(400, 'JSON 객체 본문이 필요합니다.', { code: 'invalid_json_object' });
  return body;
}
function extensionFromMime(mime) {
  return { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'application/pdf': '.pdf', 'text/plain': '.txt', 'application/json': '.json' }[String(mime).toLowerCase()] || '.bin';
}

class Artifacts {
  constructor(config) { this.config = config; this.directories = []; this.attachments = []; this.totalExtracted = 0; }
  addPath(filename, displayName, mimeType) {
    const name = displayName || path.basename(filename);
    if (store.isNativeImage(name, mimeType)) { this.attachments.push(filename); return `[이미지 첨부: ${name}]`; }
    const remaining = this.config.max_input_chars - this.totalExtracted;
    if (remaining < 1) apiError(413, '문서 입력이 허용 크기를 초과했습니다.', { code: 'input_too_large' });
    const extracted = store.extractDocumentText(filename, { maxChars: remaining });
    if (extracted.truncated) apiError(413, `문서 ${name}이 너무 큽니다. 필요한 부분으로 나누어 주세요.`, { code: 'input_too_large' });
    this.totalExtracted += extracted.text.length;
    return `[첨부 문서: ${name}]\n${extracted.text}`;
  }
  addStoredFile(id) {
    const file = store.getStoredFile(id);
    if (!file) apiError(404, `파일을 찾을 수 없습니다: ${id}`, { code: 'file_not_found' });
    return this.addPath(file.path, file.object.filename, file.metadata.mime_type);
  }
  writeBuffer(buffer, filename, mimeType) {
    if (buffer.length > this.config.max_upload_mb * 1024 * 1024) apiError(413, '입력 파일이 너무 큽니다.', { code: 'file_too_large' });
    const extension = path.extname(filename || '').slice(0, 16).replace(/[^.a-z0-9]/gi, '') || extensionFromMime(mimeType);
    const temp = store.makeTempFile(extension);
    this.directories.push(temp.directory);
    fs.writeFileSync(temp.filename, buffer, { mode: 0o600, flag: 'wx' });
    return this.addPath(temp.filename, filename || `input${extension}`, mimeType);
  }
  addData(value, filename) {
    const input = String(value || '');
    const match = input.match(/^data:([^;,]+)?;base64,([\s\S]*)$/);
    if (input.startsWith('data:') && !match) apiError(400, 'base64 data URL이 필요합니다.');
    const encoded = (match ? match[2] : input).replace(/\s/g, '');
    if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) apiError(400, '잘못된 Base64 파일 데이터입니다.');
    const mime = match?.[1] || '';
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) apiError(400, '잘못된 Base64 파일 데이터입니다.');
    return this.writeBuffer(buffer, filename || `input${extensionFromMime(mime)}`, mime);
  }
  async addUrl(value, filenameHint) {
    let url;
    try { url = new URL(value); } catch { apiError(400, '올바르지 않은 파일 URL입니다.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) apiError(400, '자격 증명이 포함되지 않은 HTTP(S) 파일 URL이 필요합니다.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) apiError(400, `원격 파일 응답 HTTP ${response.status}`);
      const maximum = this.config.max_upload_mb * 1024 * 1024;
      if (Number(response.headers.get('content-length') || 0) > maximum) apiError(413, '원격 파일이 너무 큽니다.');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) apiError(413, '원격 파일이 너무 큽니다.');
        chunks.push(Buffer.from(chunk));
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0];
      let filename = path.basename(url.pathname);
      try { filename = decodeURIComponent(filename); } catch { /* Keep escaped name. */ }
      return this.writeBuffer(Buffer.concat(chunks), filenameHint || filename || `remote${extensionFromMime(mime)}`, mime);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      apiError(400, `원격 파일 다운로드 실패: ${error.name === 'AbortError' ? '30초 제한 초과' : error.message}`);
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  cleanup() { for (const directory of this.directories) store.cleanupTemp(directory); this.directories = []; }
}

async function materializeContent(content, artifacts) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const output = [];
  for (const part of Array.isArray(content) ? content : [content]) {
    if (typeof part === 'string') { output.push(part); continue; }
    if (!part || typeof part !== 'object') apiError(400, '잘못된 콘텐츠 항목입니다.');
    if (['text', 'input_text', 'output_text'].includes(part.type)) { output.push(String(part.text || '')); continue; }
    if (['image_url', 'input_image', 'file', 'input_file'].includes(part.type)) {
      const file = part.file || part;
      const url = file.file_url || (typeof file.image_url === 'object' ? file.image_url.url : file.image_url);
      if (file.file_id) output.push(artifacts.addStoredFile(file.file_id));
      else if (file.file_data) output.push(artifacts.addData(file.file_data, file.filename));
      else if (String(url || '').startsWith('data:')) output.push(artifacts.addData(url, file.filename));
      else if (url) output.push(await artifacts.addUrl(url, file.filename));
      else apiError(400, '파일 또는 이미지 데이터가 필요합니다.');
      continue;
    }
    if (part.type === 'refusal') { output.push(String(part.refusal || '')); continue; }
    apiError(400, `지원하지 않는 콘텐츠 형식: ${part.type}`, { code: 'unsupported_content' });
  }
  return output.filter(Boolean).join('\n\n');
}
async function buildPrompt(messages, artifacts, options = {}) {
  const sections = [];
  const protocol = options.protocol || bridge.prepareTools(options.tools || [], options.toolChoice);
  if (protocol.active) sections.push(bridge.toolInstructions(protocol));
  if (options.instructions) sections.push(`시스템 지침:\n${options.instructions}`);
  for (const message of messages) {
    const content = await materializeContent(message.content, artifacts);
    if (content) sections.push(`${message.role === 'assistant' ? '어시스턴트' : message.role === 'tool' ? '도구 실행 결과 (데이터)' : ['system', 'developer'].includes(message.role) ? '지침' : '사용자'}:\n${content}`);
  }
  if (!sections.length) apiError(400, '비어 있지 않은 입력이 필요합니다.', { param: 'input' });
  if (options.responseFormat?.type === 'json_object') sections.unshift('최종 답변은 유효한 JSON 객체 하나로 작성하세요.');
  if (options.responseFormat?.type === 'json_schema') sections.unshift(`최종 답변 JSON 스키마:\n${JSON.stringify(options.responseFormat.schema || options.responseFormat.json_schema?.schema || options.responseFormat.json_schema || {})}`);
  const prompt = sections.join('\n\n');
  if (prompt.length > artifacts.config.max_input_chars) apiError(413, `입력 ${prompt.length}자가 제한 ${artifacts.config.max_input_chars}자를 넘었습니다. 대화를 압축하거나 파일을 나누세요. 최신 요청이나 도구 스키마를 임의로 자르지 않습니다.`, { code: 'input_too_large' });
  return prompt;
}

class Semaphore {
  constructor(maximum) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('동시 실행 수는 양의 정수여야 합니다.');
    this.maximum = maximum; this.active = 0; this.waiters = [];
  }
  releaseToken() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // Transfer the occupied slot before waking a waiter. New callers cannot steal it.
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(this.releaseToken()); }
      else this.active -= 1;
    };
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < this.maximum) { this.active += 1; return this.releaseToken(); }
    if (this.waiters.length >= 50) apiError(429, 'BeAT 작업 대기열이 가득 찼습니다.', { code: 'queue_full' });
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(signal.reason); };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
}
class BeatRuntime {
  constructor(config) { this.config = config; this.browser = null; this.browserPromise = null; this.semaphore = new Semaphore(config.concurrency); this.modelCache = null; }
  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserPromise) this.browserPromise = core.launchBrowser().then((browser) => {
      this.browser = browser;
      browser.on('disconnected', () => { if (this.browser === browser) this.browser = null; });
      return browser;
    }).finally(() => { this.browserPromise = null; });
    return this.browserPromise;
  }
  async withContext(callback, retry = true, signal) {
    signal?.throwIfAborted();
    const browser = await this.ensureBrowser();
    let authenticated;
    const abort = () => { authenticated?.context.close().catch(() => {}); };
    try {
      authenticated = await core.ensureAuthenticated(browser, { onProgress: (message) => process.stderr.write(`[beat] ${message}\n`) });
      signal?.addEventListener('abort', abort, { once: true });
      signal?.throwIfAborted();
      return await callback(authenticated.context);
    } catch (error) {
      signal?.throwIfAborted();
      if (retry && ['SESSION_EXPIRED', 'BROWSER_CLOSED'].includes(error.code)) {
        await authenticated?.context.close().catch(() => {});
        authenticated = null;
        if (error.code === 'SESSION_EXPIRED') await core.forceRefresh(browser);
        return this.withContext(callback, false, signal);
      }
      throw error;
    } finally { signal?.removeEventListener('abort', abort); await authenticated?.context.close().catch(() => {}); }
  }
  async chat(options) {
    const release = await this.semaphore.acquire(options.signal);
    try {
      return await this.withContext((context) => core.runChat(context, options.prompt, {
        model: options.model, effort: options.effort, effortExplicit: options.effort != null,
        timeoutSeconds: options.timeoutSeconds, conversationId: options.beatConversationId,
        attachments: options.attachments, plain: options.plain, onPartial: options.onPartial, signal: options.signal,
      }), true, options.signal);
    } finally { release(); }
  }
  async models({ refresh = false } = {}) {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < 3600000) return this.modelCache.models;
    const models = await this.withContext((context) => core.getModelCatalog(context));
    this.modelCache = { at: Date.now(), models };
    return models;
  }
  async close() {
    if (this.browserPromise) await this.browserPromise.catch(() => {});
    await this.browser?.close().catch(() => {}); this.browser = null;
  }
}

function inputItems(input) {
  const items = typeof input === 'string' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }] : input;
  return items.map((item) => typeof item === 'string' ? { id: store.objectId('msg'), type: 'message', role: 'user', content: [{ type: 'input_text', text: item }] } : { ...item, id: item.id || store.objectId('item'), ...(item.role && !item.type ? { type: 'message' } : {}) });
}
function createResponseObject(options) {
  return {
    id: options.id, object: 'response', created_at: options.createdAt, status: options.status,
    background: false, error: options.error || null, incomplete_details: null,
    instructions: options.body.instructions ?? null, model: options.model,
    output: options.output || [], output_text: options.text || '',
    parallel_tool_calls: options.body.parallel_tool_calls !== false,
    previous_response_id: options.body.previous_response_id || null,
    reasoning: { effort: options.effort || null, summary: null },
    store: options.body.store !== false, temperature: options.body.temperature ?? 1,
    top_p: options.body.top_p ?? 1, max_output_tokens: options.body.max_output_tokens ?? null,
    text: options.body.text || { format: { type: 'text' } },
    tools: options.body.tools || [], tool_choice: options.body.tool_choice || 'auto',
    truncation: options.body.truncation || 'disabled', usage: options.usage || null,
    metadata: options.body.metadata || {}, x_beat: options.xBeat,
    ...(options.conversationId ? { conversation: { id: options.conversationId } } : {}),
  };
}
function validateGenerationBody(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) apiError(400, 'JSON 객체가 필요합니다.');
  if (typeof body.model !== 'string' || !body.model.trim()) apiError(400, 'model 문자열이 필요합니다.', { param: 'model' });
  if (kind !== 'response' && !Array.isArray(body.messages)) apiError(400, 'messages 배열이 필요합니다.');
  if (body.n !== undefined && body.n !== 1) apiError(400, 'n=1만 지원합니다.');
  if (body.background) apiError(400, 'background 작업은 지원하지 않습니다.');
  for (const key of ['store', 'stream', 'parallel_tool_calls']) if (body[key] !== undefined && typeof body[key] !== 'boolean') apiError(400, `${key}는 불리언이어야 합니다.`);
  for (const key of ['timeout', 'timeout_seconds', 'max_output_tokens']) if (body[key] !== undefined && (!Number.isFinite(Number(body[key])) || Number(body[key]) <= 0)) apiError(400, `${key}는 양수여야 합니다.`);
}
async function generate(runtime, config, body, res, kind = 'response', signal) {
  validateGenerationBody(body, kind);
  const protocol = bridge.prepareTools(body.tools || [], body.tool_choice, body.parallel_tool_calls);
  if (kind !== 'response' && [...protocol.definitions.values()].some((tool) => tool.type === 'custom')) apiError(400, 'custom 도구는 Responses API에서만 지원합니다.');
  const artifacts = new Artifacts(config);
  const id = store.objectId(kind === 'response' ? 'resp' : kind === 'legacy' ? 'cmpl' : 'chatcmpl');
  const createdAt = now();
  let sequence = 0, keepAlive, conversationId = null;
  let options = { id, createdAt, status: 'in_progress', model: body.model, body, effort: body.reasoning_effort ?? body.reasoning?.effort };
  const write = (value) => { if (!res.destroyed && !res.writableEnded) res.write(kind === 'response' ? `event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n` : `data: ${JSON.stringify(value)}\n\n`); };
  try {
    signal?.throwIfAborted();
    const currentInput = kind === 'response' ? (body.input ?? '') : body.messages;
    let messages = bridge.normalizeInput(currentInput);
    let beatConversationId = kind === 'response' ? null : body.conversation_id || body.metadata?.beat_conversation_id;
    if (body.previous_response_id && body.conversation) apiError(400, 'previous_response_id와 conversation은 함께 사용할 수 없습니다.');
    if (kind === 'response' && (body.previous_response_id || body.conversation)) {
      const state = store.loadState();
      if (body.previous_response_id) {
        const previous = Object.hasOwn(state.responses, body.previous_response_id) && state.responses[body.previous_response_id];
        if (!previous) apiError(404, '이전 응답이 없거나 store=false로 생성되었습니다.', { code: 'response_not_found' });
        if (previous._history) messages = [...previous._history, ...messages];
        else beatConversationId = previous._beat_conversation_id;
      } else {
        conversationId = typeof body.conversation === 'string' ? body.conversation : body.conversation.id;
        const record = Object.hasOwn(state.conversations, conversationId) && state.conversations[conversationId];
        if (!record) apiError(404, '대화를 찾을 수 없습니다.', { code: 'conversation_not_found' });
        messages = [...bridge.normalizeInput(record.items), ...messages];
      }
    }
    if (beatConversationId) beatConversationId = core.validateConversationId(beatConversationId);
    const prompt = await buildPrompt(messages, artifacts, { protocol, instructions: body.instructions, responseFormat: body.text?.format || body.response_format });
    options.conversationId = conversationId;
    if (res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (kind === 'response') write({ type: 'response.created', response: createResponseObject(options) });
      else if (kind === 'chat') write({ id, object: 'chat.completion.chunk', created: createdAt, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      keepAlive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
      keepAlive.unref();
    }
    // Buffer tool-mode output: a partially rendered JSON envelope must never leak as text or execute.
    const result = await runtime.chat({ prompt, attachments: artifacts.attachments, model: body.model, effort: options.effort, timeoutSeconds: Number(body.timeout || body.timeout_seconds) || undefined, beatConversationId, plain: protocol.active, signal });
    signal?.throwIfAborted();
    const raw = protocol.active ? (result.answer_plain ?? result.answer) : (result.answer_markdown ?? result.answer ?? result.answer_plain);
    const decoded = protocol.active ? bridge.decodeAnswer(raw, protocol) : { output: bridge.messageOutput(raw || ''), text: raw || '', toolCalls: false };
    const usage = usageFor(prompt, decoded.toolCalls ? JSON.stringify(decoded.output) : decoded.text);
    const warnings = [];
    if (protocol.active) warnings.push('tool_calls_emulated_from_text');
    if (['temperature', 'top_p', 'seed', 'logprobs', 'frequency_penalty', 'presence_penalty', 'max_output_tokens'].some((key) => body[key] !== undefined)) warnings.push('generation_parameters_not_forwarded');
    const xBeat = { conversation_id: result.conversation_id || null, model_title: result.model_title, reasoning_effort: result.reasoning_effort, elapsed_seconds: result.elapsed_seconds, usage_estimated: true, warnings };
    const response = createResponseObject({ ...options, status: 'completed', model: result.model || body.model, output: decoded.output, text: decoded.text, usage, effort: result.reasoning_effort ?? options.effort, xBeat });
    const toolCalls = decoded.output.filter((item) => item.type === 'function_call').map((item) => ({ id: item.call_id, type: 'function', function: { name: item.namespace ? `${item.namespace}.${item.name}` : item.name, arguments: item.arguments } }));
    const chatUsage = { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens };
    const completion = { id, object: kind === 'legacy' ? 'text_completion' : 'chat.completion', created: createdAt, model: response.model, choices: [{ index: 0, ...(kind === 'legacy' ? { text: decoded.text } : { message: { role: 'assistant', content: decoded.toolCalls ? null : decoded.text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }), finish_reason: decoded.toolCalls ? 'tool_calls' : 'stop', logprobs: null }], usage: chatUsage, x_beat: xBeat };
    if (body.store !== false || conversationId) await store.mutateState((state) => {
      if (body.store !== false) {
        if (kind === 'response') state.responses[id] = { ...response, _beat_conversation_id: result.conversation_id, _input_items: inputItems(currentInput), _history: [...messages, ...bridge.normalizeInput(decoded.output)] };
        else state.chat_completions[id] = completion;
      }
      if (conversationId && state.conversations[conversationId]) {
        state.conversations[conversationId].items.push(...inputItems(currentInput), ...decoded.output);
        state.conversations[conversationId].updated_at = now();
      }
    });
    if (res && !res.destroyed) {
      if (kind === 'response') { bridge.emitOutput(decoded.output, write); write({ type: 'response.completed', response }); }
      else if (kind === 'legacy') { write(completion); res.write('data: [DONE]\n\n'); }
      else {
        write({ id, object: 'chat.completion.chunk', created: createdAt, model: response.model, choices: [{ index: 0, delta: decoded.toolCalls ? { tool_calls: toolCalls.map((call, index) => ({ index, ...call })) } : { content: decoded.text }, finish_reason: null }] });
        write({ id, object: 'chat.completion.chunk', created: createdAt, model: response.model, choices: [{ index: 0, delta: {}, finish_reason: decoded.toolCalls ? 'tool_calls' : 'stop' }] });
        if (body.stream_options?.include_usage) write({ id, object: 'chat.completion.chunk', created: createdAt, model: response.model, choices: [], usage: chatUsage });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    }
    return kind === 'response' ? response : completion;
  } catch (error) {
    if (res?.headersSent) {
      const exposed = publicError(error).body.error;
      if (kind === 'response') write({ type: 'response.failed', response: createResponseObject({ ...options, status: 'failed', error: exposed }) });
      else { write({ error: exposed }); if (!res.destroyed) res.write('data: [DONE]\n\n'); }
      if (!res.destroyed) res.end();
      return null;
    }
    throw error;
  } finally { clearInterval(keepAlive); artifacts.cleanup(); }
}
function runResponse(runtime, config, body, res = null, signal) { return generate(runtime, config, body, res, 'response', signal); }
function runChatCompletion(runtime, config, body, res = null, signal) { return generate(runtime, config, body, res, 'chat', signal); }

async function parseMultipartUpload(req, config) {
  let parser;
  try { parser = Busboy({ headers: req.headers, limits: { fileSize: Math.floor(config.max_upload_mb * 1024 * 1024), files: 1, fields: 30, fieldSize: 1024 * 1024 } }); }
  catch { apiError(400, '올바른 multipart/form-data 요청이 필요합니다.'); }
  const fields = Object.create(null);
  let upload, writer, fileTask, problem;
  const recordError = (error) => { problem ||= error; };
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => { const error = new ApiError(400, '파일 업로드가 중단되었습니다.'); recordError(error); parser.destroy(error); reject(error); };
      req.once('aborted', onAbort);
      parser.on('field', (name, value, info) => { if (info.valueTruncated) recordError(new ApiError(413, '업로드 필드가 너무 큽니다.')); fields[name] = value; });
      parser.on('file', (name, stream, info) => {
        if (name !== 'file' || upload) { recordError(new ApiError(400, 'file 필드 하나만 허용합니다.')); stream.resume(); return; }
        try {
          upload = { ...store.makeTempFile(path.extname(info.filename || '').slice(0, 16).replace(/[^.a-z0-9]/gi, '') || '.bin'), info };
          writer = fs.createWriteStream(upload.filename, { flags: 'wx', mode: 0o600 });
          stream.once('limit', () => recordError(new ApiError(413, '파일 크기 제한을 초과했습니다.', { code: 'file_too_large' })));
          fileTask = pipeline(stream, writer).catch(recordError);
        } catch (error) { recordError(error); stream.resume(); }
      });
      parser.on('filesLimit', () => recordError(new ApiError(400, '파일은 요청당 하나만 허용합니다.')));
      parser.on('fieldsLimit', () => recordError(new ApiError(400, '업로드 필드가 너무 많습니다.')));
      parser.once('error', (error) => { recordError(error); reject(new ApiError(400, '업로드 본문이 손상되었습니다.')); });
      parser.once('close', resolve);
      req.pipe(parser);
    });
    await fileTask;
    if (problem) throw problem;
    if (!upload) apiError(400, 'file 필드가 필요합니다.');
    if (!['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'].includes(fields.purpose || 'user_data')) apiError(400, '지원하지 않는 purpose입니다.');
    const seconds = fields['expires_after[seconds]'];
    if (seconds !== undefined && (!Number.isInteger(Number(seconds)) || Number(seconds) < 3600 || Number(seconds) > 2592000)) apiError(400, 'expires_after[seconds]는 3600~2592000 사이 정수여야 합니다.');
    return await store.storeUploadedFile(upload.filename, { filename: upload.info.filename, mimeType: upload.info.mimeType, purpose: fields.purpose || 'user_data', expiresAfterSeconds: seconds });
  } finally {
    req.off('aborted', onAbort);
    if (!parser.destroyed) parser.destroy();
    if (writer && !writer.closed) writer.destroy();
    await fileTask;
    if (upload) store.cleanupTemp(upload.directory);
  }
}
function listObject(rows, hasMore = false) { return { object: 'list', data: rows, first_id: rows[0]?.id || null, last_id: rows.at(-1)?.id || null, has_more: hasMore }; }
function paginate(rows, params) {
  rows.sort((a, b) => (params.get('order') === 'asc' ? 1 : -1) * ((a.created_at || a.created || 0) - (b.created_at || b.created || 0)));
  if (params.has('after')) { const index = rows.findIndex((item) => item.id === params.get('after')); if (index < 0) apiError(400, 'after 커서를 찾을 수 없습니다.'); rows = rows.slice(index + 1); }
  const limit = Number(params.get('limit') || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) apiError(400, 'limit은 1~100 사이 정수여야 합니다.');
  return listObject(rows.slice(0, limit), rows.length > limit);
}
function stripInternal(record) { return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_'))); }
function publicConversation(record) { return { id: record.id, object: 'conversation', created_at: record.created_at, metadata: record.metadata || {} }; }
function lookup(map, id, kind) { const value = Object.hasOwn(map, id) && map[id]; if (!value) apiError(404, `${kind}을 찾을 수 없습니다.`, { code: 'not_found' }); return value; }

async function route(runtime, config, req, res, signal, onShutdown) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  setCors(res, config);
  res.setHeader('X-Request-ID', `req_${crypto.randomBytes(12).toString('base64url')}`);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (['/health', '/v1/health'].includes(pathname) && req.method === 'GET') return json(res, 200, { status: 'ok', service: 'beat-openai-gateway', version: VERSION, pid: process.pid, instance_id: config.instance_id || null, browser: runtime.browser?.isConnected() ? 'ready' : 'cold', active_requests: runtime.semaphore?.active || 0, queued_requests: runtime.semaphore?.waiters.length || 0 });
  if (pathname === '/' && req.method === 'GET') return json(res, 200, { name: 'BeAT OpenAI-compatible gateway', version: VERSION, base_url: '/v1' });
  authenticate(req, config);
  if (pathname === '/internal/shutdown' && req.method === 'POST' && onShutdown) { json(res, 200, { stopped: true }); setImmediate(onShutdown); return; }
  if (/^\/v1\/models(?:\/[^/]+)?$/.test(pathname) && req.method === 'GET') {
    const models = (await runtime.models()).map((model) => ({ id: model.key, object: 'model', created: 0, owned_by: 'beat-busanedu', x_beat: { title: model.title, reasoning_efforts: model.efforts, default_reasoning_effort: model.default_effort } }));
    if (pathname === '/v1/models') return json(res, 200, { object: 'list', data: models });
    const model = models.find((item) => item.id === decodeURIComponent(pathname.split('/').at(-1)));
    if (!model) apiError(404, '모델을 찾을 수 없습니다.');
    return json(res, 200, model);
  }
  if (req.method === 'POST' && ['/v1/responses', '/v1/chat/completions', '/v1/completions'].includes(pathname)) {
    const body = await readJsonBody(req);
    const kind = pathname === '/v1/responses' ? 'response' : pathname === '/v1/completions' ? 'legacy' : 'chat';
    if (kind === 'legacy') { if (body.tools?.length) apiError(400, '레거시 completions는 도구를 지원하지 않습니다.'); body.messages = [{ role: 'user', content: Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt }]; }
    const result = await generate(runtime, config, body, body.stream ? res : null, kind, signal);
    if (!body.stream) json(res, 200, result);
    return;
  }
  if (pathname === '/v1/responses/input_tokens' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return json(res, 200, { object: 'response.input_tokens', input_tokens: estimateTokens(JSON.stringify(bridge.normalizeInput(body.input || ''))) });
  }
  if (pathname === '/v1/files') {
    if (req.method === 'POST') return json(res, 200, await parseMultipartUpload(req, config));
    if (req.method === 'GET') return json(res, 200, store.listStoredFiles(Object.fromEntries(url.searchParams)));
  }
  const fileMatch = pathname.match(/^\/v1\/files\/([^/]+)(\/content)?$/);
  if (fileMatch) {
    const id = decodeURIComponent(fileMatch[1]);
    const file = store.getStoredFile(id);
    if (!file) apiError(404, '파일을 찾을 수 없습니다.', { code: 'file_not_found' });
    if (req.method === 'DELETE' && !fileMatch[2]) { await store.deleteStoredFile(id); return json(res, 200, { id, object: 'file', deleted: true }); }
    if (req.method === 'GET' && !fileMatch[2]) return json(res, 200, file.object);
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': file.metadata.mime_type || 'application/octet-stream', 'Content-Length': fs.statSync(file.path).size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.object.filename)}` });
      await pipeline(fs.createReadStream(file.path), res); return;
    }
  }
  const responseMatch = pathname.match(/^\/v1\/(responses|chat\/completions)(?:\/([^/]+)(?:\/(input_items|cancel))?)?$/);
  if (responseMatch) {
    const collection = responseMatch[1] === 'responses' ? 'responses' : 'chat_completions';
    const records = store.loadState()[collection];
    if (!responseMatch[2] && req.method === 'GET') return json(res, 200, paginate(Object.values(records).map(stripInternal), url.searchParams));
    if (responseMatch[2]) {
      const id = decodeURIComponent(responseMatch[2]);
      const record = lookup(records, id, '응답');
      if (responseMatch[3] === 'input_items' && req.method === 'GET') return json(res, 200, paginate([...(record._input_items || [])], url.searchParams));
      if (responseMatch[3] === 'cancel') apiError(400, '완료된 동기 응답은 취소할 수 없습니다. 실행 중 요청은 연결을 닫아 취소하세요.', { code: 'not_cancellable' });
      if (!responseMatch[3] && req.method === 'GET') return json(res, 200, stripInternal(record));
      if (!responseMatch[3] && req.method === 'DELETE') { await store.mutateState((state) => { delete state[collection][id]; }); return json(res, 200, { id, object: record.object, deleted: true }); }
    }
  }
  if (pathname === '/v1/conversations') {
    if (req.method === 'GET') return json(res, 200, paginate(Object.values(store.loadState().conversations).map(publicConversation), url.searchParams));
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      bridge.normalizeInput(body.items || []);
      const record = { id: store.objectId('conv'), created_at: now(), updated_at: now(), metadata: body.metadata || {}, items: inputItems(body.items || []) };
      await store.mutateState((state) => { state.conversations[record.id] = record; });
      return json(res, 200, publicConversation(record));
    }
  }
  const conversationMatch = pathname.match(/^\/v1\/conversations\/([^/]+)(\/items)?(?:\/([^/]+))?$/);
  if (conversationMatch) {
    const id = decodeURIComponent(conversationMatch[1]), itemId = conversationMatch[3] ? decodeURIComponent(conversationMatch[3]) : null;
    const record = lookup(store.loadState().conversations, id, '대화');
    if (!conversationMatch[2]) {
      if (req.method === 'GET') return json(res, 200, publicConversation(record));
      if (req.method === 'DELETE') { await store.mutateState((state) => { delete state.conversations[id]; }); return json(res, 200, { id, object: 'conversation.deleted', deleted: true }); }
      if (req.method === 'POST') { const body = await readJsonBody(req); await store.mutateState((state) => { lookup(state.conversations, id, '대화').metadata = body.metadata || {}; }); return json(res, 200, publicConversation(store.loadState().conversations[id])); }
    } else if (!itemId) {
      if (req.method === 'GET') return json(res, 200, paginate([...record.items], url.searchParams));
      if (req.method === 'POST') { const body = await readJsonBody(req); bridge.normalizeInput(body.items || []); const items = inputItems(body.items || []); await store.mutateState((state) => { lookup(state.conversations, id, '대화').items.push(...items); }); return json(res, 200, listObject(items)); }
    } else {
      const item = record.items.find((value) => value.id === itemId);
      if (!item) apiError(404, '대화 항목을 찾을 수 없습니다.');
      if (req.method === 'GET') return json(res, 200, item);
      if (req.method === 'DELETE') { await store.mutateState((state) => { const current = lookup(state.conversations, id, '대화'); current.items = current.items.filter((value) => value.id !== itemId); }); return json(res, 200, publicConversation(record)); }
    }
  }
  apiError(404, `지원하지 않는 엔드포인트: ${req.method} ${pathname}`, { code: 'not_found' });
}

function createGateway(options = {}) {
  const config = { ...store.normalizeServiceConfig(options.config || {}), ...options.config };
  const runtime = options.runtime || new BeatRuntime(config);
  const requests = new Set();
  let closing;
  const server = http.createServer((req, res) => {
    const controller = new AbortController(); requests.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(new DOMException('클라이언트 연결이 닫혔습니다.', 'AbortError')); };
    req.once('aborted', abort); res.once('close', abort);
    route(runtime, config, req, res, controller.signal, options.onShutdown).catch((error) => {
      if (!res.headersSent) { setCors(res, config); const exposed = publicError(error); json(res, exposed.status, exposed.body); }
      else if (!res.destroyed) res.end();
      if (process.env.BEAT_DEBUG) process.stderr.write(`[beat] ${error.stack || error.message}\n`);
    }).finally(() => { requests.delete(controller); req.off('aborted', abort); res.off('close', abort); });
  });
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  return {
    server, runtime, config,
    async start() {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen);
        server.listen(config.port, config.host);
      });
      return server.address();
    },
    close() {
      if (!closing) closing = (async () => {
        for (const controller of requests) controller.abort(new DOMException('게이트웨이 종료', 'AbortError'));
        const done = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await runtime.close();
        await done;
      })();
      return closing;
    },
  };
}
async function main() {
  const config = store.loadServiceConfig({ create: true });
  config.instance_id = process.env.BEAT_SERVICE_INSTANCE || null;
  let gateway;
  const shutdown = () => gateway.close().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  gateway = createGateway({ config, onShutdown: shutdown });
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try { await gateway.start(); }
  catch (error) { await gateway.close(); throw error; }
  process.stderr.write(`[beat] OpenAI 호환 서비스: http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}/v1\n`);
}
if (require.main === module) main().catch((error) => { process.stderr.write(`BeAT 서비스 시작 실패: ${error.message}\n`); process.exitCode = 1; });
module.exports = { ApiError, BeatRuntime, Semaphore, Artifacts, buildPrompt, runChatCompletion, runResponse, createGateway, publicError, parseMultipartUpload, main };
