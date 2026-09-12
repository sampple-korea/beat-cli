#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const core = require('./core');
const store = require('./api-store');
const packageInfo = require('./package.json');

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function stdout(message = '') {
  process.stdout.write(`${message}\n`);
}

function parseArguments(args, specification = {}) {
  const options = {};
  const positionals = [];
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (positionalOnly || argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
      continue;
    }
    let token = argument;
    let inlineValue;
    const equals = token.indexOf('=');
    if (equals > 0) {
      inlineValue = token.slice(equals + 1);
      token = token.slice(0, equals);
    }
    let negative = false;
    let definition = specification[token];
    if (!definition && token.startsWith('--no-')) {
      const positive = `--${token.slice(5)}`;
      definition = specification[positive];
      if (definition?.type === 'boolean') negative = true;
    }
    if (!definition) core.fail(`알 수 없는 옵션: ${token}`);
    const name = definition.name;
    if (definition.type === 'boolean') {
      if (inlineValue !== undefined) {
        const normalized = inlineValue.toLowerCase();
        if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(normalized)) {
          core.fail(`${token} 값은 true 또는 false여야 합니다.`);
        }
        options[name] = ['true', '1', 'yes', 'on'].includes(normalized);
      } else {
        options[name] = !negative;
      }
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : args[++index];
    if (value === undefined || (inlineValue === undefined && /^--?[a-zA-Z]/.test(value))) core.fail(`${token} 뒤에 값이 필요합니다.`);
    if (definition.type === 'repeat') {
      if (!options[name]) options[name] = [];
      options[name].push(value);
    } else {
      options[name] = value;
    }
  }
  return { options, positionals };
}

function aliases(name, type, ...tokens) {
  return Object.fromEntries(tokens.map((token) => [token, { name, type }]));
}

async function readHidden(promptText) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = '';
    let finished = false;
    process.stderr.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(Object.assign(new Error('취소되었습니다.'), { exitCode: 130 }));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on('data', onData);
  });
}

async function readPipe() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

function progressPrinter(quiet = false) {
  return quiet ? () => {} : (message) => stderr(message);
}

