'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

const BASE_URL = 'https://beat.busanedu.net';
const CHAT_PATH = '/ko/chat/ai-worker/2';
const DEFAULT_SETTINGS = Object.freeze({
  model: 'chat_gpt5_6_sol',
  reasoning_effort: 'xhigh',
  timeout_seconds: 600,
  auto_refresh: true,
});
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'beat-cli',
);
const PATHS = Object.freeze({
  configDir: CONFIG_DIR,
  session: path.join(CONFIG_DIR, 'session.json'),
  credentials: path.join(CONFIG_DIR, 'credentials.json'),
  settings: path.join(CONFIG_DIR, 'config.json'),
  refreshLock: path.join(CONFIG_DIR, 'refresh.lock'),
  service: path.join(CONFIG_DIR, 'service.json'),
});
const LOGIN_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_MS = 150_000;
const LOCK_STALE_MS = 5 * 60_000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

class BeatError extends Error {
  constructor(message, exitCode = 1, code = 'BEAT_ERROR') {
    super(message);
    this.name = 'BeatError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

function fail(message, exitCode = 1, code = 'BEAT_ERROR') {
  throw new BeatError(message, exitCode, code);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_DIR, 0o700);
}

function secureWriteJson(filename, value) {
  ensureConfigDir();
  const tempFile = path.join(CONFIG_DIR, `.${path.basename(filename)}-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function readJson(filename, { optional = false, label = '파일' } = {}) {
  try {
    const stat = fs.statSync(filename);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(filename, 0o600);
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.code === 'ENOENT') fail(`${label}이 없습니다.`);
    fail(`${label}을 읽지 못했습니다: ${error.message}`);
  }
}

function removeFile(filename) {
  try {
    fs.unlinkSync(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail(`${filename} 삭제 실패: ${error.message}`);
  }
}

function loadSettings() {
  const saved = readJson(PATHS.settings, { optional: true, label: '설정 파일' }) || {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings(settings) {
  secureWriteJson(PATHS.settings, settings);
}

function loadCredentials({ optional = false } = {}) {
  const credentials = readJson(PATHS.credentials, { optional, label: '저장된 자격 증명' });
  if (!credentials) return null;
  if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
    fail('저장된 자격 증명 형식이 올바르지 않습니다. `beat login <아이디>`를 다시 실행해 주세요.');
  }
  return credentials;
}

function saveCredentials(username, password) {
  secureWriteJson(PATHS.credentials, {
    username,
    password,
    account_type: 'student',
    updated_at: new Date().toISOString(),
  });
}

function loadBeatSession({ optional = false } = {}) {
  return readJson(PATHS.session, { optional, label: '저장된 로그인 세션' });
}

async function writeBeatSession(context) {
  const state = await context.storageState();
  const beatState = {
    cookies: state.cookies.filter((cookie) =>
      cookie.domain === 'beat.busanedu.net' || cookie.domain.endsWith('.beat.busanedu.net')),
    origins: state.origins.filter((origin) => origin.origin === BASE_URL),
  };
  secureWriteJson(PATHS.session, beatState);
}

function findChromium() {
  const candidates = [
    process.env.BEAT_CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!found) fail('Chromium 실행 파일을 찾지 못했습니다. BEAT_CHROMIUM_PATH를 지정해 주세요.');
  return found;
}

async function launchBrowser() {
  return chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=ko-KR',
    ],
  });
}

function contextOptions(storageState) {
  return {
    ...(storageState ? { storageState } : {}),
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1400, height: 1000 },
    userAgent: USER_AGENT,
  };
}

async function newContext(browser, storageState = null) {
  return browser.newContext(contextOptions(storageState));
}

async function getSession(context) {
  const response = await context.request.get(`${BASE_URL}/api/auth/session`, {
    timeout: 30_000,
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    if ([401, 403].includes(response.status())) return null;
    fail(`BeAT 세션 확인 실패(HTTP ${response.status()}).`, 3, 'NETWORK');
  }
  try {
    const session = await response.json();
    return session && session.user ? session : null;
  } catch {
    fail('BeAT 세션 응답을 해석하지 못했습니다.', 3, 'NETWORK');
  }
}

async function performLogin(browser, username, password, options = {}) {
  const { storeCredentials = false, onProgress = () => {} } = options;
  const context = await newContext(browser);
  let lastDialog = '';
  try {
    const page = await context.newPage();
    page.on('dialog', async (dialog) => {
      lastDialog = dialog.message();
      await dialog.accept().catch(() => {});
    });

    onProgress('교육디지털원패스에 로그인 중...');
    const callback = `${CHAT_PATH}?model=${DEFAULT_SETTINGS.model}&reasoning_effort=${DEFAULT_SETTINGS.reasoning_effort}`;
    await page.goto(`${BASE_URL}/auth/login?callbackUrl=${encodeURIComponent(callback)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.locator('[data-testid="auth-provider-card-edupass"]').click({ timeout: 30_000 });
    await page.waitForURL(/https:\/\/edupass\.neisplus\.kr\//, { timeout: 45_000 });

    const studentButton = page.locator('[id$=".divStudent.form.btn00"]:visible');
    await studentButton.waitFor({ state: 'visible', timeout: 45_000 });
    await studentButton.click();

    const idInput = page.locator('input[aria-label="아이디 입력칸"]:visible').first();
    const passwordInput = page.locator('input[aria-label="비밀번호 입력칸"]:visible').first();
    await idInput.waitFor({ state: 'visible', timeout: 30_000 });
    await idInput.fill(username);
    await passwordInput.fill(password);
    await page.locator('[id$=".tabLogin.tpgID.form.btnConfirm"]:visible').click();

    try {
      await page.waitForURL((url) => url.hostname === 'beat.busanedu.net', {
        timeout: LOGIN_TIMEOUT_MS,
      });
    } catch {
      const visibleText = (await page.locator('body').innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 700);
      const detail = lastDialog || visibleText;
      fail(`로그인 완료를 확인하지 못했습니다.${detail ? ` 현재 화면: ${detail}` : ''}`, 2, 'LOGIN_FAILED');
    }

    const session = await getSession(context);
    if (!session) {
      fail('원패스 인증은 끝났지만 BeAT 로그인 세션이 만들어지지 않았습니다.', 2, 'LOGIN_FAILED');
    }
    await writeBeatSession(context);
    if (storeCredentials) saveCredentials(username, password);
    return session;
  } finally {
    await context.close();
  }
}

async function acquireRefreshLock() {
  ensureConfigDir();
  const startedAt = Date.now();
  while (true) {
    try {
      const descriptor = fs.openSync(PATHS.refreshLock, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      fs.closeSync(descriptor);
      return () => removeFile(PATHS.refreshLock);
    } catch (error) {
      if (error.code !== 'EEXIST') fail(`세션 갱신 잠금 생성 실패: ${error.message}`);
      try {
        const stat = fs.statSync(PATHS.refreshLock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          removeFile(PATHS.refreshLock);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        fail('다른 beat 프로세스의 세션 갱신을 기다리다 시간 초과되었습니다.', 2, 'LOCK_TIMEOUT');
      }
      await sleep(500);
    }
  }
}

async function contextFromSavedSession(browser) {
  const state = loadBeatSession({ optional: true });
  if (!state) return { context: null, session: null };
  let context;
  try {
    context = await newContext(browser, state);
  } catch (error) {
    if (error.message.includes('storageState')) return { context: null, session: null };
    throw error;
  }
  try {
    const session = await getSession(context);
    if (session) return { context, session };
  } catch (error) {
    await context.close();
    throw error;
  }
  await context.close();
  return { context: null, session: null };
}

async function ensureAuthenticated(browser, options = {}) {
  const settings = loadSettings();
  const autoRefresh = options.autoRefresh ?? settings.auto_refresh;
  const onProgress = options.onProgress || (() => {});
  const existing = await contextFromSavedSession(browser);
  if (existing.session) return { ...existing, refreshed: false };
  if (!autoRefresh) {
    fail('BeAT 세션이 없거나 만료되었습니다. `beat login <아이디>`를 실행해 주세요.', 2, 'SESSION_EXPIRED');
  }

  const credentials = loadCredentials({ optional: true });
  if (!credentials) {
    fail('세션이 만료되었고 저장된 자격 증명이 없습니다. `beat login <아이디>`를 실행해 주세요.', 2, 'SESSION_EXPIRED');
  }

  onProgress('BeAT 세션이 만료되어 자동 갱신합니다...');
  const release = await acquireRefreshLock();
  try {
    const rechecked = await contextFromSavedSession(browser);
    if (rechecked.session) return { ...rechecked, refreshed: true };
    await performLogin(browser, credentials.username, credentials.password, {
      storeCredentials: false,
      onProgress,
    });
  } finally {
    release();
  }

  const refreshed = await contextFromSavedSession(browser);
  if (!refreshed.session) fail('세션 자동 갱신 후에도 로그인을 확인하지 못했습니다.', 2, 'LOGIN_FAILED');
  onProgress('BeAT 세션 자동 갱신 완료.');
  return { ...refreshed, refreshed: true };
}

async function forceRefresh(browser, onProgress = () => {}) {
  const credentials = loadCredentials();
  const release = await acquireRefreshLock();
  try {
    await performLogin(browser, credentials.username, credentials.password, {
      storeCredentials: false,
      onProgress,
    });
  } finally {
    release();
  }
}

function canonical(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

const STATIC_MODEL_ALIASES = Object.freeze({
  sol: 'chat_gpt5_6_sol',
  terra: 'chat_gpt5_6_terra',
  luna: 'chat_gpt5_6_luna',
  auto: 'chat_model_router',
  router: 'chat_model_router',
  'gpt-5-mini': 'chat_gpt5m',
  'gpt-5-nano': 'chat_gpt5nano',
  'gpt-5.4-mini': 'chat_gpt5_4m',
  'gpt-5.4-nano': 'chat_gpt5_4nano',
  'gpt-4.1-mini': 'chat_gpt4_1m',
  'gpt-4.1-nano': 'chat_gpt4_1nano',
  'gpt-4o-mini': 'chat_gpt4om',
  'o4-mini': 'chat_gpto4m',
});

function modelHint(requested) {
  if (!requested) return DEFAULT_SETTINGS.model;
  const lower = requested.toLowerCase();
  if (STATIC_MODEL_ALIASES[lower]) return STATIC_MODEL_ALIASES[lower];
  if (lower.startsWith('chat_')) return lower;
  return requested;
}

function parseModelCatalog(scriptText) {
  const decoded = scriptText.replace(/\\"/g, '"');
  const pattern = /"(chat_[a-zA-Z0-9_]+)":\{"key":"[^"]+","title":"([^"]+)"[\s\S]*?"reasoning_efforts":\[([^\]]*)\],"reasoning_effort_default":(?:"([^"]*)"|null)/g;
  const models = new Map();
  let match;
  while ((match = pattern.exec(decoded))) {
    if (models.has(match[1])) continue;
    models.set(match[1], {
      key: match[1],
      title: match[2],
      efforts: [...match[3].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
      default_effort: match[4] || null,
    });
  }
  return [...models.values()];
}

async function getModelCatalogFromPage(page) {
  const scripts = (await page.locator('script').allTextContents()).join('\n');
  const models = parseModelCatalog(scripts);
  if (!models.length) fail('사이트에서 사용 가능한 모델 목록을 읽지 못했습니다.', 3, 'SITE_CHANGED');
  return models;
}

function resolveModel(requested, models) {
  const hinted = modelHint(requested);
  const target = canonical(hinted);
  const exact = models.find((model) => model.key === hinted);
  if (exact) return exact;
  const matches = models.filter((model) => {
    const variants = [
      model.key,
      model.key.replace(/^chat_/, ''),
      model.key.replace(/^chat_/, '').replace(/_/g, '-'),
      model.title,
    ];
    return variants.some((variant) => canonical(variant) === target);
  });
  if (matches.length === 1) return matches[0];
  const shortMatches = models.filter((model) => {
    const title = canonical(model.title);
    return target.length >= 3 && (title.endsWith(target) || title === target);
  });
  if (shortMatches.length === 1) return shortMatches[0];
  fail(`알 수 없는 모델 '${requested}'. \`beat models\`로 확인해 주세요.`);
}

function normalizeEffort(value) {
  const aliases = {
    없음: 'none',
    최소: 'minimal',
    낮음: 'low',
    보통: 'medium',
    높음: 'high',
    최고: 'xhigh',
  };
  const lower = String(value || '').toLowerCase();
  return aliases[lower] || lower;
}

function resolveEffort(requested, model, explicit) {
  if (!model.efforts.length) {
    if (explicit && requested && normalizeEffort(requested) !== 'none') {
      fail(`${model.title} 모델은 추론 강도 선택을 지원하지 않습니다.`);
    }
    return null;
  }
  const normalized = normalizeEffort(requested);
  if (model.efforts.includes(normalized)) return normalized;
  if (explicit) fail(`${model.title}의 추론 강도는 ${model.efforts.join(', ')} 중 하나여야 합니다.`);
  return model.default_effort || model.efforts[0];
}

function buildChatUrl(model, effort, conversationId = null) {
  const pathPart = conversationId ? `${CHAT_PATH}/${conversationId}` : CHAT_PATH;
  const url = new URL(pathPart, BASE_URL);
  url.searchParams.set('model', model);
  if (effort) url.searchParams.set('reasoning_effort', effort);
  return url.toString();
}

function validateConversationId(value) {
  if (!value) return null;
  let candidate = value;
  try {
    const url = new URL(value);
    candidate = url.pathname.split('/').filter(Boolean).pop();
  } catch {
    // The input is an ID rather than a URL.
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    fail(`올바르지 않은 대화 ID: ${value}`);
  }
  return candidate;
}

async function setupPage(context) {
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) await route.abort();
    else await route.continue();
  });
  return page;
}

async function navigateChatPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (new URL(page.url()).pathname.startsWith('/auth/login')) {
    fail('BeAT 세션이 만료되었습니다.', 2, 'SESSION_EXPIRED');
  }
  const textarea = page.locator('textarea[placeholder="메시지를 작성하세요."]:visible, textarea:visible').first();
  try {
    await textarea.waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700);
    fail(`채팅 입력창을 찾지 못했습니다.${body ? ` 현재 화면: ${body}` : ''}`, 3, 'SITE_CHANGED');
  }
  return textarea;
}

async function prepareResolvedChatPage(context, requestedModel, requestedEffort, effortExplicit, conversationId) {
  const page = await setupPage(context);
  const initialUrl = buildChatUrl(modelHint(requestedModel), requestedEffort, conversationId);
  let textarea = await navigateChatPage(page, initialUrl);
  const models = await getModelCatalogFromPage(page);
  const model = resolveModel(requestedModel, models);
  const effort = resolveEffort(requestedEffort, model, effortExplicit);
  const resolvedUrl = buildChatUrl(model.key, effort, conversationId);
  const current = new URL(page.url());
  const resolved = new URL(resolvedUrl);
  if (current.pathname + current.search !== resolved.pathname + resolved.search) {
    textarea = await navigateChatPage(page, resolvedUrl);
  }
  return { page, textarea, models, model, effort, resolvedUrl };
}

async function getModelCatalog(context) {
  const settings = loadSettings();
  const page = await setupPage(context);
  try {
    await navigateChatPage(page, buildChatUrl(settings.model, settings.reasoning_effort));
    return await getModelCatalogFromPage(page);
  } finally {
    await page.close();
  }
}

async function getTranscriptSnapshot(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('[role="group"][aria-roledescription="message"]')];
    let lastUserIndex = -1;
    let userCount = 0;
    groups.forEach((group, index) => {
      if (group.querySelector('.webchat__bubble--from-user')) {
        lastUserIndex = index;
        userCount += 1;
      }
    });
    const candidates = [];
    groups.slice(lastUserIndex + 1).forEach((group) => {
      if (group.querySelector('.webchat__bubble--from-user')) return;
      const markdown = group.querySelector('.webchat__render-markdown--message-activity');
      const content = markdown || group.querySelector('.webchat__bubble__content');
      const text = (content?.innerText || '').trim();
      if (!text
        || text === '생각중…'
        || text === '무엇이 궁금하신가요?'
        || /답변을 (?:생성|준비) 중|잠시만 기다려\s*주세요/.test(text)) return;
      const activity = group.closest('article')
        || group.closest('[data-diagpt-stream-state]')
        || group.parentElement?.parentElement?.parentElement;
      const activityText = (activity?.innerText || '').trim();
      candidates.push({
        text,
        html: markdown?.innerHTML || '',
        hasSource: activityText.includes('답변 출처:'),
        streamState: activity?.querySelector?.('[data-diagpt-stream-state]')?.dataset?.diagptStreamState
          || activity?.dataset?.diagptStreamState
          || null,
        activityText,
      });
    });
    const sendButton = document.querySelector('button[aria-label="Send Message"]');
    const stopButton = document.querySelector('button[aria-label*="Stop"], button[aria-label*="중지"]');
    const bodyText = document.body.innerText || '';
    return {
      userCount,
      candidates,
      generating: Boolean(stopButton)
        || bodyText.includes('생각중…')
        || candidates.some((candidate) => candidate.streamState && candidate.streamState !== 'complete'),
      sendReady: Boolean(sendButton && !sendButton.disabled),
    };
  });
}

