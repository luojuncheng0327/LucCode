import {
  hashCacheContractValue,
  stableSerialize,
} from "../lib/llm/cache-prefix-contract.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "../lib/llm/cache-strategy-contract.ts";
import { normalizeRequestThinkingLevel } from "./session-thinking-level.ts";

export const SESSION_CACHE_SNAPSHOT_VERSION = 1;

function normalizeModel(model) {
  return {
    id: model?.id ?? model?.modelId ?? model?.model ?? null,
    provider: model?.provider ?? null,
    api: model?.api ?? null,
    baseUrl: model?.baseUrl ?? model?.base_url ?? null,
  };
}

export function normalizeCacheKeyParams(params = {}) {
  const out = {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return out;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "function" || typeof value === "symbol") continue;
    if (key === "thinkingLevel" || key === "reasoning") {
      out[key] = normalizeRequestThinkingLevel(value, "off");
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function normalizeProviderVisibleTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  return {
    name: tool.name ?? null,
    description: tool.description ?? null,
    parameters: tool.parameters ?? tool.input_schema ?? tool.schema ?? null,
  };
}

export function normalizeProviderVisibleTools(tools = []) {
  return Array.isArray(tools)
    ? tools.map(normalizeProviderVisibleTool).filter((tool) => tool?.name)
    : [];
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") return message ?? null;
  const out = {};
  for (const key of Object.keys(message).sort()) {
    if (key === "timestamp") continue;
    const value = message[key];
    if (value !== undefined && typeof value !== "function" && typeof value !== "symbol") {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeMessagePrefix(messages = [], prefixMessageCount = messages.length) {
  const list = Array.isArray(messages) ? messages : [];
  const count = Math.max(0, Math.min(prefixMessageCount, list.length));
  return list.slice(0, count).map(normalizeMessage);
}

function buildHashes({ model, cacheKeyParams, systemPrompt, tools, messagePrefix }) {
  const modelHash = hashCacheContractValue(model);
  const cacheKeyParamsHash = hashCacheContractValue(cacheKeyParams);
  const systemPromptHash = hashCacheContractValue(systemPrompt);
  const toolSchemaHash = hashCacheContractValue(tools);
  const messagePrefixHash = hashCacheContractValue(messagePrefix);
  const cachePrefixHash = hashCacheContractValue({
    version: SESSION_CACHE_SNAPSHOT_VERSION,
    strategy: CACHE_STRATEGIES.SESSION_SNAPSHOT,
    model,
    cacheKeyParams,
    systemPrompt,
    tools,
    messagePrefix,
  });
  return { modelHash, cacheKeyParamsHash, systemPromptHash, toolSchemaHash, messagePrefixHash, cachePrefixHash };
}

export function buildSessionCacheSnapshot({
  sessionPath = "",
  model = null,
  cacheKeyParams = {},
  systemPrompt = "",
  tools = [],
  messages = [],
  reason = "unknown",
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedModel = normalizeModel(model);
  const requestModel = model && typeof model === "object" && !Array.isArray(model)
    ? model
    : normalizedModel;
  const normalizedParams = normalizeCacheKeyParams(cacheKeyParams);
  const normalizedSystemPrompt = String(systemPrompt || "");
  const normalizedTools = normalizeProviderVisibleTools(tools);
  const normalizedMessages = normalizeMessagePrefix(messages, messages.length);
  const hashes = buildHashes({
    model: normalizedModel,
    cacheKeyParams: normalizedParams,
    systemPrompt: normalizedSystemPrompt,
    tools: normalizedTools,
    messagePrefix: normalizedMessages,
  });
  return {
    version: SESSION_CACHE_SNAPSHOT_VERSION,
    strategy: CACHE_STRATEGIES.SESSION_SNAPSHOT,
    strict: true,
    sessionPath: String(sessionPath || ""),
    reason: String(reason || "unknown"),
    createdAt,
    model: normalizedModel,
    requestModel,
    cacheKeyParams: normalizedParams,
    systemPrompt: normalizedSystemPrompt,
    tools: normalizedTools,
    toolNames: normalizedTools.map((tool) => tool.name),
    messages: normalizedMessages,
    messageCount: normalizedMessages.length,
    ...hashes,
  };
}

export function buildSessionSnapshotRequestContract({
  snapshot,
  model = null,
  cacheKeyParams = {},
  systemPrompt = "",
  tools = [],
  messages = [],
  prefixMessageCount = snapshot?.messageCount ?? 0,
}: {
  snapshot?: any;
  model?: any;
  cacheKeyParams?: any;
  systemPrompt?: string;
  tools?: any[];
  messages?: any[];
  prefixMessageCount?: number;
} = {}) {
  const normalizedModel = normalizeModel(model);
  const normalizedParams = normalizeCacheKeyParams(cacheKeyParams);
  const normalizedSystemPrompt = String(systemPrompt || "");
  const normalizedTools = normalizeProviderVisibleTools(tools);
  const normalizedPrefix = normalizeMessagePrefix(messages, prefixMessageCount);
  return {
    version: SESSION_CACHE_SNAPSHOT_VERSION,
    model: normalizedModel,
    cacheKeyParams: normalizedParams,
    systemPrompt: normalizedSystemPrompt,
    tools: normalizedTools,
    messageCount: normalizedPrefix.length,
    serializedPrefix: stableSerialize({
      model: normalizedModel,
      cacheKeyParams: normalizedParams,
      systemPrompt: normalizedSystemPrompt,
      tools: normalizedTools,
      messages: normalizedPrefix,
    }),
    ...buildHashes({
      model: normalizedModel,
      cacheKeyParams: normalizedParams,
      systemPrompt: normalizedSystemPrompt,
      tools: normalizedTools,
      messagePrefix: normalizedPrefix,
    }),
  };
}

export function assertSessionSnapshotRequest(snapshot, requestContract) {
  const diffs = [];
  for (const field of [
    "modelHash",
    "cacheKeyParamsHash",
    "systemPromptHash",
    "toolSchemaHash",
    "messagePrefixHash",
    "cachePrefixHash",
  ]) {
    if (snapshot?.[field] !== requestContract?.[field]) {
      diffs.push({
        field,
        expected: snapshot?.[field] ?? null,
        actual: requestContract?.[field] ?? null,
      });
    }
  }
  return {
    ok: diffs.length === 0,
    strict: diffs.length === 0,
    diffs,
    metadata: buildCacheStrategyMetadata({
      cacheStrategy: diffs.length === 0 ? CACHE_STRATEGIES.SESSION_SNAPSHOT : CACHE_STRATEGIES.CACHE_RECOVERY,
      cacheGroup: snapshot?.reason || "session_snapshot",
      templateVersion: "v1",
      cachePrefixHash: requestContract?.cachePrefixHash || "",
      parentCachePrefixHash: snapshot?.cachePrefixHash || "",
      strict: diffs.length === 0,
      contractDiffs: diffs,
      degradeReason: diffs.length === 0 ? "" : "session_snapshot_contract_mismatch",
    }),
  };
}
