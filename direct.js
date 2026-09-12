'use strict';

// The same authenticated HTTP operations used by the BeAT web client.
// No browser, JavaScript evaluation, or server-side tool execution is performed here.
const { request } = require('playwright-core');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parseModelCatalog } = require('./model-catalog');
const core = () => require('./core');
const ORIGIN = 'https://beat.busanedu.net';
const ONEPASS = 'https://edupass.neisplus.kr';
const DIRECTLINE = 'https://directline.botframework.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const actionCache = { actions: null, at: 0 };
const ACTION_NAMES = new Set([
  'createConversation', 'createAssistantSession', 'persistReceivedActivity',
  'prepareAttachmentUpload', 'validateAiWorkerUsage', 'listMultiLLMSettings', 'listAssistantChatModels',
]);
// Lazy-loaded chat chunks are not in the initial page. These four references
// were verified against actual web-client traffic; named discovery overrides them.
const LAZY_ACTIONS = {
  validateAiWorkerUsage: '40aed3429d0928eed893982b1a99e6b1363eaf4bbc',
  prepareAttachmentUpload: '402d1da23b8d60064145d3ec4170b775b069e5ad92',
  createAssistantSession: '4090fb9c0e8c75dfe3175f4ed0a7e3e8828369c18c',
  persistReceivedActivity: '405691bc2d6f405f1bcdff06e96e013d97d1075e6f',
};

