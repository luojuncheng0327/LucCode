/**
 * Server-side i18n — 从 locale JSON 加载翻译
 */
import fs from "fs";
import path from "path";
import { fromRoot } from "../shared/luc-root.ts";
import { createModuleLogger } from "./debug-log.ts";

const log = createModuleLogger("i18n");

const localesDir = fromRoot("desktop", "src", "locales");

let data = {};
// 英文兜底包：当前 locale 缺某个 key 时回退到这里，避免把 key 字面量直接吐给用户。
let fallbackData = {};
let currentLocale = "zh";
let loaded = false;

/**
 * locale 字符串 → JSON 文件名 key
 */
function resolveKey(locale) {
  if (!locale) return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

/**
 * 加载语言包
 * @param {string} locale  config.yaml 里的 locale 值，如 "zh-CN" / "zh-TW" / "ja" / "ko" / "en"
 */
function readLocaleFile(key) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${key}.json`), "utf-8"));
}

export function loadLocale(locale) {
  const key = resolveKey(locale);
  currentLocale = key;
  loaded = true;
  // 英文包始终加载为兜底（key 缺失时回退），en locale 时与 data 共用同一份。
  try {
    fallbackData = readLocaleFile("en");
  } catch (err) {
    log.error(`Failed to load fallback locale "en": ${err.message}`);
    fallbackData = {};
  }
  if (key === "en") {
    data = fallbackData;
    return;
  }
  try {
    data = readLocaleFile(key);
  } catch (err) {
    log.error(`Failed to load locale "${key}": ${err.message}`);
    data = fallbackData;
  }
}

/**
 * 按 dot path 取值。当前 locale 缺失时回退英文兜底包。
 */
function getFrom(source, p) {
  const exact = source?.[p];
  if (exact !== undefined && exact !== null) return exact;
  return p.split(".").reduce((obj, k) => obj?.[k], source);
}

function get(p) {
  if (!loaded) loadLocale(currentLocale);
  const val = getFrom(data, p);
  if (val !== undefined && val !== null) return val;
  return getFrom(fallbackData, p);
}

/**
 * 翻译
 * @param {string} path
 * @param {object} [vars]  占位符变量
 * @returns {string}
 */
export function t(path, vars?) {
  let val = get(path);
  if (val === undefined || val === null) return path;
  if (typeof val !== "string") return val;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      val = val.replaceAll(`{${k}}`, String(v));
    }
  }
  return val;
}

export function getLocale() {
  return currentLocale;
}