function createTurndown() {
  const service = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  service.use(gfm);
  return service;
}

async function waitForAnswer(page, baselineUserCount, timeoutMilliseconds, onPartial) {
  const startedAt = Date.now();
  let lastSignature = '';
  let stableCount = 0;
  let lastCandidate = null;
  let userAppeared = false;

  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (page.isClosed()) fail('응답 대기 중 브라우저 페이지가 닫혔습니다.', 3, 'BROWSER_CLOSED');
    if (new URL(page.url()).pathname.startsWith('/auth/login')) {
      fail('응답 대기 중 BeAT 세션이 만료되었습니다.', 2, 'SESSION_EXPIRED');
    }
    const snapshot = await getTranscriptSnapshot(page);
    if (snapshot.userCount > baselineUserCount) userAppeared = true;
    if (userAppeared && snapshot.candidates.length) {
      const candidate = snapshot.candidates.find((item) => item.hasSource) || snapshot.candidates[0];
      const signature = `${candidate.text}\n${candidate.html}`;
      if (signature === lastSignature) stableCount += 1;
      else {
        stableCount = 0;
        lastSignature = signature;
      }
      lastCandidate = candidate;
      // Only stream a real model activity. BeAT can insert transient bot
      // notices before the answer; those do not have a DirectLine stream state
      // or a model-source footer and must never become output deltas.
      if (onPartial && (candidate.hasSource || candidate.streamState)) onPartial(candidate.text);
      // The current Web Chat build removes/disables the send button while the
      // composer is empty, so sendReady is not a reliable completion signal.
      // A non-generating answer that has stayed unchanged for several polls is
      // complete even when the separate "답변 출처" activity is outside the
      // message group's DOM subtree.
      if (candidate.hasSource || (!snapshot.generating && stableCount >= 5)) {
        return candidate;
      }
    }
    await sleep(400);
  }
  const partial = lastCandidate?.text ? ` 마지막 부분 응답: ${lastCandidate.text.slice(0, 500)}` : '';
  fail(`답변을 ${Math.round(timeoutMilliseconds / 1000)}초 안에 받지 못했습니다.${partial}`, 4, 'ANSWER_TIMEOUT');
}

