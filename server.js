#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Busboy = require('busboy');
const {
  BeatError,
  launchBrowser,
  ensureAuthenticated,
  forceRefresh,
  getModelCatalog,
  runChat,
} = require('./core');
const store = require('./api-store');

const VERSION = '2.0.0';
const JSON_BODY_LIMIT = 25 * 1024 * 1024;
const FALLBACK_MODELS = [
  ['chat_gpt5_6_sol', 'GPT-5.6 Sol', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['chat_gpt5_6_terra', 'GPT-5.6 Terra', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['chat_gpt5_6_luna', 'GPT-5.6 Luna', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['chat_gpt5_5', 'GPT-5.5', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['chat_gpt5_4', 'GPT-5.4', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
  ['chat_gpt5_4m', 'GPT-5.4 mini', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
  ['chat_gpt5_4nano', 'GPT-5.4 nano', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
  ['chat_gpt5_2', 'GPT-5.2', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
  ['chat_gpt5_1', 'GPT-5.1', ['none', 'low', 'medium', 'high'], 'none'],
  ['chat_gpt5', 'GPT-5', ['minimal', 'low', 'medium', 'high'], 'medium'],
  ['chat_gpt5m', 'GPT-5 mini', ['minimal', 'low', 'medium', 'high'], 'medium'],
  ['chat_gpt5nano', 'GPT-5 nano', ['minimal', 'low', 'medium', 'high'], 'medium'],
  ['chat_gpt4_1', 'GPT-4.1', [], null],
  ['chat_gpt4_1m', 'GPT-4.1 mini', [], null],
  ['chat_gpt4_1nano', 'GPT-4.1 nano', [], null],
  ['chat_gpt4o', 'GPT-4o', [], null],
  ['chat_gpt4om', 'GPT-4o mini', [], null],
  ['chat_gpto4m', 'o4-mini', ['low', 'medium', 'high'], 'medium'],
  ['chat_gpt_chat_latest', 'ChatGPT latest', [], null],
  ['chat_model_router', 'Auto Router', [], null],
].map(([key, title, efforts, default_effort]) => ({ key, title, efforts, default_effort }));

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

function apiError(status, message, options) {
  throw new ApiError(status, message, options);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function estimateTokens(value) {
  return Math.max(0, Math.ceil(Buffer.byteLength(String(value || ''), 'utf8') / 4));
}

function usageFor(input, output) {
  const inputTokens = estimateTokens(input);
  const outputTokens = estimateTokens(output);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function chatUsage(input, output) {
  const usage = usageFor(input, output);
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

function publicError(error) {
  let status = 500;
  let type = 'server_error';
  let code = 'beat_gateway_error';
  let param = null;
  if (error instanceof ApiError) {
    ({ status, type, code, param } = error);
  } else if (error instanceof BeatError) {
    status = error.code === 'SESSION_EXPIRED' || error.code === 'LOGIN_FAILED' ? 401
      : error.code === 'ANSWER_TIMEOUT' ? 504
        : error.code === 'NETWORK' ? 502
          : 500;
    type = status === 401 ? 'authentication_error' : 'server_error';
    code = String(error.code || 'beat_error').toLowerCase();
  } else if (error?.code === 'ENOENT') {
    status = 400;
    type = 'invalid_request_error';
    code = 'file_not_found';
  }
  return {
    status,
    body: {
      error: {
        message: error?.message || '알 수 없는 서비스 오류가 발생했습니다.',
        type,
        param,
        code,
      },
    },
  };
}

function json(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function setCors(res, config) {
  res.setHeader('Access-Control-Allow-Origin', config.cors_origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, OpenAI-Beta, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-BeAT-Compatibility');
  res.setHeader('X-BeAT-Compatibility', 'browser-adapter');
}

function secureEqual(first, second) {
  const left = Buffer.from(String(first || ''));
  const right = Buffer.from(String(second || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticate(req, config) {
  const authorization = String(req.headers.authorization || '');
  const token = authorization.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
  if (!token || !secureEqual(token, config.api_key)) {
    apiError(401, '올바른 Bearer API 키가 필요합니다.', {
      type: 'authentication_error',
      code: 'invalid_api_key',
    });
  }
}

async function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) apiError(413, `요청 본문은 ${Math.floor(limit / 1024 / 1024)} MiB까지 지원합니다.`, { code: 'body_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    apiError(400, '요청 본문이 올바른 JSON이 아닙니다.', { code: 'invalid_json' });
  }
}

function responseInputText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.type === 'message') return contentTextOnly(item.content);
    if (['input_text', 'output_text', 'text'].includes(item?.type)) return item.text || '';
    return '';
  }).filter(Boolean).join('\n');
}

function contentTextOnly(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (['text', 'input_text', 'output_text'].includes(part?.type)) return part.text || '';
    return '';
  }).filter(Boolean).join('\n');
}

function extensionFromMime(mimeType) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/avif': '.avif',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
  };
  return map[String(mimeType || '').toLowerCase()] || '.bin';
}

function longestCommonPrefix(first, second) {
  const length = Math.min(first.length, second.length);
  let index = 0;
  while (index < length && first[index] === second[index]) index += 1;
  return index;
}

class Artifacts {
  constructor(config) {
    this.config = config;
    this.directories = [];
    this.attachments = [];
    this.totalExtracted = 0;
  }

  remainingChars() {
    return Math.max(1000, this.config.max_input_chars - this.totalExtracted);
  }

  addPath(filename, displayName, mimeType) {
    const name = displayName || path.basename(filename);
    if (store.isNativeImage(name, mimeType)) {
      this.attachments.push(filename);
      return `[이미지 첨부: ${name}]`;
    }
    const extracted = store.extractDocumentText(filename, { maxChars: this.remainingChars() });
    this.totalExtracted += extracted.text.length;
    return `[첨부 문서: ${name}${extracted.truncated ? ', 일부만 포함' : ''}]\n${extracted.text}`;
  }

  addStoredFile(fileId) {
    const stored = store.getStoredFile(fileId);
    if (!stored) apiError(404, `파일을 찾을 수 없습니다: ${fileId}`, { param: 'file_id', code: 'file_not_found' });
    return this.addPath(stored.path, stored.object.filename, stored.metadata.mime_type);
  }

  writeBuffer(buffer, filename, mimeType) {
    if (buffer.length > this.config.max_upload_mb * 1024 * 1024) {
      apiError(413, `입력 파일은 ${this.config.max_upload_mb} MiB까지 지원합니다.`, { code: 'file_too_large' });
    }
    const extension = path.extname(filename || '').slice(0, 16).replace(/[^.a-z0-9]/gi, '')
      || extensionFromMime(mimeType);
    const temp = store.makeTempFile(extension);
    fs.writeFileSync(temp.filename, buffer, { mode: 0o600 });
    this.directories.push(temp.directory);
    return this.addPath(temp.filename, filename || `input${extension}`, mimeType);
  }

  addData(value, filename) {
    const stringValue = String(value || '');
    const match = stringValue.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
    let mimeType = '';
    let encoded = stringValue;
    if (match) {
      mimeType = match[1] || '';
      encoded = match[2];
    }
    let buffer;
    try {
      buffer = Buffer.from(encoded, 'base64');
    } catch {
      apiError(400, 'Base64 파일 데이터를 해석하지 못했습니다.', { param: 'file_data' });
    }
    if (!buffer.length && encoded) apiError(400, 'Base64 파일 데이터가 올바르지 않습니다.', { param: 'file_data' });
    return this.writeBuffer(buffer, filename || `input${extensionFromMime(mimeType)}`, mimeType);
  }

  async addUrl(urlValue, filenameHint) {
    const url = new URL(String(urlValue));
    if (!['http:', 'https:'].includes(url.protocol)) {
      apiError(400, '파일 URL은 http 또는 https만 지원합니다.', { param: 'url' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    } catch (error) {
      apiError(400, `원격 파일을 내려받지 못했습니다: ${error.message}`, { param: 'url' });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) apiError(400, `원격 파일 응답이 HTTP ${response.status}입니다.`, { param: 'url' });
    const declared = Number(response.headers.get('content-length') || 0);
    const maximum = this.config.max_upload_mb * 1024 * 1024;
    if (declared > maximum) apiError(413, `원격 파일은 ${this.config.max_upload_mb} MiB까지 지원합니다.`, { code: 'file_too_large' });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) apiError(413, `원격 파일은 ${this.config.max_upload_mb} MiB까지 지원합니다.`, { code: 'file_too_large' });
      chunks.push(Buffer.from(chunk));
    }
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0];
    const urlName = path.basename(decodeURIComponent(url.pathname)) || `remote${extensionFromMime(mimeType)}`;
    return this.writeBuffer(Buffer.concat(chunks), filenameHint || urlName, mimeType);
  }

  cleanup() {
    for (const directory of this.directories) store.cleanupTemp(directory);
    this.directories = [];
  }
}

async function materializeContent(content, artifacts) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  const output = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      output.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if (['text', 'input_text', 'output_text'].includes(part.type)) {
      output.push(String(part.text || ''));
      continue;
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      const value = typeof part.image_url === 'object' ? part.image_url.url : part.image_url;
      if (part.file_id) output.push(artifacts.addStoredFile(part.file_id));
      else if (String(value || '').startsWith('data:')) output.push(artifacts.addData(value, part.filename));
      else if (value) output.push(await artifacts.addUrl(value, part.filename));
      else apiError(400, '이미지 입력에 image_url 또는 file_id가 필요합니다.', { param: 'input' });
      continue;
    }
    if (part.type === 'file' || part.type === 'input_file') {
      if (part.file_id) output.push(artifacts.addStoredFile(part.file_id));
      else if (part.file_data) output.push(artifacts.addData(part.file_data, part.filename));
      else if (part.file_url) output.push(await artifacts.addUrl(part.file_url, part.filename));
      else apiError(400, '파일 입력에 file_id, file_data 또는 file_url이 필요합니다.', { param: 'input' });
      continue;
    }
    if (part.type === 'input_audio' || part.type === 'audio') {
      apiError(400, 'BeAT 웹 채팅은 오디오 입력을 지원하지 않습니다.', { param: 'input', code: 'unsupported_audio' });
    }
  }
  return output.filter(Boolean).join('\n\n');
}

function normalizeMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) apiError(400, 'input은 문자열 또는 항목 배열이어야 합니다.', { param: 'input' });
  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') messages.push({ role: 'user', content: item });
    else if (item?.type === 'message' || item?.role) messages.push({ role: item.role || 'user', content: item.content ?? '' });
    else if (['input_text', 'text'].includes(item?.type)) messages.push({ role: 'user', content: item.text || '' });
  }
  return messages;
}

function itemText(item) {
  return contentTextOnly(item.content);
}

async function buildPrompt(messages, artifacts, options = {}) {
  const rendered = [];
  if (options.instructions) rendered.push(`시스템 지침:\n${options.instructions}`);
  for (const message of messages) {
    const role = String(message.role || 'user').toLowerCase();
    const content = await materializeContent(message.content, artifacts);
    if (!content) continue;
    rendered.push(`${role === 'assistant' ? '어시스턴트' : role === 'system' || role === 'developer' ? '지침' : '사용자'}:\n${content}`);
  }
  if (!rendered.length && artifacts.attachments.length) rendered.push('사용자:\n첨부된 이미지를 분석해 주세요.');
  if (!rendered.length) apiError(400, '비어 있지 않은 입력이 필요합니다.', { param: 'input' });

  if (Array.isArray(options.tools) && options.tools.length) {
    const descriptions = options.tools.map((tool) => {
      const definition = tool.function || tool;
      return `- ${definition.name || tool.type}: ${definition.description || ''}\n  입력 스키마: ${JSON.stringify(definition.parameters || {})}`;
    }).join('\n').slice(0, 30000);
    rendered.unshift(`사용 가능한 도구 설명(실제 자동 실행은 되지 않으므로, 필요한 경우 호출 의도를 텍스트로 설명하세요):\n${descriptions}`);
  }
  if (options.responseFormat?.type === 'json_object') {
    rendered.unshift('응답은 설명이나 코드 펜스 없이 유효한 JSON 객체 하나로만 작성하세요.');
  } else if (options.responseFormat?.type === 'json_schema') {
    rendered.unshift(`응답은 다음 JSON 스키마를 따르는 JSON 하나로만 작성하세요:\n${JSON.stringify(options.responseFormat.json_schema || {})}`);
  }

  let prompt;
  if (rendered.length === 1 && /^사용자:\n/.test(rendered[0])) prompt = rendered[0].replace(/^사용자:\n/, '');
  else prompt = `${rendered.join('\n\n')}\n\n위 맥락에 따라 마지막 사용자 요청에 답하세요.`;
  if (prompt.length > artifacts.config.max_input_chars) {
    prompt = `${prompt.slice(0, artifacts.config.max_input_chars)}\n\n[입력이 길어 이후 내용이 잘렸습니다.]`;
  }
  return prompt;
}

function inputItemsFromMessages(messages) {
  return messages.map((message) => ({
    id: store.objectId('msg'),
    type: 'message',
    status: 'completed',
    role: message.role || 'user',
    content: typeof message.content === 'string'
      ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
      : message.content,
  }));
}

function publicConversation(record) {
  return {
    id: record.id,
    object: 'conversation',
    created_at: record.created_at,
    metadata: record.metadata || {},
  };
}

function listObject(rows, hasMore = false) {
  return {
    object: 'list',
    data: rows,
    first_id: rows[0]?.id || null,
    last_id: rows[rows.length - 1]?.id || null,
    has_more: hasMore,
  };
}

function paginate(rows, searchParams) {
  const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  rows.sort((a, b) => order === 'asc'
    ? (a.created_at || 0) - (b.created_at || 0)
    : (b.created_at || 0) - (a.created_at || 0));
  const after = searchParams.get('after');
  if (after) {
    const index = rows.findIndex((row) => row.id === after);
    if (index >= 0) rows = rows.slice(index + 1);
  }
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 20));
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