async function authenticatedOperation(callback, options = {}) {
  let browser = await core.launchClient();
  let authenticated = null;
  const onProgress = options.onProgress || (() => {});
  const autoRefresh = options.autoRefresh ?? core.loadSettings().auto_refresh;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        authenticated = await core.ensureAuthenticated(browser, { autoRefresh, onProgress });
        return await callback(authenticated.context, authenticated);
      } catch (error) {
        if (authenticated?.context) await authenticated.context.close().catch(() => {});
        authenticated = null;
        const recoverable = autoRefresh && attempt === 0
          && ['SESSION_EXPIRED', 'BROWSER_CLOSED'].includes(error.code);
        if (!recoverable) throw error;
        if (error.code === 'BROWSER_CLOSED') {
          await browser.close().catch(() => {});
          browser = await core.launchClient();
        } else {
          await core.forceRefresh(browser, onProgress);
        }
      } finally {
        if (authenticated?.context) {
          await authenticated.context.close().catch(() => {});
          authenticated = null;
        }
      }
    }
    core.fail('세션 복구 후에도 작업하지 못했습니다.');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function commandLogin(args) {
  const specification = {
    ...aliases('store', 'boolean', '--store'),
    ...aliases('quiet', 'boolean', '--quiet', '-q'),
  };
  const { options, positionals } = parseArguments(args, specification);
  const username = positionals[0];
  if (!username || positionals.length > 2) core.fail('사용법: beat login <아이디> [비밀번호] [--no-store]');
  const password = positionals.length === 2 ? positionals[1] : await readHidden('비밀번호: ');
  if (!password) core.fail('비밀번호가 비어 있습니다.');
  if (positionals.length === 2 && !options.quiet) stderr('주의: 명령행 비밀번호는 셸 기록이나 프로세스 목록에 잠시 보일 수 있습니다.');
  const browser = await core.launchClient();
  try {
    const session = await core.performLogin(browser, username, password, {
      storeCredentials: options.store !== false,
      onProgress: progressPrinter(options.quiet),
    });
    stdout(`로그인 성공: 학생 계정 세션${options.store === false ? '' : '과 자동 갱신용 자격 증명'}을 저장했습니다.`);
    if (session.expires) stdout(`세션 만료 예정: ${session.expires}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function commandRefresh(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('quiet', 'boolean', '--quiet', '-q'),
  });
  if (positionals.length) core.fail('사용법: beat refresh');
  const browser = await core.launchClient();
  try {
    await core.forceRefresh(browser, progressPrinter(options.quiet));
    stdout('BeAT 로그인 세션을 새로 발급해 저장했습니다.');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function resolveConversationOption(context, value) {
  if (!value) return null;
  if (String(value).toLowerCase() !== 'last') return core.validateConversationId(value);
  const history = await core.fetchHistory(context, 1);
  if (!history.length) core.fail('이어갈 최근 BeAT 대화가 없습니다.');
  return history[0].id;
}

function prepareLocalFiles(paths, maxChars = 200000) {
  const attachments = [];
  const sections = [];
  let remaining = maxChars;
  for (const inputPath of paths || []) {
    const filename = path.resolve(inputPath);
    let stat;
    try {
      stat = fs.statSync(filename);
    } catch (error) {
      core.fail(`첨부 파일을 읽을 수 없습니다: ${inputPath} (${error.message})`);
    }
    if (!stat.isFile()) core.fail(`첨부 대상이 일반 파일이 아닙니다: ${inputPath}`);
    if (store.isNativeImage(filename)) {
      attachments.push(filename);
      continue;
    }
    const extracted = store.extractDocumentText(filename, { maxChars: Math.max(1000, remaining) });
    remaining -= extracted.text.length;
    sections.push(`[첨부 문서: ${path.basename(filename)}${extracted.truncated ? ', 일부만 포함' : ''}]\n${extracted.text}`);
    if (remaining <= 0) break;
  }
  return { attachments, sections };
}

const CHAT_OPTIONS = {
  ...aliases('model', 'value', '--model', '-m'),
  ...aliases('effort', 'value', '--reasoning', '--reasoning-effort', '--effort', '-r'),
  ...aliases('conversation', 'value', '--continue', '--conversation', '-c'),
  ...aliases('attachments', 'repeat', '--attach', '--file', '-a'),
  ...aliases('timeout', 'value', '--timeout', '-t'),
  ...aliases('json', 'boolean', '--json', '-j'),
  ...aliases('plain', 'boolean', '--plain'),
  ...aliases('stream', 'boolean', '--stream', '-s'),
  ...aliases('meta', 'boolean', '--meta'),
  ...aliases('refresh', 'boolean', '--refresh'),
  ...aliases('quiet', 'boolean', '--quiet', '-q'),
};

async function commandChat(args) {
  const { options, positionals } = parseArguments(args, CHAT_OPTIONS);
  if (options.json && options.stream) core.fail('--json과 --stream은 함께 사용할 수 없습니다.');
  let message = positionals.join(' ');
  if ((!message || message === '-') && !process.stdin.isTTY) message = await readPipe();
  const serviceConfig = store.loadServiceConfig({ create: false });
  const localFiles = prepareLocalFiles(options.attachments || [], serviceConfig?.max_input_chars || 200000);
  if (localFiles.sections.length) message = [message, ...localFiles.sections].filter(Boolean).join('\n\n');
  if (!message && localFiles.attachments.length) message = '첨부한 이미지를 분석해 주세요.';
  if (!message) core.fail('사용법: beat chat [옵션] <메시지>');
  const timeout = options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) core.fail('--timeout은 0보다 큰 초 단위 숫자여야 합니다.');
  const onProgress = progressPrinter(options.quiet || options.stream);
  let streamed = '';
  const result = await authenticatedOperation(async (context) => {
    const conversationId = await resolveConversationOption(context, options.conversation);
    return core.runChat(context, message, {
      model: options.model,
      effort: options.effort,
      effortExplicit: options.effort !== undefined,
      conversationId,
      attachments: localFiles.attachments,
      timeoutSeconds: timeout,
      plain: options.plain || options.stream,
      onProgress,
      onPartial: options.stream ? (current) => {
        if (!current.startsWith(streamed)) return;
        const delta = current.slice(streamed.length);
        if (delta) process.stdout.write(delta);
        streamed = current;
      } : null,
    });
  }, { autoRefresh: options.refresh, onProgress });

  if (options.json) {
    stdout(JSON.stringify(result, null, 2));
  } else if (options.stream) {
    if (result.answer.startsWith(streamed)) process.stdout.write(result.answer.slice(streamed.length));
    process.stdout.write('\n');
  } else {
    stdout(result.answer);
    if (options.meta) {
      stderr(`대화 ID: ${result.conversation_id}`);
      stderr(`모델: ${result.model} / 추론: ${result.reasoning_effort || '없음'} / ${result.elapsed_seconds}초`);
    }
  }
}

async function commandModels(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('json', 'boolean', '--json', '-j'),
    ...aliases('refresh', 'boolean', '--refresh'),
    ...aliases('quiet', 'boolean', '--quiet', '-q'),
  });
  if (positionals.length) core.fail('사용법: beat models [--json]');
  const models = await authenticatedOperation(
    (context) => core.getModelCatalog(context),
    { autoRefresh: options.refresh, onProgress: progressPrinter(options.quiet) },
  );
  if (options.json) return stdout(JSON.stringify(models, null, 2));
  const keyWidth = Math.max(...models.map((model) => model.key.length));
  for (const model of models) {
    const efforts = model.efforts.length ? model.efforts.join(',') : '-';
    stdout(`${model.key.padEnd(keyWidth)}  ${model.title}  [${efforts}] 기본=${model.default_effort || '-'}`);
  }
}

async function commandHistory(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('limit', 'value', '--limit', '-n'),
    ...aliases('json', 'boolean', '--json', '-j'),
    ...aliases('refresh', 'boolean', '--refresh'),
    ...aliases('quiet', 'boolean', '--quiet', '-q'),
  });
  if (positionals.length) core.fail('사용법: beat history [--limit N] [--json]');
  const limit = Number(options.limit || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) core.fail('--limit은 1~200 사이 정수여야 합니다.');
  const rows = await authenticatedOperation(
    (context) => core.fetchHistory(context, limit),
    { autoRefresh: options.refresh, onProgress: progressPrinter(options.quiet) },
  );
  if (options.json) return stdout(JSON.stringify(rows, null, 2));
  if (!rows.length) return stdout('저장된 BeAT 대화가 없습니다.');
  for (const row of rows) {
    const title = String(row.title || '(제목 없음)').replace(/\s+/g, ' ').slice(0, 80);
    stdout(`${row.id}  ${title}  ${row.model || ''} ${row.reasoning_effort || ''}`.trimEnd());
  }
}

async function commandStatus(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('json', 'boolean', '--json', '-j'),
    ...aliases('refresh', 'boolean', '--refresh'),
    ...aliases('quiet', 'boolean', '--quiet', '-q'),
  });
  if (positionals.length) core.fail('사용법: beat status [--no-refresh] [--json]');
  const credentials = core.loadCredentials({ optional: true });
  const result = await authenticatedOperation(async (_context, authenticated) => ({
    valid: true,
    refreshed: authenticated.refreshed,
    credentials_saved: Boolean(credentials),
    account_type: credentials?.account_type || 'student',
  }), { autoRefresh: options.refresh, onProgress: progressPrinter(options.quiet) });
  if (options.json) return stdout(JSON.stringify(result, null, 2));
  stdout(`로그인 상태: 유효${result.refreshed ? ' (자동 갱신됨)' : ''}`);
  stdout(`자동 갱신 자격 증명: ${result.credentials_saved ? '저장됨' : '없음'}`);
}

function commandLogout(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('forget', 'boolean', '--forget', '--all'),
  });
  if (positionals.length) core.fail('사용법: beat logout [--forget]');
  const sessionRemoved = core.removeFile(core.PATHS.session);
  const credentialsRemoved = options.forget ? core.removeFile(core.PATHS.credentials) : false;
  if (sessionRemoved) stdout('저장된 BeAT 세션을 삭제했습니다.');
  else stdout('저장된 BeAT 세션이 없습니다.');
  if (options.forget) stdout(credentialsRemoved ? '자동 갱신용 아이디와 비밀번호도 삭제했습니다.' : '저장된 자격 증명이 없습니다.');
  else if (core.loadCredentials({ optional: true })) stdout('자동 갱신용 자격 증명은 유지됩니다. 완전히 지우려면 `beat logout --forget`을 사용하세요.');
}

function parseBoolean(value) {
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on', '켜기'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', '끄기'].includes(normalized)) return false;
  core.fail('불리언 값은 true 또는 false여야 합니다.');
}

function commandConfig(args) {
  const [action = 'show', ...rest] = args;
  if (action === 'show') {
    if (rest.length) core.fail('사용법: beat config show');
    const settings = core.loadSettings();
    const service = store.loadServiceConfig({ create: false });
    return stdout(JSON.stringify({
      chat: settings,
      service: service ? { ...service, api_key: '<redacted>' } : null,
      paths: {
        session: core.PATHS.session,
        credentials: core.PATHS.credentials,
        service: core.PATHS.service,
      },
    }, null, 2));
  }
  if (action === 'set') {
    if (rest.length !== 2) core.fail('사용법: beat config set <키> <값>');
    const [key, rawValue] = rest;
    const allowed = {
      model: 'string',
      reasoning_effort: 'string',
      timeout_seconds: 'number',
      auto_refresh: 'boolean',
    };
    if (!allowed[key]) core.fail(`설정 가능한 키: ${Object.keys(allowed).join(', ')}`);
    let value = rawValue;
    if (allowed[key] === 'number') {
      value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) core.fail(`${key}는 0보다 큰 숫자여야 합니다.`);
    } else if (allowed[key] === 'boolean') value = parseBoolean(rawValue);
    const settings = { ...core.loadSettings(), [key]: value };
    core.saveSettings(settings);
    stdout(`${key} = ${value}`);
    return;
  }
  if (action === 'reset') {
    if (rest.length) core.fail('사용법: beat config reset');
    core.removeFile(core.PATHS.settings);
    stdout('채팅 설정을 기본값으로 되돌렸습니다.');
    return;
  }
  core.fail('사용법: beat config show|set|reset');
}

function copyToStoredFile(source, purpose = 'user_data') {
  const absolute = path.resolve(source);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) core.fail(`일반 파일이 아닙니다: ${source}`);
  const extension = path.extname(absolute).slice(0, 16).replace(/[^.a-z0-9]/gi, '') || '.bin';
  const temp = store.makeTempFile(extension);
  try {
    fs.copyFileSync(absolute, temp.filename, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temp.filename, 0o600);
    return store.storeUploadedFile(temp.filename, {
      filename: path.basename(absolute),
      purpose,
    }).finally(() => store.cleanupTemp(temp.directory));
  } catch (error) {
    store.cleanupTemp(temp.directory);
    throw error;
  }
}

async function commandFiles(args) {
  const [action = 'list', ...rest] = args;
  if (action === 'upload') {
    const { options, positionals } = parseArguments(rest, {
      ...aliases('purpose', 'value', '--purpose', '-p'),
      ...aliases('json', 'boolean', '--json', '-j'),
    });
    if (positionals.length !== 1) core.fail('사용법: beat files upload <경로> [--purpose user_data]');
    const object = await copyToStoredFile(positionals[0], options.purpose || 'user_data');
    return stdout(options.json ? JSON.stringify(object, null, 2) : `${object.id}  ${object.filename}  ${object.bytes} bytes`);
  }
  if (action === 'list') {
    const { options, positionals } = parseArguments(rest, {
      ...aliases('purpose', 'value', '--purpose', '-p'),
      ...aliases('limit', 'value', '--limit', '-n'),
      ...aliases('json', 'boolean', '--json', '-j'),
    });
    if (positionals.length) core.fail('사용법: beat files list [--json]');
    const result = store.listStoredFiles({ purpose: options.purpose, limit: options.limit });
    if (options.json) return stdout(JSON.stringify(result, null, 2));
    if (!result.data.length) return stdout('저장된 API 파일이 없습니다.');
    result.data.forEach((item) => stdout(`${item.id}  ${item.filename}  ${item.bytes} bytes  ${item.purpose}`));
    return;
  }
  if (action === 'info') {
    if (rest.length !== 1) core.fail('사용법: beat files info <file_id>');
    const found = store.getStoredFile(rest[0]);
    if (!found) core.fail(`파일을 찾을 수 없습니다: ${rest[0]}`);
    return stdout(JSON.stringify(found.object, null, 2));
  }
  if (action === 'delete' || action === 'rm') {
    if (rest.length !== 1) core.fail('사용법: beat files delete <file_id>');
    const deleted = await store.deleteStoredFile(rest[0]);
    if (!deleted) core.fail(`파일을 찾을 수 없습니다: ${rest[0]}`);
    return stdout(`삭제했습니다: ${rest[0]}`);
  }
  core.fail('사용법: beat files upload|list|info|delete');
}

async function commandRepl(args) {
  const { options, positionals } = parseArguments(args, CHAT_OPTIONS);
  if (positionals.length) core.fail('사용법: beat repl [--model 모델] [--continue ID|last]');
  if (!process.stdin.isTTY) core.fail('대화형 모드는 TTY 터미널에서 실행해 주세요.');
  const onProgress = progressPrinter(options.quiet);
  const browser = await core.launchClient();
  let authenticated, context, terminal;
  const autoRefresh = options.refresh ?? core.loadSettings().auto_refresh;
  try {
  authenticated = await core.ensureAuthenticated(browser, { autoRefresh, onProgress });
  context = authenticated.context;
  let conversationId = await resolveConversationOption(context, options.conversation);
  let model = options.model;
  let effort = options.effort;
  let pendingFiles = [];
  terminal = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'beat> ' });
  stdout('BeAT 대화형 모드입니다. /help로 명령을 확인하세요.');
  terminal.prompt();
    for await (const rawLine of terminal) {
      const line = rawLine.trim();
      if (!line) { terminal.prompt(); continue; }
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        stdout('/new, /id, /model <이름>, /reasoning <강도>, /attach <경로>, /files, /exit');
        terminal.prompt();
        continue;
      }
      if (line === '/new') {
        conversationId = null;
        stdout('다음 질문부터 새 대화를 시작합니다.');
        terminal.prompt();
        continue;
      }
      if (line === '/id') {
        stdout(conversationId || '(아직 생성되지 않음)');
        terminal.prompt();
        continue;
      }
      if (line.startsWith('/model ')) {
        model = line.slice(7).trim();
        stdout(`모델: ${model}`);
        terminal.prompt();
        continue;
      }
      if (line.startsWith('/reasoning ')) {
        effort = line.slice(11).trim();
        stdout(`추론 강도: ${effort}`);
        terminal.prompt();
        continue;
      }
      if (line.startsWith('/attach ')) {
        pendingFiles.push(line.slice(8).trim());
        stdout(`다음 질문 첨부: ${pendingFiles[pendingFiles.length - 1]}`);
        terminal.prompt();
        continue;
      }
      if (line === '/files') {
        stdout(pendingFiles.length ? pendingFiles.join('\n') : '(대기 중인 첨부 없음)');
        terminal.prompt();
        continue;
      }
      let files = prepareLocalFiles(pendingFiles);
      pendingFiles = [];
      const prompt = [line, ...files.sections].join('\n\n');
      let result;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await core.runChat(context, prompt, {
            model,
            effort,
            effortExplicit: effort !== undefined,
            conversationId,
            attachments: files.attachments,
            timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
            onProgress,
          });
          break;
        } catch (error) {
          if (attempt || !autoRefresh || error.code !== 'SESSION_EXPIRED') throw error;
          await context.close().catch(() => {});
          await core.forceRefresh(browser, onProgress);
          authenticated = await core.ensureAuthenticated(browser, { onProgress });
          context = authenticated.context;
        }
      }
      conversationId = result.conversation_id;
      stdout(`\n${result.answer}\n`);
      terminal.prompt();
    }
  } finally {
    terminal?.close();
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function commandDoctor(args) {
  const { options, positionals } = parseArguments(args, {
    ...aliases('json', 'boolean', '--json', '-j'),
  });
  if (positionals.length) core.fail('사용법: beat doctor [--json]');
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  add('transport', true, 'HTTP / Direct Line (Chromium 불필요)');
  add('session_file', Boolean(core.loadBeatSession({ optional: true })), core.PATHS.session);
  add('credentials_file', Boolean(core.loadCredentials({ optional: true })), core.PATHS.credentials);
  for (const [name, filename] of [['session_permissions', core.PATHS.session], ['credentials_permissions', core.PATHS.credentials], ['service_permissions', core.PATHS.service]]) {
    try {
      const mode = fs.statSync(filename).mode & 0o777;
      add(name, process.platform === 'win32' || mode === 0o600, process.platform === 'win32' ? 'Windows ACL; POSIX mode not applicable' : mode.toString(8));
    } catch (error) {
      add(name, error.code === 'ENOENT', error.code === 'ENOENT' ? 'not-created' : error.message);
    }
  }
  try {
    const valid = await authenticatedOperation(() => true, { autoRefresh: false });
    add('beat_session', valid, 'valid');
  } catch (error) {
    add('beat_session', false, error.message);
  }
  const runningService = await require('./service').status();
  add('api_health', runningService.active !== 'unreachable', runningService.active);
  if (options.json) stdout(JSON.stringify(checks, null, 2));
  else checks.forEach((check) => stdout(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}`));
  if (checks.some((check) => !check.ok && check.name !== 'beat_session')) process.exitCode = 1;
}

