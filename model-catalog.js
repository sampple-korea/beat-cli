'use strict';

// Parse serialized page data without eval and without depending on property order.
function parseModelCatalog(scriptText) {
  const models = new Map();
  const sources = new Set([String(scriptText || '')]);
  const add = (value, keyHint = null) => {
    if (!value || typeof value !== 'object') return;
    const key = /^chat_[a-zA-Z0-9_]+$/.test(String(keyHint || ''))
      ? String(keyHint)
      : /^chat_[a-zA-Z0-9_]+$/.test(String(value.key || '')) ? String(value.key) : null;
    if (key && typeof value.title === 'string' && Array.isArray(value.reasoning_efforts)) {
      const efforts = [...new Set(value.reasoning_efforts.filter((effort) => typeof effort === 'string' && effort.length > 0 && effort.length < 64))];
      models.set(key, { key, title: value.title, efforts, default_effort: efforts.includes(value.reasoning_effort_default) ? value.reasoning_effort_default : efforts[0] || null });
    }
  };
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 20) return;
    add(value);
    for (const [key, child] of Object.entries(value)) {
      if (/^chat_[a-zA-Z0-9_]+$/.test(key)) add(child, key);
      walk(child, depth + 1);
    }
  };
  // Next.js flight payloads put escaped JSON fragments inside JavaScript strings.
  for (let depth = 0; depth < 3; depth += 1) {
    for (const source of [...sources]) {
      for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
        if (!match[0].includes('chat_') || !match[0].includes('reasoning_efforts')) continue;
        try { const decoded = JSON.parse(match[0]); if (decoded !== source) sources.add(decoded); } catch { /* Not a JSON string literal. */ }
      }
    }
  }
  for (const source of sources) {
    try { walk(JSON.parse(source)); } catch { /* Script or flight fragment; scan model objects below. */ }
    const pattern = /"chat_[a-zA-Z0-9_]+"\s*:\s*\{/g;
    let match;
    while ((match = pattern.exec(source))) {
      const start = pattern.lastIndex - 1;
      const key = match[0].match(/^"([^"]+)"/)?.[1] || null;
      let level = 0, quoted = false, escaped = false;
      for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') level += 1;
        else if (char === '}' && --level === 0) {
          try { add(JSON.parse(source.slice(start, index + 1)), key); } catch { /* Reject incomplete or invalid definitions. */ }
          pattern.lastIndex = index + 1;
          break;
        }
      }
    }
  }
  return [...models.values()];
}

module.exports = { parseModelCatalog };