class Semaphore {
  constructor(maximum) {
    this.maximum = maximum;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.maximum) {
      this.active += 1;
      return () => this.release();
    }
    if (this.waiters.length >= 50) apiError(429, 'BeAT 작업 대기열이 가득 찼습니다.', { type: 'rate_limit_error', code: 'queue_full' });
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

class BeatRuntime {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.browserPromise = null;
    this.semaphore = new Semaphore(config.concurrency);
    this.modelCache = null;
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = launchBrowser().then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        return browser;
      }).finally(() => {
        this.browserPromise = null;
      });
    }
    return this.browserPromise;
  }

  async withContext(callback, retry = true) {
    const browser = await this.ensureBrowser();
    let authenticated;
    try {
      authenticated = await ensureAuthenticated(browser, {
        onProgress: (message) => process.stderr.write(`[beat] ${message}\n`),
      });
      return await callback(authenticated.context);
    } catch (error) {
      if (authenticated?.context) await authenticated.context.close().catch(() => {});
      authenticated = null;
      if (retry && (error.code === 'SESSION_EXPIRED' || error.code === 'BROWSER_CLOSED')) {
        if (error.code === 'BROWSER_CLOSED') {
          await this.browser?.close().catch(() => {});
          this.browser = null;
        } else {
          await forceRefresh(await this.ensureBrowser(), (message) => process.stderr.write(`[beat] ${message}\n`));
        }
        return this.withContext(callback, false);
      }
      throw error;
    } finally {
      if (authenticated?.context) await authenticated.context.close().catch(() => {});
    }
  }

  async chat(options) {
    const release = await this.semaphore.acquire();
    try {
      return await this.withContext((context) => runChat(context, options.prompt, {
        model: options.model,
        effort: options.effort,
        effortExplicit: options.effort !== undefined && options.effort !== null,
        timeoutSeconds: options.timeoutSeconds,
        conversationId: options.beatConversationId,
        attachments: options.attachments,
        plain: options.plain,
        onPartial: options.onPartial,
        onProgress: (message) => process.stderr.write(`[beat] ${message}\n`),
      }));
    } finally {
      release();
    }
  }

  async models() {
    if (this.modelCache && Date.now() - this.modelCache.at < 60 * 60 * 1000) return this.modelCache.models;
    try {
      const models = await this.withContext((context) => getModelCatalog(context));
      this.modelCache = { at: Date.now(), models };
      return models;
    } catch (error) {
      process.stderr.write(`[beat] 모델 목록 실시간 조회 실패, 내장 목록 사용: ${error.message}\n`);
      return FALLBACK_MODELS;
    }
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

function effortFromBody(body) {
  return body.reasoning_effort ?? body.reasoning?.effort ?? body.reasoning?.summary_effort;
}

function validateGenerationBody(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) apiError(400, 'JSON 객체 본문이 필요합니다.');
  if (!body.model) apiError(400, 'model 필드가 필요합니다.', { param: 'model' });
  if (kind === 'chat' && !Array.isArray(body.messages)) apiError(400, 'messages 배열이 필요합니다.', { param: 'messages' });
  if (body.n !== undefined && Number(body.n) !== 1) apiError(400, '이 어댑터는 n=1만 지원합니다.', { param: 'n', code: 'unsupported_parameter' });
  const toolChoice = typeof body.tool_choice === 'object' ? body.tool_choice.type : body.tool_choice;
  if (toolChoice === 'required' || (typeof body.tool_choice === 'object' && body.tool_choice.function)) {
    apiError(400, 'BeAT 웹 채팅은 강제 도구 호출을 지원하지 않습니다.', { param: 'tool_choice', code: 'unsupported_tool_choice' });
  }
}