function printHelp() {
  stdout([
    `BeAT CLI ${packageInfo.version}`,
    '',
    '사용법:',
    '  beat setup                          사용자 전용 Codex 설치 (Chromium 불필요)',
    '  beat codex [옵션] [Codex 인자]        BeAT 모델 기반의 별도 Codex',
    '  beat codex config|models|doctor      전용 모델/추론 설정·조회·진단',
    '  beat login <아이디> [비밀번호]       학생 계정 로그인, 세션·갱신 정보 저장',
    '  beat refresh                         저장된 정보로 세션 강제 갱신',
    '  beat chat [옵션] <메시지>            기본적으로 매번 새 대화',
    '  beat repl [옵션]                     이어지는 대화형 셸',
    '  beat models [--json]                 사용 가능한 모델 실시간 조회',
    '  beat history [--limit N]             BeAT 최근 대화와 ID 조회',
    '  beat files upload|list|info|delete   호환 API용 파일 관리',
    '  beat status [--no-refresh]           로그인 검사 및 필요 시 자동 갱신',
    '  beat logout [--forget]               세션 삭제; --forget은 아이디·비밀번호도 삭제',
    '  beat config show|set|reset            기본 모델·추론·시간 제한 설정',
    '  beat service <명령>                  OpenAI 호환 백그라운드 서비스',
    '  beat doctor                          환경 및 권한 진단',
    '',
    'chat 옵션:',
    '  -m, --model <모델>                   예: sol, terra, chat_gpt5_6_sol',
    '  -r, --reasoning <강도>               none|minimal|low|medium|high|xhigh',
    '  -c, --continue <ID|last>              기존 BeAT 대화 이어가기',
    '  -a, --attach <경로>                  이미지·텍스트·PDF·Office 파일 (반복 가능)',
    '  -s, --stream                         답변 실시간 출력',
    '  -j, --json                           메타데이터 포함 JSON 출력',
    '  --plain --meta --timeout <초> --no-refresh --quiet',
    '',
    'service 명령:',
    '  start|run|stop|restart|status|logs|key|url|enable|disable|install|test',
    '  start 옵션: --host, --port(기본 12124), --concurrency, --max-upload-mb',
    '',
    '비밀번호 인자를 생략하면 화면에 표시되지 않는 방식으로 입력합니다.',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  switch (command) {
    case 'setup': return require('./platform').setup(args);
    case 'codex': return require('./codex').command(args);
    case 'login': return commandLogin(args);
    case 'refresh': return commandRefresh(args);
    case 'chat': return commandChat(args);
    case 'repl':
    case 'shell': return commandRepl(args);
    case 'models': return commandModels(args);
    case 'history':
    case 'conversations': return commandHistory(args);
    case 'status': return commandStatus(args);
    case 'logout': return commandLogout(args);
    case 'config': return commandConfig(args);
    case 'files': return commandFiles(args);
    case 'service': return require('./service').command(args);
    case 'doctor': return commandDoctor(args);
    case 'version':
    case '--version':
    case '-V': return stdout(packageInfo.version);
    case 'help':
    case '--help':
    case '-h':
    case undefined: return printHelp();
    default: core.fail(`알 수 없는 명령: ${command}\n도움말: beat --help`);
  }
}

if (require.main === module) main().catch((error) => {
  stderr(`오류: ${error.message}`);
  if (process.env.BEAT_DEBUG) stderr(error.stack || '');
  process.exitCode = error.exitCode || 1;
});

module.exports = { main, parseArguments, aliases, prepareLocalFiles };