class HttpClient extends EventEmitter {
  constructor() { super(); this.isDirect = true; this.contexts = new Set(); this.connected = true; }
  isConnected() { return this.connected; }
  async newContext(options = {}) {
    const api = await request.newContext({ storageState: options.storageState, userAgent: USER_AGENT, timeout: 30000 });
    const context = {
      isDirect: true, request: api,
      storageState: () => api.storageState(),
      close: async () => { this.contexts.delete(context); await api.dispose(); },
    };
    this.contexts.add(context);
    return context;
  }
  async close() { this.connected = false; await Promise.all([...this.contexts].map(c => c.close())); this.emit('disconnected'); }
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function unescape(value) {
  return String(value).replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e]));
}
function encryptPassword(password, salt = crypto.randomBytes(8)) {
  // CryptoJS passphrase format used by the OnePass login form, over HTTPS.
  let material = Buffer.alloc(0), previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from('onepass987655432'), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  const cipher = crypto.createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(password, 'utf8'), cipher.final()]).toString('base64');
}
function envelope(parameters = {}, dataset = '') {
  const values = { jsessionidTest: '', ...parameters, svcId: '', voId: '', method: '' };
  return `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters>${
    Object.entries(values).map(([id, value]) => `<Parameter id="${id}">${xmlEscape(value)}</Parameter>`).join('')
  }</Parameters>${dataset}</Root>`;
}
function xmlValue(xml, tag, id) {
  return xml.match(new RegExp(`<${tag}\\s+id=["']${id}["'][^>]*>([\\s\\S]*?)</${tag}>`))?.[1];
}
async function login(client, username, password, options = {}) {
  const context = await client.newContext();
  try {
    options.onProgress?.('교육디지털원패스 HTTP 로그인 중...');
    const callback = core().buildChatUrl(core().DEFAULT_SETTINGS.model, core().DEFAULT_SETTINGS.reasoning_effort);
    await context.request.get(`${ORIGIN}/auth/login?callbackUrl=${encodeURIComponent(callback)}`);
    const initiation = await context.request.get(`${ORIGIN}/api/auth/edupass/initiate`);
    const html = await initiation.text();
    const secret = html.match(/name=["']secretKey["'][^>]*value=["']([^"']+)["']/i)?.[1];
    if (!secret) core().fail('원패스 로그인 초기화 형식이 변경되었습니다.', 2, 'LOGIN_FAILED');
    const bootstrap = await context.request.post(`${ONEPASS}/BEAT/login.do`, {
      form: { secretKey: unescape(secret) }, headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` },
    });
    if (!bootstrap.ok()) core().fail(`원패스 초기화 실패 (HTTP ${bootstrap.status()}).`, 2, 'LOGIN_FAILED');
    const post = async (route, data) => {
      const response = await context.request.post(`${ONEPASS}${route}`, {
        data, headers: { 'Content-Type': 'text/xml; charset=UTF-8', Referer: `${ONEPASS}/BEAT/login.do`,
          Accept: 'application/xml, text/xml, */*', 'Accept-Language': 'ko-KR',
          'Cache-Control': 'no-cache, no-store', 'X-Requested-With': 'Fetch', UI: 'nexacro' },
      });
      const text = await response.text();
      const code = xmlValue(text, 'Parameter', 'ErrorCode');
      if (!response.ok() || (code != null && code !== '0')) {
        core().fail(`원패스 인증 단계 실패 (HTTP ${response.status()}${code ? `, 코드 ${code}` : ''}).`, 2, 'LOGIN_FAILED');
      }
      return text;
    };
    await post('/edu/intelliframe/core/web/getMessageInitAll.do', envelope());
    await post('/edo_edo_am01_003.do', envelope());
    const state = await context.storageState();
    const parameters = {};
    for (const name of ['WMONID', 'JSESSIONID', 'ROUTEID']) {
      const cookie = state.cookies.find(c => c.name === name && (c.domain === 'edupass.neisplus.kr' || c.domain === '.neisplus.kr'));
      if (!cookie) core().fail('원패스 로그인 세션을 만들지 못했습니다.', 2, 'LOGIN_FAILED');
      parameters[name] = cookie.value;
    }
    await post('/edo_edo_am01_003.do', envelope(parameters));
    await post('/edo_edo_ep03_005.do', envelope(parameters, '<Dataset id="dsParam"><ColumnInfo><Column id="ntcMteTitlNm" type="STRING" size="256"/><Column id="ntcMteCn" type="STRING" size="256"/></ColumnInfo><Rows/></Dataset>'));
    const columns = ['userDtcNo', 'userId', 'userPswd', 'eduDgtlOpsUserScCd', 'lgnMthScCd', 'cntnDvcsClfCd', 'autoLoginYn', 'mhrlsNo', 'shlCd'];
    const values = { userId: username, userPswd: encryptPassword(password), eduDgtlOpsUserScCd: '1', lgnMthScCd: '01', cntnDvcsClfCd: '30', autoLoginYn: 'N', mhrlsNo: 'null' };
    const dataset = `<Dataset id="dsSearch"><ColumnInfo>${columns.map(id => `<Column id="${id}" type="STRING" size="256"/>`).join('')}</ColumnInfo><Rows><Row>${Object.entries(values).map(([id, value]) => `<Col id="${id}">${xmlEscape(value)}</Col>`).join('')}</Row></Rows></Dataset>`;
    const result = await post('/edo_edo_li01_002.do', envelope(parameters, dataset));
    if (xmlValue(result, 'Col', 'loginYN') !== 'Y') core().fail('원패스에서 로그인을 거부했습니다. 아이디와 비밀번호를 확인하세요.', 2, 'LOGIN_FAILED');
    await context.request.get(`${ONEPASS}/test_edo_edo_of01_002.do?siteId=BEAT`);
    const session = await core().getSession(context);
    if (!session) core().fail('원패스 인증 후 BeAT 세션이 생성되지 않았습니다.', 2, 'LOGIN_FAILED');
    await core().writeBeatSession(context);
    if (options.storeCredentials) core().saveCredentials(username, password);
    return session;
  } finally { await context.close(); }
}

// Flight text records are byte-length delimited, including records containing newlines.
function flightRecords(text) {
  const data = Buffer.from(text);
  const records = new Map();
  let offset = 0;
  while (offset < data.length) {
    if (data[offset] === 10) { offset++; continue; }
    const colon = data.indexOf(58, offset);
    if (colon < 0) break;
    const id = data.subarray(offset, colon).toString();
    if (!/^[0-9a-f]+$/i.test(id)) {
      const newline = data.indexOf(10, offset); offset = newline < 0 ? data.length : newline + 1; continue;
    }
    if (data[colon + 1] === 84) {
      const comma = data.indexOf(44, colon + 2);
      const lengthText = data.subarray(colon + 2, comma).toString();
      if (comma < 0 || !/^[0-9a-f]+$/i.test(lengthText)) throw new Error('Invalid Flight text length');
      const end = comma + 1 + parseInt(lengthText, 16);
      if (end > data.length) throw new Error('Truncated Flight text');
      records.set(id, data.subarray(comma + 1, end).toString('utf8'));
      offset = end;
    } else {
      const newline = data.indexOf(10, colon + 1);
      const end = newline < 0 ? data.length : newline;
      const raw = data.subarray(colon + 1, end).toString();
      if (raw.startsWith('E{')) records.set(id, { flightError: true });
      else { try { records.set(id, JSON.parse(raw)); } catch { /* Non-data Flight records. */ } }
      offset = end + 1;
    }
  }
  return records;
}
function flightText(html) {
  return [...html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?])\)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1])[1] || ''; } catch { return ''; } }).join('');
}
function parseBootstrap(html) {
  const flight = flightText(html), records = flightRecords(flight);
  const resolve = value => typeof value === 'string' && /^\$[0-9a-f]+$/i.test(value) ? records.get(value.slice(1)) : value;
  let found;
  const walk = value => {
    if (!value || typeof value !== 'object' || found) return;
    if (value.directLine && value.user) {
      found = { ...value.directLine, token: resolve(value.directLine.token), streamUrl: resolve(value.directLine.streamUrl),
        user: { ...value.user, accessToken: resolve(value.user.accessToken) } };
      return;
    }
    Object.values(value).forEach(walk);
  };
  [...records.values()].forEach(walk);
  if (!found?.token || !found.user?.accessToken || !/^[A-Za-z0-9_-]{8,160}$/.test(found.conversationId)) core().fail('BeAT Direct Line 초기화 형식이 변경되었습니다.', 3, 'SITE_CHANGED');
  return found;
}
async function pageText(context, url) {
  const response = await context.request.get(url);
  if ([401, 403].includes(response.status()) || new URL(response.url()).pathname.startsWith('/auth/')) core().fail('BeAT 세션이 만료되었습니다.', 2, 'SESSION_EXPIRED');
  if (!response.ok()) core().fail(`BeAT 조회 실패 (HTTP ${response.status()}).`, 3, 'NETWORK');
  return response.text();
}
async function discover(context) {
  if (actionCache.actions && Date.now() - actionCache.at < 3600000) return actionCache.actions;
  const html = await pageText(context, core().buildChatUrl(core().DEFAULT_SETTINGS.model, core().DEFAULT_SETTINGS.reasoning_effort));
  const sources = [...new Set([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]))].filter(s => s.startsWith('/_next/static/')).slice(0, 80);
  const actions = { ...LAZY_ACTIONS };
  // Bound asset requests; action names are a fixed list of normal chat operations.
  for (let i = 0; i < sources.length; i += 4) {
    await Promise.all(sources.slice(i, i + 4).map(async source => {
      const text = await pageText(context, `${ORIGIN}${source}`);
      for (const m of text.matchAll(/createServerReference\)?\)?\(\s*["']([0-9a-f]{40,42})["'][\s\S]{0,320}?["']([A-Za-z][A-Za-z0-9_]*)["']\s*\)/g)) {
        if (ACTION_NAMES.has(m[2])) actions[m[2]] = m[1];
      }
    }));
  }
  actionCache.actions = actions; actionCache.at = Date.now();
  return actions;
}
async function action(context, name, args, route) {
  const id = (await discover(context))[name];
  if (!id) core().fail(`BeAT 채팅 액션을 찾지 못했습니다: ${name}`, 3, 'SITE_CHANGED');
  const response = await context.request.post(route, {
    data: JSON.stringify(args), headers: { Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': id, Origin: ORIGIN },
  });
  if ([401, 403].includes(response.status()) || new URL(response.url()).pathname.startsWith('/auth/')) core().fail('BeAT 세션이 만료되었습니다.', 2, 'SESSION_EXPIRED');
  if (!response.ok()) core().fail(`BeAT ${name} 실패 (HTTP ${response.status()}).`, 3, 'NETWORK');
  const value = flightRecords(await response.text()).get('1');
  if (value === undefined || value?.flightError) core().fail(`BeAT ${name} 응답 형식이 변경되었거나 요청이 거부되었습니다.`, 3, 'SITE_CHANGED');
  return value;
}
async function models(context) {
  const route = core().buildChatUrl(core().DEFAULT_SETTINGS.model, core().DEFAULT_SETTINGS.reasoning_effort);
  const html = await pageText(context, route);
  const catalog = parseModelCatalog(html);
  if (!catalog.length) core().fail('BeAT 모델 목록을 읽지 못했습니다.', 3, 'SITE_CHANGED');
  const settings = await action(context, 'listMultiLLMSettings', [], route);
  if (!Array.isArray(settings)) core().fail('BeAT 활성 모델 설정을 읽지 못했습니다.', 3, 'SITE_CHANGED');
  const enabled = new Set(settings.flatMap(group => (group.llm_models || []).filter(model => model.enabled === true).map(model => model.key)));
  const available = catalog.filter(model => enabled.has(model.key));
  if (!available.length) core().fail('현재 계정에서 활성화된 BeAT 모델이 없습니다.', 3, 'SITE_CHANGED');
  return available;
}

function activityText(item) {
  return item.channelData?.contentData?.body || item.text || item.attachments?.[0]?.content?.text || '';
}
function startActivity(bootstrap, prompt, model, effort, continuation = false, apiMode = false) {
  return {
    name: 'startConversation', type: 'event',
    value: {
      user_input: prompt,
      params: { category_path: '개인GPT/개인 도우미', reset_session: true, session_data: '{}',
        use_attachments: true, hide_start_message: true, new_assistant_enabled: !apiMode },
      channel: 'webapp', token: bootstrap.user.accessToken, postMessage: prompt,
      category_paths: '[]', attachments: '[]', answer_model: model,
      ...(effort ? { reasoning_effort: effort } : {}),
    },
    channelData: { clientActivityID: `r_${crypto.randomBytes(8).toString('hex')}` },
    channelId: 'webchat', from: { id: bootstrap.user.id, name: bootstrap.user.name, role: 'user' },
    locale: 'ko-KR', localTimestamp: new Date().toISOString(), localTimezone: 'Asia/Seoul',
    entities: [{ requiresBotState: true, supportsListening: true, supportsTts: true, type: 'ClientCapabilities' }],
  };
}
function continuationActivities(bootstrap, prompt, model, effort, apiMode) {
  const start = startActivity(bootstrap, prompt, model, effort, true, apiMode);
  const { params, channel, token } = start.value;
  start.value = { params, channel, token };
  const message = {
    ...start, type: 'message', text: prompt, textFormat: 'plain', attachments: [],
    value: { user_input: prompt, params, channel },
    channelData: { answer_model: model, ...(effort ? { reasoning_effort: effort } : {}),
      attachmentSizes: [], clientActivityID: `r_${crypto.randomBytes(8).toString('hex')}` },
  };
  delete message.name;
  delete message.entities;
  return [start, message];
}
function pause(milliseconds, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function chat(context, message, options = {}) {
  const started = Date.now();
  const settings = core().loadSettings();
  const model = core().resolveModel(options.model || settings.model, await models(context));
  const effort = core().resolveEffort(options.effort ?? settings.reasoning_effort, model, options.effortExplicit);
  const deadline = Date.now() + (options.timeoutSeconds || settings.timeout_seconds) * 1000;
  const check = () => {
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) core().fail('BeAT 답변 시간이 초과되었습니다.', 3, 'ANSWER_TIMEOUT');
  };
  let route = core().buildChatUrl(model.key, effort);
  const quota = await action(context, 'validateAiWorkerUsage', ['개인GPT'], route);
  if (quota?.success === false) core().fail('BeAT 사용량 제한에 도달했습니다.', 3, 'USAGE_LIMIT');
  let prompt = message;
  for (const filename of options.attachments || []) {
    check();
    const extension = path.extname(filename).slice(1).toLowerCase();
    const file = fs.readFileSync(filename);
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif'].includes(extension) || file.length > 5 * 1024 * 1024) core().fail('이미지는 지원 형식이며 5 MiB 이하여야 합니다.', 1, 'INVALID_ATTACHMENT');
    const upload = await action(context, 'prepareAttachmentUpload', [extension], route);
    const url = new URL(upload.url);
    if (url.protocol !== 'https:' || url.hostname !== 'penbeat.blob.core.windows.net') core().fail('BeAT 이미지 업로드 주소가 올바르지 않습니다.', 3, 'SITE_CHANGED');
    const uploaded = await context.request.put(url.href, { data: file, maxRedirects: 0, headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': `image/${extension === 'jpg' ? 'jpeg' : extension}` } });
    if (!uploaded.ok()) core().fail(`이미지 업로드 실패 (HTTP ${uploaded.status()}).`, 3, 'NETWORK');
    prompt += `<div class="chat-attachment"><chat-attach id="${xmlEscape(upload.fileName)}"/></div>`;
  }
  let conversationId = options.conversationId ? core().validateConversationId(options.conversationId) : null;
  if (!conversationId) {
    const conversation = await action(context, 'createConversation', [{
      category_id: '2', title: message.slice(0, 180), init_question: prompt, init_attachments: [],
      category_paths: [], all_category_title: 'AI 어시스턴트', answer_model: model.key,
      ...(effort ? { reasoning_effort: effort } : {}),
    }], route);
    conversationId = core().validateConversationId(conversation.id);
    route = core().buildChatUrl(model.key, effort, conversationId);
    // Required even when native-assistant mode is disabled: without this
    // BeAT returns "previous conversation could not be loaded" as an answer.
    await action(context, 'createAssistantSession', [{ conversationId, answerModel: model.key }], route);
  } else route = core().buildChatUrl(model.key, effort, conversationId);
  check();
  const bootstrap = parseBootstrap(await pageText(context, route));
  const endpoint = `${DIRECTLINE}/v3/directline/conversations/${bootstrap.conversationId}/activities`;
  // This request context has no BeAT cookies. Direct Line tokens stay on their intended host.
  const transport = await request.newContext({ timeout: 30000 });
  const abortTransport = () => { transport.dispose().catch(() => {}); };
  options.signal?.addEventListener('abort', abortTransport, { once: true });
  const send = async (url, method, data) => {
    check();
    const response = await transport.fetch(url, { method, data, maxRedirects: 0,
      timeout: Math.max(1, Math.min(30000, deadline - Date.now())),
      headers: { Authorization: `Bearer ${bootstrap.token}`, Accept: 'application/json' } });
    return response;
  };
  let text = '', watermark = bootstrap.streamUrl ? new URL(bootstrap.streamUrl).searchParams.get('watermark') : null;
  const seen = new Set();
  try {
    const outgoing = options.conversationId
      ? continuationActivities(bootstrap, prompt, model.key, effort, options.apiMode)
      : [startActivity(bootstrap, prompt, model.key, effort, false, options.apiMode)];
    for (const activity of outgoing) {
      const posted = await send(endpoint, 'POST', activity);
      if (!posted.ok()) core().fail(`BeAT 메시지 전송 실패 (HTTP ${posted.status()}).`, 3, 'NETWORK');
    }
    let backoff = 300, refreshed = false;
    while (true) {
      check();
      const response = await send(`${endpoint}${watermark ? `?watermark=${encodeURIComponent(watermark)}` : ''}`, 'GET');
      if ([401, 403].includes(response.status()) && !refreshed) {
        const refreshedToken = await send(`${DIRECTLINE}/v3/directline/tokens/refresh`, 'POST');
        if (!refreshedToken.ok()) core().fail('BeAT Direct Line 토큰 갱신에 실패했습니다.', 3, 'NETWORK');
        const value = await refreshedToken.json();
        if (!value.token) core().fail('BeAT Direct Line 토큰 갱신 응답이 올바르지 않습니다.', 3, 'NETWORK');
        bootstrap.token = value.token;
        refreshed = true;
        continue;
      }
      if (response.status() === 429 || response.status() >= 500) {
        await pause(Math.min(backoff, Math.max(1, deadline - Date.now())), options.signal);
        backoff = Math.min(backoff * 2, 3000);
        continue;
      }
      if (!response.ok()) core().fail(`BeAT 응답 수신 실패 (HTTP ${response.status()}).`, 3, 'NETWORK');
      backoff = 300;
      const payload = await response.json();
      watermark = payload.watermark ?? watermark;
      for (const item of payload.activities || []) {
        if (item.from?.role === 'user' || (item.id && seen.has(item.id))) continue;
        if (item.id) seen.add(item.id);
        const channel = item.channelData || {}, incoming = activityText(item);
        if (['ERROR_MSG', 'SYSTEM_ERROR_MSG'].includes(channel.messageType)) core().fail('BeAT 모델이 요청을 처리하지 못했습니다.', 3, 'MODEL_ERROR');
        if (typeof incoming !== 'string') continue;
        const final = channel.messageType === 'ANSWER_MSG' && (channel.streamType === 'final' || item.type === 'message');
        if (incoming && (channel.streamType === 'streaming' || final)) {
          // Direct Line messages contain cumulative text, not token deltas.
          text = incoming;
          options.onPartial?.(text);
        }
        if (final && text) {
          const warnings = [];
          try {
            await action(context, 'persistReceivedActivity', [{ category_id: '2', conversation_id: conversationId, activity: item }], route);
          } catch { warnings.push('beat_history_not_persisted'); }
          // A failed history write must not retry a completed generation/tool decision.
          return { answer: text, answer_plain: text, answer_markdown: text, conversation_id: conversationId,
            model: model.key, model_title: model.title, reasoning_effort: effort,
            elapsed_seconds: (Date.now() - started) / 1000, transport: 'directline', warnings };
        }
      }
      await pause(300, options.signal);
    }
  } finally {
    options.signal?.removeEventListener('abort', abortTransport);
    await transport.dispose();
  }
}

module.exports = { HttpClient, login, models, chat, flightRecords, flightText, parseBootstrap, discover, action, encryptPassword, startActivity, continuationActivities, activityText, pause };