async function uploadAttachments(page, attachments, onProgress) {
  if (!attachments.length) return;
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  onProgress(`첨부 파일 ${attachments.length}개를 준비 중...`);
  await input.setInputFiles(attachments);
  await sleep(1500);
  const bodyText = await page.locator('body').innerText();
  const uploadError = bodyText.match(/(?:업로드|첨부)[^\n]*(?:실패|오류|지원하지)/);
  if (uploadError) fail(uploadError[0], 3, 'UPLOAD_FAILED');
}

async function sendMessage(page, textarea, message, options) {
  const baseline = await getTranscriptSnapshot(page);
  await uploadAttachments(page, options.attachments || [], options.onProgress || (() => {}));
  await textarea.fill(message);
  const sendButton = page.locator('button[aria-label="Send Message"]:visible').first();
  await sendButton.waitFor({ state: 'visible', timeout: 30_000 });
  if (await sendButton.isDisabled()) fail('메시지 전송 버튼이 비활성화되어 있습니다.', 3, 'SEND_DISABLED');
  (options.onProgress || (() => {}))('질문을 전송하고 답변을 기다리는 중...');
  await sendButton.click();
  const candidate = await waitForAnswer(
    page,
    baseline.userCount,
    options.timeoutSeconds * 1000,
    options.onPartial,
  );
  return {
    markdown: candidate.html ? createTurndown().turndown(candidate.html).trim() : candidate.text.trim(),
    plain: candidate.text.trim(),
  };
}