function createResponseObject(options) {
  const messageId = options.messageId || store.objectId('msg');
  const output = options.text === undefined ? [] : [{
    id: messageId,
    type: 'message',
    status: options.status === 'completed' ? 'completed' : 'in_progress',
    role: 'assistant',
    content: [{
      type: 'output_text',
      annotations: [],
      logprobs: [],
      text: options.text,
    }],
  }];
  return {
    id: options.id,
    object: 'response',
    created_at: options.createdAt,
    status: options.status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: options.instructions ?? null,
    max_output_tokens: options.maxOutputTokens ?? null,
    model: options.model,
    output,
    output_text: options.text || '',
    parallel_tool_calls: true,
    previous_response_id: options.previousResponseId ?? null,
    reasoning: options.effort ? { effort: options.effort, summary: null } : null,
    store: options.store !== false,
    temperature: options.temperature ?? 1,
    text: options.textConfig || { format: { type: 'text' } },
    tool_choice: options.toolChoice || 'auto',
    tools: options.tools || [],
    top_p: options.topP ?? 1,
    truncation: options.truncation || 'disabled',
    usage: options.usage || null,
    metadata: options.metadata || {},
    ...(options.conversationId ? { conversation: { id: options.conversationId } } : {}),
    x_beat: options.xBeat || undefined,
  };
}

