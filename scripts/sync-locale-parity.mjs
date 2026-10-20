#!/usr/bin/env node
/**
 * Sync locale JSON files so zh / zh-TW / ja / ko resolve every leaf key in en.json.
 *
 * Priority for missing keys:
 *   1. Existing value in target locale
 *   2. scripts/i18n-backfill-{locale}.json
 *   3. zh source for zh-TW (with simplified→traditional conversion)
 *   4. en.json value (logged as fallback)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'desktop/src/locales');
const TARGETS = ['zh', 'zh-TW', 'ja', 'ko'];

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function get(obj, dotPath) {
  if (Object.prototype.hasOwnProperty.call(obj, dotPath)) return obj[dotPath];
  return dotPath.split('.').reduce((cur, part) => cur?.[part], obj);
}

function setByPath(obj, dotPath, value) {
  if (Object.prototype.hasOwnProperty.call(obj, dotPath)) {
    obj[dotPath] = value;
    return;
  }
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  const leaf = parts[parts.length - 1];
  if (cur[leaf] === undefined) cur[leaf] = value;
}

function collectLeaves(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.includes('.') && (typeof value === 'string' || Array.isArray(value))) {
      out.set(key, value);
      continue;
    }
    const dotPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectLeaves(value, dotPath, out);
    } else {
      out.set(dotPath, value);
    }
  }
  return out;
}

function loadBackfill(locale) {
  const filePath = path.join(ROOT, 'scripts', `i18n-backfill-${locale}.json`);
  if (!fs.existsSync(filePath)) return {};
  return loadJson(filePath);
}

function toTraditional(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/设置/g, '設定')
    .replace(/软件/g, '軟體')
    .replace(/服务器/g, '伺服器')
    .replace(/网络/g, '網路')
    .replace(/内存/g, '記憶體')
    .replace(/默认/g, '預設')
    .replace(/搜索/g, '搜尋')
    .replace(/视频/g, '視訊')
    .replace(/图像/g, '圖像')
    .replace(/信息/g, '資訊');
}

function translateValue(locale, key, enValue, sources) {
  if (get(sources.target, key) !== undefined) return null;
  if (sources.backfill[key] !== undefined) return sources.backfill[key];
  if (locale === 'zh-TW') {
    const zhValue = get(sources.zh, key);
    if (typeof zhValue === 'string') return toTraditional(zhValue);
  }
  return enValue;
}

function syncTarget(locale, enLeaves, en) {
  const targetPath = path.join(LOCALES_DIR, `${locale}.json`);
  const target = loadJson(targetPath);
  const zh = locale === 'zh-TW' ? loadJson(path.join(LOCALES_DIR, 'zh.json')) : null;
  const backfill = loadBackfill(locale);
  const sources = { target, backfill, zh };

  let added = 0;
  let englishFallback = 0;
  for (const [key, enValue] of enLeaves) {
    if (get(target, key) !== undefined) continue;
    const next = translateValue(locale, key, enValue, sources);
    if (next === null) continue;
    setByPath(target, key, next);
    added += 1;
    if (next === enValue && locale !== 'en') englishFallback += 1;
  }

  saveJson(targetPath, target);
  return { added, englishFallback };
}

function main() {
  const en = loadJson(path.join(LOCALES_DIR, 'en.json'));
  const enLeaves = collectLeaves(en);
  console.log(`[sync-locale-parity] en leaf keys: ${enLeaves.size}`);
  for (const locale of TARGETS) {
    const { added, englishFallback } = syncTarget(locale, enLeaves, en);
    console.log(`[sync-locale-parity] ${locale}: added ${added}, english-fallback ${englishFallback}`);
  }
}

main();
