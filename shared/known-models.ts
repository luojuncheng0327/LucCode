/**
 * known-models.js — 模型词典查询
 *
 * 加载 lib/known-models.json（provider → model 二级结构）
 * 和 lib/known-model-fallbacks.json（model → 通用参考值），
 * 提供 lookupKnown(provider, modelId) 查询接口。
 *
 * 惰性加载：首次调用 lookupKnown() 时才从磁盘读取并解析 JSON，
 * 避免 import 时阻塞模块加载链。
 */
import { readFileSync } from "fs";
import { fromRoot } from "./luc-root.ts";

let _raw = null;
let _fallbacks = null;
let _rawCaseInsensitive = null;
let _fallbacksCaseInsensitive = null;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function _buildCaseInsensitiveIndex(dict) {
  const index = Object.create(null);
  for (const [key, value] of Object.entries(dict || {})) {
    const normalized = key.toLowerCase();
    if (!hasOwn(index, normalized)) {
      index[normalized] = value;
    }
  }
  return index;
}

function _ensureLoaded() {
  if (_raw) return;
  _raw = JSON.parse(readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));
  _fallbacks = JSON.parse(readFileSync(fromRoot("lib", "known-model-fallbacks.json"), "utf-8"));
  _rawCaseInsensitive = Object.fromEntries(
    Object.entries(_raw).map(([provider, models]) => [provider, _buildCaseInsensitiveIndex(models)]),
  );
  _fallbacksCaseInsensitive = _buildCaseInsensitiveIndex(_fallbacks);
}

function _lookupExact(dict, key) {
  if (!dict || typeof key !== "string") return null;
  return hasOwn(dict, key) ? dict[key] : null;
}

function _lookupCaseInsensitive(index, key) {
  if (!index || typeof key !== "string") return null;
  const normalized = key.toLowerCase();
  return hasOwn(index, normalized) ? index[normalized] : null;
}

function _lookupProviderMetadata(provider, modelId) {
  if (!provider || typeof modelId !== "string" || modelId.length === 0) return null;
  const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
  const providerModels = _raw[provider];
  const providerIndex = _rawCaseInsensitive[provider];
  return _lookupExact(providerModels, modelId)
    || (bare ? _lookupExact(providerModels, bare) : null)
    || _lookupCaseInsensitive(providerIndex, modelId)
    || (bare ? _lookupCaseInsensitive(providerIndex, bare) : null)
    || null;
}

function _lookupFallbackMetadata(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
  return _lookupExact(_fallbacks, modelId)
    || (bare ? _lookupExact(_fallbacks, bare) : null)
    || _lookupCaseInsensitive(_fallbacksCaseInsensitive, modelId)
    || (bare ? _lookupCaseInsensitive(_fallbacksCaseInsensitive, bare) : null)
    || null;
}

/**
 * 只查询 provider 自己的精确分区，不回退到通用词典。
 *
 * provider-specific 的协议字段（api / thinkingLevelMap 等）只能使用这个入口，
 * 避免未知代理因为命中了通用 fallback 而继承 OpenAI/OpenRouter 的 wire contract。
 */
export function lookupKnownProvider(provider, modelId) {
  _ensureLoaded();
  return _lookupProviderMetadata(provider, modelId);
}

/**
 * 查询模型元数据并显式返回命中来源。
 * @returns {{ metadata: object, source: "provider" | "fallback" } | null}
 */
export function lookupKnownWithSource(provider, modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  _ensureLoaded();
  const providerMetadata = _lookupProviderMetadata(provider, modelId);
  if (providerMetadata) return { metadata: providerMetadata, source: "provider" };
  const fallbackMetadata = _lookupFallbackMetadata(modelId);
  return fallbackMetadata ? { metadata: fallbackMetadata, source: "fallback" } : null;
}

/**
 * 查词典：provider + modelId 二级查找，再查通用模型参考值。
 * 通用 fallback 是 best-effort baseline，不能从其他 provider 分区隐式借值。
 * @param {string} provider
 * @param {string} modelId
 * @returns {object|null}
 */
export function lookupKnown(provider, modelId) {
  return lookupKnownWithSource(provider, modelId)?.metadata || null;
}

/**
 * 列出某 provider 在词典中显式声明的模型 ID。
 * 调用方只能拿到 ID 列表，不能依赖 known-models.json 的内部结构。
 * @param {string} provider
 * @returns {string[]}
 */
export function listKnownProviderModels(provider) {
  if (typeof provider !== "string" || provider.length === 0) return [];
  _ensureLoaded();
  const providerModels = _raw[provider];
  return providerModels && typeof providerModels === "object"
    ? Object.keys(providerModels)
    : [];
}