function conversationIdFromUrl(urlValue) {
  const parts = new URL(urlValue).pathname.split('/').filter(Boolean);
  const candidate = parts[parts.length - 1];
  return /^[0-9a-f-]{36}$/i.test(candidate) ? candidate : null;
}

async function runChat(context, message, options = {}) {
  const settings = loadSettings();
  const requestedModel = options.model || settings.model;
  const requestedEffort = options.effort ?? settings.reasoning_effort;
  const timeoutSeconds = options.timeoutSeconds || settings.timeout_seconds;
  const startedAt = Date.now();
  const prepared = await prepareResolvedChatPage(
    context,
    requestedModel,
    requestedEffort,
    Boolean(options.effortExplicit),
    options.conversationId || null,
  );
  try {
    const answer = await sendMessage(prepared.page, prepared.textarea, message, {
      timeoutSeconds,
      attachments: options.attachments || [],
      onProgress: options.onProgress,
      onPartial: options.onPartial,
    });
    return {
      answer: options.plain ? answer.plain : answer.markdown,
      answer_markdown: answer.markdown,
      answer_plain: answer.plain,
      conversation_id: conversationIdFromUrl(prepared.page.url()),
      model: prepared.model.key,
      model_title: prepared.model.title,
      reasoning_effort: prepared.effort,
      elapsed_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      url: prepared.page.url(),
    };
  } finally {
    await prepared.page.close();
  }
}

