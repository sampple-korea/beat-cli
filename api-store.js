'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lockfile = require('proper-lockfile');
const {
  PATHS,
  ensureConfigDir,
  secureWriteJson,
  readJson,
  fail,
} = require('./core');

const API_DIR = path.join(PATHS.configDir, 'api');
const FILES_DIR = path.join(API_DIR, 'files');
const TEMP_DIR = path.join(API_DIR, 'tmp');
const STATE_FILE = path.join(API_DIR, 'state.json');
const MAX_STORED_RECORDS = 2000;

const MIME_BY_EXTENSION = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.epub': 'application/epub+zip',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.text': 'text/plain',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
});

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.htm', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.log', '.md', '.mjs', '.php', '.properties',
  '.py', '.rb', '.rs', '.sh', '.sql', '.svg', '.text', '.toml', '.ts', '.tsx', '.tsv', '.txt',
  '.xml', '.yaml', '.yml',
]);

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.dib', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp',
]);

function ensureApiDirs() {
  ensureConfigDir();
  for (const directory of [API_DIR, FILES_DIR, TEMP_DIR]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
}

function objectId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function emptyState() {
  return {
    version: 1,
    files: {},
    conversations: {},
    responses: {},
    chat_completions: {},
  };
}

function loadState() {
  ensureApiDirs();
  const saved = readJson(STATE_FILE, { optional: true, label: 'API 상태 파일' });
  if (!saved) return emptyState();
  if (saved.version !== 1) fail('지원하지 않는 API 상태 파일 버전입니다. 기존 데이터를 덮어쓰지 않습니다.');
  return {
    ...emptyState(),
    ...saved,
    files: saved.files || {},
    conversations: saved.conversations || {},
    responses: saved.responses || {},
    chat_completions: saved.chat_completions || {},
  };
}

function pruneMap(record, maximum = MAX_STORED_RECORDS) {
  const entries = Object.entries(record);
  if (entries.length <= maximum) return record;
  entries.sort((a, b) => (b[1].created_at || b[1].created || 0) - (a[1].created_at || a[1].created || 0));
  return Object.fromEntries(entries.slice(0, maximum));
}

function saveState(state) {
  ensureApiDirs();
  state.responses = pruneMap(state.responses);
  state.chat_completions = pruneMap(state.chat_completions);
  secureWriteJson(STATE_FILE, state);
}

let mutationQueue = Promise.resolve();

function mutateState(mutator) {
  const task = mutationQueue.then(async () => {
    ensureApiDirs();
    const release = await lockfile.lock(STATE_FILE, {
      realpath: false, stale: 60000,
      retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
    try {
      const state = loadState();
      expireFiles(state);
      const result = await mutator(state);
      saveState(state);
      return result;
    } finally { await release(); }
  });
  mutationQueue = task.catch(() => {});
  return task;
}

function readState(reader) {
  return reader(loadState());
}

function normalizeServiceConfig(raw = {}) {
  const port = Number(process.env.BEAT_SERVICE_PORT || raw.port || 12124);
  const concurrency = Number(process.env.BEAT_SERVICE_CONCURRENCY || raw.concurrency || 2);
  return {
    host: process.env.BEAT_SERVICE_HOST || raw.host || '127.0.0.1',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 12124,
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 ? concurrency : 2,
    api_key: raw.api_key || `beat_${crypto.randomBytes(32).toString('base64url')}`,
    max_upload_mb: Number(raw.max_upload_mb) > 0 ? Number(raw.max_upload_mb) : 100,
    max_input_chars: Number(raw.max_input_chars) > 0 ? Number(raw.max_input_chars) : 200000,
    cors_origin: raw.cors_origin || '*',
    updated_at: raw.updated_at || new Date().toISOString(),
  };
}

function loadServiceConfig({ create = true } = {}) {
  const raw = readJson(PATHS.service, { optional: true, label: '서비스 설정' });
  if (!raw && !create) return null;
  const config = normalizeServiceConfig(raw || {});
  if (!raw && create) secureWriteJson(PATHS.service, config);
  return config;
}

function saveServiceConfig(changes) {
  const current = loadServiceConfig({ create: true });
  const config = normalizeServiceConfig({
    ...current,
    ...changes,
    updated_at: new Date().toISOString(),
  });
  secureWriteJson(PATHS.service, config);
  return config;
}

function rotateServiceKey() {
  return saveServiceConfig({ api_key: `beat_${crypto.randomBytes(32).toString('base64url')}` });
}

function safeFilename(value) {
  const basename = String(value || 'upload.bin').replace(/\\/g, '/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g, '_');
  return basename.slice(0, 240) || 'upload.bin';
}

function guessMimeType(filename, supplied = '') {
  if (supplied && supplied !== 'application/octet-stream') return supplied;
  return MIME_BY_EXTENSION[path.extname(filename).toLowerCase()] || supplied || 'application/octet-stream';
}

function fileObject(metadata) {
  const result = {
    id: metadata.id,
    object: 'file',
    bytes: metadata.bytes,
    created_at: metadata.created_at,
    filename: metadata.filename,
    purpose: metadata.purpose,
    status: 'processed',
  };
  if (metadata.expires_at) result.expires_at = metadata.expires_at;
  return result;
}

async function storeUploadedFile(tempPath, info = {}) {
  ensureApiDirs();
  const stat = fs.statSync(tempPath);
  const id = objectId('file');
  const filename = safeFilename(info.filename);
  const extension = path.extname(filename).toLowerCase().slice(0, 16);
  const blobPath = path.join(FILES_DIR, `${id}${extension}`);
  fs.renameSync(tempPath, blobPath);
  fs.chmodSync(blobPath, 0o600);
  const createdAt = unixNow();
  let expiresAt = null;
  if (info.expiresAfterSeconds) {
    const seconds = Number(info.expiresAfterSeconds);
    if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 2592000) {
      fs.unlinkSync(blobPath);
      fail('expires_after[seconds]는 3600~2592000 사이의 정수여야 합니다.');
    }
    expiresAt = createdAt + seconds;
  }
  const metadata = {
    id,
    filename,
    bytes: stat.size,
    created_at: createdAt,
    expires_at: expiresAt,
    purpose: info.purpose || 'user_data',
    mime_type: guessMimeType(filename, info.mimeType),
    blob_path: blobPath,
  };
  try {
    await mutateState((state) => { state.files[id] = metadata; });
  } catch (error) {
    fs.rmSync(blobPath, { force: true });
    throw error;
  }
  return fileObject(metadata);
}

function safeBlobPath(value) {
  return typeof value === 'string' && path.dirname(path.resolve(value)) === path.resolve(FILES_DIR);
}

function expireFiles(state) {
  for (const [id, metadata] of Object.entries(state.files)) {
    if (!metadata.expires_at || metadata.expires_at > unixNow()) continue;
    if (safeBlobPath(metadata.blob_path)) fs.rmSync(metadata.blob_path, { force: true });
    delete state.files[id];
  }
}

function cleanupExpiredFiles() {
  return mutateState(() => {});
}

function getStoredFile(id) {
  return readState((state) => {
    const metadata = Object.hasOwn(state.files, id) && state.files[id];
    if (!metadata || (metadata.expires_at && metadata.expires_at <= unixNow())) return null;
    if (!safeBlobPath(metadata.blob_path)) return null;
    try {
      fs.accessSync(metadata.blob_path, fs.constants.R_OK);
    } catch {
      return null;
    }
    return { metadata, object: fileObject(metadata), path: metadata.blob_path };
  });
}

function listStoredFiles(options = {}) {
  return readState((state) => {
    let rows = Object.values(state.files).filter((item) => !item.expires_at || item.expires_at > unixNow());
    if (options.purpose) rows = rows.filter((item) => item.purpose === options.purpose);
    rows.sort((a, b) => options.order === 'asc'
      ? a.created_at - b.created_at
      : b.created_at - a.created_at);
    if (options.after) {
      const index = rows.findIndex((item) => item.id === options.after);
      if (index >= 0) rows = rows.slice(index + 1);
    }
    const limit = Math.min(10000, Math.max(1, Number(options.limit) || 10000));
    const selected = rows.slice(0, limit);
    return {
      object: 'list',
      data: selected.map(fileObject),
      first_id: selected[0]?.id || null,
      last_id: selected[selected.length - 1]?.id || null,
      has_more: rows.length > selected.length,
    };
  });
}

async function deleteStoredFile(id) {
  return mutateState((state) => {
    const metadata = Object.hasOwn(state.files, id) && state.files[id];
    if (!metadata) return false;
    if (safeBlobPath(metadata.blob_path)) {
      try {
        fs.unlinkSync(metadata.blob_path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    delete state.files[id];
    return true;
  });
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(parseInt(number, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function markupToText(value) {
  return decodeXmlEntities(String(value || '')
    .replace(/<\/?(?:w:p|a:p|text:p|text:h|row|tr|li|p|div|h[1-6])(?:\s[^>]*)?>/gi, '\n')
    .replace(/<(?:w:tab|text:tab|br)(?:\s[^>]*)?\/?\s*>/gi, '\t')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unzipText(filename, patterns, maxBuffer) {
  try {
    return execFileSync('/usr/bin/unzip', ['-p', filename, ...patterns], {
      encoding: 'utf8',
      maxBuffer,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    fail(`압축 문서에서 텍스트를 읽지 못했습니다${stderr ? `: ${stderr.slice(0, 300)}` : '.'}`);
  }
}

function extractSpreadsheetText(filename, maxBuffer) {
  const sharedXml = unzipText(filename, ['xl/sharedStrings.xml'], maxBuffer);
  const shared = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)]
    .map((match) => markupToText(match[1]));
  const sheetsXml = unzipText(filename, ['xl/worksheets/sheet*.xml'], maxBuffer);
  const rows = [];
  for (const row of sheetsXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi)) {
    const values = [];
    for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = cell[1];
      const body = cell[2];
      const raw = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i)?.[1]
        ?? body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/i)?.[1]
        ?? '';
      const value = /\bt=["']s["']/i.test(attributes) ? shared[Number(raw)] ?? raw : raw;
      values.push(decodeXmlEntities(value));
    }
    if (values.some(Boolean)) rows.push(values.join('\t'));
  }
  return rows.join('\n');
}

function looksLikeText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / sample.length < 0.02;
}

function truncateText(value, limit) {
  if (value.length <= limit) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, limit)}\n\n[파일 내용이 ${limit.toLocaleString()}자로 잘렸습니다.]`,
    truncated: true,
  };
}

function extractDocumentText(filename, options = {}) {
  const maxChars = Math.max(1000, Number(options.maxChars) || 200000);
  const extension = path.extname(filename).toLowerCase();
  const stat = fs.statSync(filename);
  if (stat.size > 250 * 1024 * 1024) fail('문서 내용 추출은 파일당 250 MiB까지 지원합니다.');
  const maxBuffer = Math.min(300 * 1024 * 1024, Math.max(20 * 1024 * 1024, stat.size * 8));
  let text;

  if (TEXT_EXTENSIONS.has(extension)) {
    const buffer = fs.readFileSync(filename);
    if (!looksLikeText(buffer)) fail('텍스트 확장자 파일에서 바이너리 내용을 감지했습니다.');
    text = extension === '.html' || extension === '.htm' || extension === '.svg'
      ? markupToText(buffer.toString('utf8'))
      : buffer.toString('utf8');
  } else if (extension === '.pdf') {
    try {
      text = execFileSync('/usr/bin/pdftotext', ['-layout', '-enc', 'UTF-8', filename, '-'], {
        encoding: 'utf8',
        maxBuffer,
        timeout: 90_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(`PDF 텍스트 추출 실패: ${String(error.stderr || error.message).trim().slice(0, 300)}`);
    }
  } else if (extension === '.docx') {
    text = markupToText(unzipText(filename, ['word/document.xml', 'word/header*.xml', 'word/footer*.xml'], maxBuffer));
  } else if (extension === '.pptx') {
    text = markupToText(unzipText(filename, ['ppt/slides/slide*.xml', 'ppt/notesSlides/notesSlide*.xml'], maxBuffer));
  } else if (extension === '.xlsx' || extension === '.xlsm') {
    text = extractSpreadsheetText(filename, maxBuffer);
  } else if (['.odt', '.ods', '.odp'].includes(extension)) {
    text = markupToText(unzipText(filename, ['content.xml'], maxBuffer));
  } else if (extension === '.epub') {
    text = markupToText(unzipText(filename, ['*.xhtml', '*.html', 'OEBPS/*.xhtml', 'EPUB/*.xhtml'], maxBuffer));
  } else if (extension === '.rtf') {
    text = fs.readFileSync(filename, 'utf8')
      .replace(/\\'[0-9a-f]{2}/gi, ' ')
      .replace(/\\[a-z]+-?\d* ?/gi, ' ')
      .replace(/[{}]/g, ' ');
  } else {
    const buffer = fs.readFileSync(filename);
    if (!looksLikeText(buffer)) {
      fail(`지원하지 않는 바이너리 문서 형식입니다: ${extension || '(확장자 없음)'}`);
    }
    text = buffer.toString('utf8');
  }

  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) fail('파일에서 읽을 수 있는 텍스트를 찾지 못했습니다. 스캔 PDF는 OCR이 필요할 수 있습니다.');
  return truncateText(normalized, maxChars);
}

function isNativeImage(filename, mimeType = '') {
  return IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())
    || /image\/(?:png|jpe?g|gif|webp|bmp|tiff|avif)/i.test(mimeType);
}

function makeTempFile(extension = '.bin') {
  ensureApiDirs();
  const directory = fs.mkdtempSync(path.join(TEMP_DIR, `request-${process.pid}-`));
  fs.chmodSync(directory, 0o700);
  return {
    directory,
    filename: path.join(directory, `input${extension.startsWith('.') ? extension : `.${extension}`}`),
  };
}

function cleanupTemp(directory) {
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(TEMP_DIR)) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

module.exports = {
  API_DIR,
  FILES_DIR,
  TEMP_DIR,
  STATE_FILE,
  IMAGE_EXTENSIONS,
  ensureApiDirs,
  objectId,
  unixNow,
  loadState,
  saveState,
  mutateState,
  readState,
  normalizeServiceConfig,
  loadServiceConfig,
  saveServiceConfig,
  cleanupExpiredFiles,
  rotateServiceKey,
  safeFilename,
  guessMimeType,
  fileObject,
  storeUploadedFile,
  getStoredFile,
  listStoredFiles,
  deleteStoredFile,
  extractDocumentText,
  isNativeImage,
  makeTempFile,
  cleanupTemp,
};