function writeChatSse(res, value) {
  if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeResponseSse(res, value) {
  if (!res.destroyed) res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function runChatCompletion(runtime, config, body, res = null) {
  validateGenerationBody(body, 'chat');
  const artifacts = new Artifacts(config);
  const created = now();
  const id = store.objectId('chatcmpl');
  const warnings = [];
  if (body.tools?.length) warnings.push('tools_described_but_not_executed');
  if (['temperature', 'top_p', 'seed', 'logprobs', 'frequency_penalty', 'presence_penalty'].some((key) => body[key] !== undefined)) {
    warnings.push('sampling_parameters_not_forwarded');
  }
  try {
    const prompt = await buildPrompt(body.messages, artifacts, {
      tools: body.tools,
      responseFormat: body.response_format,
    });
    const beatConversationId = body.conversation_id || body.metadata?.beat_conversation_id || null;
    let streamed = '';
    let keepAlive;
    if (res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      writeChatSse(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }],
      });
      keepAlive = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
    }
    const result = await runtime.chat({
      prompt,
      attachments: artifacts.attachments,
      model: body.model,
      effort: effortFromBody(body),
      timeoutSeconds: Number(body.timeout || body.timeout_seconds) || undefined,
      beatConversationId,
      plain: Boolean(res),
      onPartial: res ? (current) => {
        const common = longestCommonPrefix(streamed, current);
        if (common !== streamed.length) return;
        const delta = current.slice(streamed.length);
        if (!delta) return;
        streamed = current;
        writeChatSse(res, {
          id, object: 'chat.completion.chunk', created, model: body.model,
          choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }],
        });
      } : null,
    });
    if (keepAlive) clearInterval(keepAlive);
    const text = res ? result.answer_plain : result.answer_markdown;
    const usage = chatUsage(prompt, text);
    const completion = {
      id,
      object: 'chat.completion',
      created,
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text, refusal: null, annotations: [] },
        logprobs: null,
        finish_reason: 'stop',
      }],
      usage,
      service_tier: 'default',
      system_fingerprint: null,
      x_beat: {
        conversation_id: result.conversation_id,
        model_title: result.model_title,
        reasoning_effort: result.reasoning_effort,
        elapsed_seconds: result.elapsed_seconds,
        warnings,
        usage_estimated: true,
      },
    };
    await store.mutateState((state) => {
      state.chat_completions[id] = completion;
    });
    if (res) {
      if (text.startsWith(streamed)) {
        const remainder = text.slice(streamed.length);
        if (remainder) writeChatSse(res, {
          id, object: 'chat.completion.chunk', created, model: result.model,
          choices: [{ index: 0, delta: { content: remainder }, logprobs: null, finish_reason: null }],
        });
      }
      writeChatSse(res, {
        id, object: 'chat.completion.chunk', created, model: result.model,
        choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
        ...(body.stream_options?.include_usage ? { usage } : {}),
      });
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return completion;
  } catch (error) {
    if (res?.headersSent) {
      const exposed = publicError(error).body;
      writeChatSse(res, exposed);
      res.write('data: [DONE]\n\n');
      res.end();
      return null;
    }
    throw error;
  } finally {
    artifacts.cleanup();
  }
}

