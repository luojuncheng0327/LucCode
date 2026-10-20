import crypto from "node:crypto";

export const CACHE_PREFIX_CONTRACT_VERSION = 1;

function normalizeValue(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => {
    const normalized = normalizeValue(item);
    return normalized === undefined ? null : normalized;
  });

  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeValue(value[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

export function stableSerialize(value) {
  const serialized = JSON.stringify(normalizeValue(value));
  return serialized === undefined ? "null" : serialized;
}

export function hashCacheContractValue(value) {
  return crypto.createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: model.id ?? model.modelId ?? null,
    provider: model.provider ?? null,
    api: model.api ?? null,
    baseUrl: model.baseUrl ?? model.base_url ?? null,
  };
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  return {
    name: tool.name ?? null,
    description: tool.description ?? null,
    parameters: tool.parameters ?? tool.input_schema ?? tool.schema ?? null,
  };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(normalizeTool).filter(Boolean);
}

export function buildLlmContextCachePrefixContract({
  model = null,
  systemPrompt = "",
  tools = [],
} = {}) {
  const modelContract = normalizeModel(model);
  const systemPromptText = typeof systemPrompt === "string" ? systemPrompt : String(systemPrompt ?? "");
  const toolContracts = normalizeTools(tools);
  const source = {
    version: CACHE_PREFIX_CONTRACT_VERSION,
    model: modelContract,
    systemPrompt: systemPromptText,
    tools: toolContracts,
  };

  return {
    version: CACHE_PREFIX_CONTRACT_VERSION,
    modelHash: hashCacheContractValue(modelContract),
    systemPromptHash: hashCacheContractValue(systemPromptText),
    toolSchemaHash: hashCacheContractValue(toolContracts),
    cachePrefixHash: hashCacheContractValue(source),
    model: modelContract,
    toolNames: toolContracts.map((tool) => tool.name).filter(Boolean),
    toolCount: toolContracts.length,
    systemPromptBytes: Buffer.byteLength(systemPromptText, "utf8"),
    // 原文只留在契约对象里供漂移诊断取证；summarize 出去的摘要永远不带它们，
    // 事件与日志里不应该出现整段 system prompt。
    systemPrompt: systemPromptText,
    tools: toolContracts,
  };
}

export function summarizeCachePrefixContract(contract) {
  if (!contract || typeof contract !== "object") return null;
  return {
    version: contract.version,
    cachePrefixHash: contract.cachePrefixHash,
    modelHash: contract.modelHash,
    systemPromptHash: contract.systemPromptHash,
    toolSchemaHash: contract.toolSchemaHash,
    model: contract.model ?? null,
    toolNames: Array.isArray(contract.toolNames) ? [...contract.toolNames] : [],
    toolCount: contract.toolCount ?? 0,
    systemPromptBytes: contract.systemPromptBytes ?? 0,
  };
}

const DRIFT_EXCERPT_RADIUS = 120;

function contractSystemPromptText(contract) {
  return typeof contract?.systemPrompt === "string" ? contract.systemPrompt : null;
}

function contractSystemPromptBytes(contract, text) {
  if (typeof contract?.systemPromptBytes === "number") return contract.systemPromptBytes;
  return text === null ? 0 : Buffer.byteLength(text, "utf8");
}

function firstDifferenceIndex(expectedText, actualText) {
  if (expectedText === null || actualText === null) return -1;
  const shared = Math.min(expectedText.length, actualText.length);
  for (let i = 0; i < shared; i += 1) {
    if (expectedText[i] !== actualText[i]) return i;
  }
  return expectedText.length === actualText.length ? -1 : shared;
}

function excerptAround(text, index) {
  if (text === null || index < 0) return null;
  return text.slice(Math.max(0, index - DRIFT_EXCERPT_RADIUS), index + DRIFT_EXCERPT_RADIUS + 1);
}

// 旧契约只存哈希，没有原文；那种情况下只能凭 toolNames 说清增删，改动无从判断。
function toolSignatures(contract) {
  const signatures = new Map();
  if (Array.isArray(contract?.tools)) {
    for (const tool of contract.tools) {
      const normalized = normalizeTool(tool);
      if (!normalized?.name) continue;
      signatures.set(normalized.name, stableSerialize(normalized));
    }
    return signatures;
  }
  if (Array.isArray(contract?.toolNames)) {
    for (const name of contract.toolNames) {
      if (!name) continue;
      signatures.set(name, null);
    }
  }
  return signatures;
}

export function describeCachePrefixDrift(expected, actual) {
  const diffs = diffCachePrefixContracts(expected, actual);
  const fields = diffs.map((diff) => diff.field);
  const drift = { fields, systemPrompt: null, tools: null };

  if (fields.includes("systemPromptHash")) {
    const expectedText = contractSystemPromptText(expected);
    const actualText = contractSystemPromptText(actual);
    const firstDiffIndex = firstDifferenceIndex(expectedText, actualText);
    drift.systemPrompt = {
      expectedBytes: contractSystemPromptBytes(expected, expectedText),
      actualBytes: contractSystemPromptBytes(actual, actualText),
      firstDiffIndex,
      expectedExcerpt: excerptAround(expectedText, firstDiffIndex),
      actualExcerpt: excerptAround(actualText, firstDiffIndex),
    };
  }

  if (fields.includes("toolSchemaHash")) {
    const expectedSignatures = toolSignatures(expected);
    const actualSignatures = toolSignatures(actual);
    const added = [];
    const removed = [];
    const changed = [];
    for (const [name, signature] of expectedSignatures) {
      if (!actualSignatures.has(name)) {
        removed.push(name);
        continue;
      }
      const actualSignature = actualSignatures.get(name);
      if (signature !== null && actualSignature !== null && signature !== actualSignature) {
        changed.push(name);
      }
    }
    for (const name of actualSignatures.keys()) {
      if (!expectedSignatures.has(name)) added.push(name);
    }
    drift.tools = {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    };
  }

  return drift;
}

export function diffCachePrefixContracts(expected, actual) {
  const diffs = [];
  for (const field of ["modelHash", "systemPromptHash", "toolSchemaHash", "cachePrefixHash"]) {
    if (expected?.[field] !== actual?.[field]) {
      diffs.push({
        field,
        expected: expected?.[field] ?? null,
        actual: actual?.[field] ?? null,
      });
    }
  }
  return diffs;
}