async function fetchHistory(context, limit = 20) {
  const results = [];
  const seen = new Set();
  let offset = 0;
  while (results.length < limit) {
    const response = await context.request.get(`${BASE_URL}/api/conversations/infinite?category_id=2&offset=${offset}`, {
      timeout: 30_000,
      failOnStatusCode: false,
    });
    if ([401, 403].includes(response.status())) fail('BeAT 세션이 만료되었습니다.', 2, 'SESSION_EXPIRED');
    if (!response.ok()) fail(`최근 대화 조회 실패(HTTP ${response.status()}).`, 3, 'NETWORK');
    const page = await response.json();
    if (!Array.isArray(page) || !page.length) break;
    let added = 0;
    for (const item of page) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      results.push(item);
      added += 1;
      if (results.length >= limit) break;
    }
    if (!added) break;
    offset += page.length;
  }
  return results.slice(0, limit);
}

module.exports = {
  BASE_URL,
  CHAT_PATH,
  DEFAULT_SETTINGS,
  PATHS,
  BeatError,
  fail,
  sleep,
  ensureConfigDir,
  secureWriteJson,
  readJson,
  removeFile,
  loadSettings,
  saveSettings,
  loadCredentials,
  saveCredentials,
  loadBeatSession,
  writeBeatSession,
  findChromium,
  launchBrowser,
  newContext,
  getSession,
  performLogin,
  contextFromSavedSession,
  ensureAuthenticated,
  forceRefresh,
  modelHint,
  normalizeEffort,
  resolveModel,
  resolveEffort,
  buildChatUrl,
  validateConversationId,
  navigateChatPage,
  prepareResolvedChatPage,
  getModelCatalog,
  sendMessage,
  runChat,
  fetchHistory,
  conversationIdFromUrl,
};