async function resolveResponseContinuation(body) {
  if (body.previous_response_id && body.conversation) {
    apiError(400, 'previous_response_id와 conversation은 함께 사용할 수 없습니다.', { param: 'conversation' });
  }
  let beatConversationId = null;
  let conversationRecord = null;
  const state = store.loadState();
  if (body.previous_response_id) {
    const previous = state.responses[body.previous_response_id];
    if (!previous) apiError(404, `이전 응답을 찾을 수 없습니다: ${body.previous_response_id}`, { param: 'previous_response_id', code: 'response_not_found' });
    beatConversationId = previous._beat_conversation_id || null;
  }
  if (body.conversation) {
    const conversationId = typeof body.conversation === 'string' ? body.conversation : body.conversation.id;
    conversationRecord = state.conversations[conversationId];
    if (!conversationRecord) apiError(404, `대화를 찾을 수 없습니다: ${conversationId}`, { param: 'conversation', code: 'conversation_not_found' });
    beatConversationId = conversationRecord._beat_conversation_id || null;
  }
  return { beatConversationId, conversationRecord };
}

async function runResponse(runtime, config, body, res = null) {
  validateGenerationBody(body, 'response');
  const artifacts = new Artifacts(config);
  const id = store.objectId('resp');
  const messageId = store.objectId('msg');
  const createdAt = now();
  let keepAlive;
  try {
    const continuation = await resolveResponseContinuation(body);
    let messages = normalizeMessages(body.input ?? '');
    if (continuation.conversationRecord && !continuation.beatConversationId) {
      const previousItems = continuation.conversationRecord.items || [];
      messages = [
        ...previousItems.filter((item) => item.type === 'message').map((item) => ({ role: item.role, content: item.content })),
        ...messages,
      ];
    }
    const prompt = await buildPrompt(messages, artifacts, {
      instructions: body.instructions,
      tools: body.tools,
      responseFormat: body.text?.format,
    });
    let streamed = '';
    let sequence = 0;
    const baseOptions = {
      id,
      messageId,
      createdAt,
      status: 'in_progress',
      model: body.model,
      instructions: body.instructions,
      maxOutputTokens: body.max_output_tokens,
      previousResponseId: body.previous_response_id,
      effort: effortFromBody(body),
      store: body.store,
      temperature: body.temperature,
      textConfig: body.text,
      toolChoice: body.tool_choice,
      tools: body.tools,
      topP: body.top_p,
      truncation: body.truncation,
      metadata: body.metadata,
      conversationId: continuation.conversationRecord?.id,
    };
    if (res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      writeResponseSse(res, {
        type: 'response.created',
        response: createResponseObject(baseOptions),
        sequence_number: sequence++,
      });
      writeResponseSse(res, {
        type: 'response.output_item.added', output_index: 0,
        item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        sequence_number: sequence++,
      });
      writeResponseSse(res, {
        type: 'response.content_part.added', item_id: messageId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        sequence_number: sequence++,
      });
      keepAlive = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
    }
    const result = await runtime.chat({
      prompt,
      attachments: artifacts.attachments,
      model: body.model,
      effort: effortFromBody(body),
      timeoutSeconds: Number(body.timeout || body.timeout_seconds) || undefined,
      beatConversationId: continuation.beatConversationId,
      plain: Boolean(res),
      onPartial: res ? (current) => {
        const common = longestCommonPrefix(streamed, current);
        if (common !== streamed.length) return;
        const delta = current.slice(streamed.length);
        if (!delta) return;
        streamed = current;
        writeResponseSse(res, {
          type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0,
          delta, logprobs: [], sequence_number: sequence++,
        });
      } : null,
    });
    if (keepAlive) clearInterval(keepAlive);
    const text = res ? result.answer_plain : result.answer_markdown;
    const usage = usageFor(prompt, text);
    const response = createResponseObject({
      ...baseOptions,
      status: 'completed',
      model: result.model,
      text,
      usage,
      effort: result.reasoning_effort,
      xBeat: {
        conversation_id: result.conversation_id,
        model_title: result.model_title,
        elapsed_seconds: result.elapsed_seconds,
        usage_estimated: true,
        warnings: body.tools?.length ? ['tools_described_but_not_executed'] : [],
      },
    });
    const inputItems = inputItemsFromMessages(normalizeMessages(body.input ?? ''));
    await store.mutateState((state) => {
      state.responses[id] = {
        ...response,
        _beat_conversation_id: result.conversation_id,
        _input_items: inputItems,
      };
      if (continuation.conversationRecord) {
        const record = state.conversations[continuation.conversationRecord.id];
        if (record) {
          record._beat_conversation_id = result.conversation_id;
          record.items.push(...inputItems, response.output[0]);
          record.updated_at = now();
        }
      }
    });
    if (res) {
      if (text.startsWith(streamed)) {
        const remainder = text.slice(streamed.length);
        if (remainder) writeResponseSse(res, {
          type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0,
          delta: remainder, logprobs: [], sequence_number: sequence++,
        });
      }
      writeResponseSse(res, {
        type: 'response.output_text.done', item_id: messageId, output_index: 0, content_index: 0,
        text, logprobs: [], sequence_number: sequence++,
      });
      writeResponseSse(res, {
        type: 'response.content_part.done', item_id: messageId, output_index: 0, content_index: 0,
        part: response.output[0].content[0], sequence_number: sequence++,
      });
      writeResponseSse(res, {
        type: 'response.output_item.done', output_index: 0,
        item: response.output[0], sequence_number: sequence++,
      });
      writeResponseSse(res, {
        type: 'response.completed', response, sequence_number: sequence++,
      });
      res.end();
    }
    return response;
  } catch (error) {
    if (keepAlive) clearInterval(keepAlive);
    if (res?.headersSent) {
      const exposed = publicError(error);
      writeResponseSse(res, {
        type: 'response.failed',
        response: createResponseObject({ id, messageId, createdAt, status: 'failed', model: body.model }),
        error: exposed.body.error,
        sequence_number: 999999,
      });
      res.end();
      return null;
    }
    throw error;
  } finally {
    artifacts.cleanup();
  }
}

async function parseMultipartUpload(req, config) {
  const maximum = Math.floor(config.max_upload_mb * 1024 * 1024);
  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: maximum, files: 1, fields: 30, fieldSize: 1024 * 1024 },
    });
  } catch (error) {
    apiError(400, `multipart/form-data 요청을 해석하지 못했습니다: ${error.message}`);
  }
  const fields = {};
  let upload = null;
  let filePromise = null;
  return new Promise((resolve, reject) => {
    const failUpload = (error) => {
      if (upload?.directory) store.cleanupTemp(upload.directory);
      reject(error);
    };
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (_name, stream, info) => {
      if (upload) {
        stream.resume();
        return;
      }
      const extension = path.extname(info.filename || '').slice(0, 16).replace(/[^.a-z0-9]/gi, '') || '.bin';
      upload = { ...store.makeTempFile(extension), info, truncated: false };
      const writer = fs.createWriteStream(upload.filename, { mode: 0o600, flags: 'wx' });
      stream.on('limit', () => { upload.truncated = true; });
      stream.pipe(writer);
      filePromise = new Promise((fileResolve, fileReject) => {
        writer.on('finish', fileResolve);
        writer.on('error', fileReject);
        stream.on('error', fileReject);
      });
    });
    busboy.on('filesLimit', () => failUpload(new ApiError(400, '파일은 요청당 하나만 업로드할 수 있습니다.')));
    busboy.on('error', failUpload);
    busboy.on('close', async () => {
      try {
        if (!upload || !filePromise) apiError(400, 'file 필드가 필요합니다.', { param: 'file' });
        await filePromise;
        if (upload.truncated) apiError(413, `파일은 ${config.max_upload_mb} MiB까지 업로드할 수 있습니다.`, { code: 'file_too_large' });
        const purpose = fields.purpose || 'user_data';
        const validPurposes = ['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'];
        if (!validPurposes.includes(purpose)) apiError(400, `지원하지 않는 purpose입니다: ${purpose}`, { param: 'purpose' });
        const object = await store.storeUploadedFile(upload.filename, {
          filename: upload.info.filename,
          mimeType: upload.info.mimeType,
          purpose,
          expiresAfterSeconds: fields['expires_after[seconds]'],
        });
        upload = null;
        resolve(object);
      } catch (error) {
        failUpload(error);
      }
    });
    req.pipe(busboy);
  });
}

async function handleModels(runtime, req, res, pathname) {
  const models = await runtime.models();
  const objects = models.map((model) => ({
    id: model.key,
    object: 'model',
    created: 0,
    owned_by: 'beat-busanedu',
    x_beat: {
      title: model.title,
      reasoning_efforts: model.efforts,
      default_reasoning_effort: model.default_effort,
    },
  }));
  if (pathname === '/v1/models') return json(res, 200, { object: 'list', data: objects });
  const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
  const found = objects.find((model) => model.id === id);
  if (!found) apiError(404, `모델을 찾을 수 없습니다: ${id}`, { param: 'model', code: 'model_not_found' });
  return json(res, 200, found);
}

async function handleFiles(config, req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/v1/files' && req.method === 'POST') {
    return json(res, 200, await parseMultipartUpload(req, config));
  }
  if (pathname === '/v1/files' && req.method === 'GET') {
    return json(res, 200, store.listStoredFiles({
      purpose: url.searchParams.get('purpose'),
      limit: url.searchParams.get('limit'),
      order: url.searchParams.get('order'),
      after: url.searchParams.get('after'),
    }));
  }
  const match = pathname.match(/^\/v1\/files\/([^/]+)(\/content)?$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const found = store.getStoredFile(id);
  if (!found) apiError(404, `파일을 찾을 수 없습니다: ${id}`, { code: 'file_not_found' });
  if (req.method === 'GET' && match[2]) {
    const stat = fs.statSync(found.path);
    res.writeHead(200, {
      'Content-Type': found.metadata.mime_type || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.object.filename)}`,
    });
    fs.createReadStream(found.path).pipe(res);
    return true;
  }
  if (req.method === 'GET') return json(res, 200, found.object);
  if (req.method === 'DELETE') {
    await store.deleteStoredFile(id);
    return json(res, 200, { id, object: 'file', deleted: true });
  }
  return false;
}

async function handleConversations(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/v1/conversations' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const record = {
      id: store.objectId('conv'),
      object: 'conversation',
      created_at: now(),
      updated_at: now(),
      metadata: body.metadata || {},
      items: inputItemsFromMessages(normalizeMessages(body.items || [])),
      _beat_conversation_id: null,
    };
    await store.mutateState((state) => { state.conversations[record.id] = record; });
    return json(res, 200, publicConversation(record));
  }
  if (pathname === '/v1/conversations' && req.method === 'GET') {
    const all = Object.values(store.loadState().conversations).map(publicConversation);
    const page = paginate(all, url.searchParams);
    return json(res, 200, listObject(page.rows, page.hasMore));
  }
  const match = pathname.match(/^\/v1\/conversations\/([^/]+)(?:\/items(?:\/([^/]+))?)?$/);
  if (!match) return false;
  const conversationId = decodeURIComponent(match[1]);
  const itemId = match[2] ? decodeURIComponent(match[2]) : null;
  const record = store.loadState().conversations[conversationId];
  if (!record) apiError(404, `대화를 찾을 수 없습니다: ${conversationId}`, { code: 'conversation_not_found' });
  const isItemsPath = pathname.includes('/items');
  if (!isItemsPath && req.method === 'GET') return json(res, 200, publicConversation(record));
  if (!isItemsPath && req.method === 'POST') {
    const body = await readJsonBody(req);
    await store.mutateState((state) => {
      state.conversations[conversationId].metadata = body.metadata || state.conversations[conversationId].metadata;
      state.conversations[conversationId].updated_at = now();
    });
    return json(res, 200, publicConversation(store.loadState().conversations[conversationId]));
  }
  if (!isItemsPath && req.method === 'DELETE') {
    await store.mutateState((state) => { delete state.conversations[conversationId]; });
    return json(res, 200, { id: conversationId, object: 'conversation.deleted', deleted: true });
  }
  if (isItemsPath && !itemId && req.method === 'POST') {
    const body = await readJsonBody(req);
    const incoming = body.items || [body];
    const items = inputItemsFromMessages(normalizeMessages(incoming));
    await store.mutateState((state) => {
      state.conversations[conversationId].items.push(...items);
      state.conversations[conversationId].updated_at = now();
    });
    return json(res, 200, listObject(items));
  }
  if (isItemsPath && !itemId && req.method === 'GET') {
    const items = [...record.items];
    const page = paginate(items, url.searchParams);
    return json(res, 200, listObject(page.rows, page.hasMore));
  }
  const item = record.items.find((candidate) => candidate.id === itemId);
  if (!item) apiError(404, `대화 항목을 찾을 수 없습니다: ${itemId}`, { code: 'item_not_found' });
  if (req.method === 'GET') return json(res, 200, item);
  if (req.method === 'DELETE') {
    await store.mutateState((state) => {
      state.conversations[conversationId].items = state.conversations[conversationId].items.filter((candidate) => candidate.id !== itemId);
    });
    return json(res, 200, publicConversation(store.loadState().conversations[conversationId]));
  }
  return false;
}

async function handleStoredResponses(req, res, url) {
  if (url.pathname === '/v1/responses' && req.method === 'GET') {
    const rows = Object.values(store.loadState().responses).map(stripInternal);
    const page = paginate(rows, url.searchParams);
    return json(res, 200, listObject(page.rows, page.hasMore));
  }
  const match = url.pathname.match(/^\/v1\/responses\/([^/]+)(?:\/(input_items|cancel))?$/);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const record = store.loadState().responses[id];
  if (!record) apiError(404, `응답을 찾을 수 없습니다: ${id}`, { code: 'response_not_found' });
  if (match[2] === 'input_items' && req.method === 'GET') {
    const page = paginate([...(record._input_items || [])], url.searchParams);
    return json(res, 200, listObject(page.rows, page.hasMore));
  }
  if (match[2] === 'cancel' && req.method === 'POST') return json(res, 200, stripInternal(record));
  if (!match[2] && req.method === 'GET') return json(res, 200, stripInternal(record));
  if (!match[2] && req.method === 'DELETE') {
    await store.mutateState((state) => { delete state.responses[id]; });
    return json(res, 200, { id, object: 'response', deleted: true });
  }
  return false;
}

function stripInternal(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_')));
}

async function handleChatStorage(req, res, url) {
  const match = url.pathname.match(/^\/v1\/chat\/completions(?:\/([^/]+))?$/);
  if (!match || (req.method !== 'GET' && req.method !== 'DELETE')) return false;
  const records = store.loadState().chat_completions;
  if (!match[1]) {
    const page = paginate(Object.values(records), url.searchParams);
    return json(res, 200, listObject(page.rows, page.hasMore));
  }
  const id = decodeURIComponent(match[1]);
  if (!records[id]) apiError(404, `채팅 완료를 찾을 수 없습니다: ${id}`, { code: 'completion_not_found' });
  if (req.method === 'GET') return json(res, 200, records[id]);
  await store.mutateState((state) => { delete state.chat_completions[id]; });
  return json(res, 200, { id, object: 'chat.completion.deleted', deleted: true });
}

async function route(runtime, config, req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  url.pathname = pathname;
  setCors(res, config);
  res.setHeader('X-Request-ID', `req_${crypto.randomBytes(12).toString('base64url')}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if ((pathname === '/health' || pathname === '/v1/health') && req.method === 'GET') {
    return json(res, 200, {
      status: 'ok',
      service: 'beat-openai-gateway',
      version: VERSION,
      browser: runtime.browser?.isConnected() ? 'ready' : 'cold',
      active_requests: runtime.semaphore.active,
      queued_requests: runtime.semaphore.waiters.length,
    });
  }
  if (pathname === '/' && req.method === 'GET') {
    return json(res, 200, {
      name: 'BeAT OpenAI-compatible gateway',
      version: VERSION,
      base_url: '/v1',
      endpoints: ['models', 'chat/completions', 'responses', 'files', 'conversations'],
    });
  }
  authenticate(req, config);

  if (req.method === 'GET' && (pathname === '/v1/models' || pathname.startsWith('/v1/models/'))) {
    return handleModels(runtime, req, res, pathname);
  }
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.stream) return runChatCompletion(runtime, config, body, res);
    return json(res, 200, await runChatCompletion(runtime, config, body));
  }
  if (pathname === '/v1/responses' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.stream) return runResponse(runtime, config, body, res);
    return json(res, 200, await runResponse(runtime, config, body));
  }
  if (pathname === '/v1/responses/input_tokens' && req.method === 'POST') {
    const body = await readJsonBody(req);
    return json(res, 200, { object: 'response.input_tokens', input_tokens: estimateTokens(responseInputText(body.input)) });
  }
  if (pathname === '/v1/completions' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.model) apiError(400, 'model 필드가 필요합니다.', { param: 'model' });
    const messages = [{ role: 'user', content: Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt }];
    const chatBody = { ...body, messages, stream: Boolean(body.stream) };
    if (chatBody.stream) return runChatCompletion(runtime, config, chatBody, res);
    const completion = await runChatCompletion(runtime, config, chatBody);
    return json(res, 200, {
      id: completion.id.replace('chatcmpl_', 'cmpl_'), object: 'text_completion',
      created: completion.created, model: completion.model,
      choices: [{ text: completion.choices[0].message.content, index: 0, logprobs: null, finish_reason: 'stop' }],
      usage: completion.usage,
      x_beat: completion.x_beat,
    });
  }
  if (pathname.startsWith('/v1/files')) {
    const handled = await handleFiles(config, req, res, url);
    if (handled !== false) return handled;
  }
  if (pathname.startsWith('/v1/conversations')) {
    const handled = await handleConversations(req, res, url);
    if (handled !== false) return handled;
  }
  if (pathname.startsWith('/v1/responses/')) {
    const handled = await handleStoredResponses(req, res, url);
    if (handled !== false) return handled;
  }
  if (pathname.startsWith('/v1/chat/completions')) {
    const handled = await handleChatStorage(req, res, url);
    if (handled !== false) return handled;
  }
  apiError(404, `지원하지 않는 엔드포인트입니다: ${req.method} ${pathname}`, { code: 'not_found' });
}

async function main() {
  store.ensureApiDirs();
  const config = store.loadServiceConfig({ create: true });
  const runtime = new BeatRuntime(config);
  const server = http.createServer((req, res) => {
    route(runtime, config, req, res).catch((error) => {
      const exposed = publicError(error);
      process.stderr.write(`[beat] ${req.method} ${req.url}: ${error.stack || error.message}\n`);
      if (!res.headersSent) {
        setCors(res, config);
        json(res, exposed.status, exposed.body);
      } else if (!res.destroyed) {
        res.end();
      }
    });
  });
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  const shutdown = async (signal) => {
    process.stderr.write(`[beat] ${signal}: 서비스를 종료합니다.\n`);
    server.close();
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

  await runtime.ensureBrowser();
  server.listen(config.port, config.host, () => {
    process.stderr.write(`[beat] OpenAI 호환 서비스: http://${config.host}:${config.port}/v1\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`BeAT 서비스 시작 실패: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  ApiError,
  BeatRuntime,
  Artifacts,
  buildPrompt,
  runChatCompletion,
  runResponse,
  main,
};
