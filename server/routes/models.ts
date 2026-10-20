/**
 * 模型管理 REST 路由
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { t } from "../../lib/i18n.ts";
import { modelRefEquals, parseModelRef } from "../../shared/model-ref.ts";
import { lookupKnown } from "../../shared/known-models.ts";
import {
  modelSupportsAudioInput,
  modelSupportsImageInput,
  modelSupportsDirectAudioInput,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
  normalizeToolUseContract,
  resolveModelAudioInputTransport,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";
import { callText } from "../../core/llm-client.ts";
import { callTextConfigFromResolvedModel } from "../../core/model-execution-config.ts";
import { getModelThinkingLevels, modelSupportsXhigh, resolveModelDefaultThinkingLevel } from "../../core/session-thinking-level.ts";

const HEALTH_CHECK_PROMPT = "Reply exactly OK.";
const HEALTH_CHECK_MAX_TOKENS = 128;

/** 查询模型显示名：overrides > SDK name > known-models > id */
function resolveModelName(id, sdkName, overrides, provider) {
  if (overrides?.[id]?.displayName) return overrides[id].displayName;
  if (sdkName && sdkName !== id) return sdkName;
  const known = lookupKnown(provider, id);
  if (known?.name) return known.name;
  return sdkName || id;
}

function parseHealthModelRef(body) {
  const parsed = parseModelRef(body?.model ?? body?.modelId);
  if (!parsed?.id) return { error: "modelId required" };

  const bodyProvider = typeof body.provider === "string" ? body.provider.trim() : "";
  if (parsed.provider && bodyProvider && parsed.provider !== bodyProvider) {
    return { error: "provider mismatch" };
  }

  const provider = bodyProvider || parsed.provider;
  if (!provider) return { error: "provider required" };
  return { id: parsed.id, provider };
}

function classifyModelSwitchError(err) {
  const message = err?.message || String(err || "");
  if (err?.code === "MODEL_CONTEXT_TOO_LARGE") {
    return { status: 409, code: "MODEL_CONTEXT_TOO_LARGE", message };
  }
  const lower = message.toLowerCase();
  if (lower.includes("model not found") || (lower.includes("模型") && lower.includes("不存在"))) {
    return { status: 404, code: "MODEL_NOT_FOUND", message };
  }
  if (
    lower.includes("api key") ||
    lower.includes("api_key") ||
    lower.includes("credential") ||
    lower.includes("credentials") ||
    lower.includes("凭证") ||
    lower.includes("密钥")
  ) {
    return { status: 422, code: "MODEL_CREDENTIALS_MISSING", message };
  }
  if (
    lower.includes("streaming") ||
    lower.includes("compaction") ||
    lower.includes("compacting") ||
    lower.includes("in progress") ||
    lower.includes("busy")
  ) {
    return { status: 409, code: "MODEL_SWITCH_CONFLICT", message };
  }
  return { status: 500, code: "MODEL_SWITCH_FAILED", message };
}

function serializeModelInfo(model, { current = null, overrides = null } = {}) {
  if (!model) return null;
  const videoTransport = resolveModelVideoInputTransport(model);
  const audioTransport = resolveModelAudioInputTransport(model);
  const toolUse = normalizeToolUseContract(model.toolUse);
  return {
    id: model.id,
    name: resolveModelName(model.id, model.name, overrides, model.provider),
    provider: model.provider,
    ...(current !== null ? { isCurrent: modelRefEquals(model, current) } : {}),
    input: Array.isArray(model.input) ? model.input : ["text"],
    video: modelSupportsVideoInput(model),
    videoTransport,
    videoTransportSupported: modelSupportsDirectVideoInput(model),
    audio: modelSupportsAudioInput(model),
    audioTransport,
    audioTransportSupported: modelSupportsDirectAudioInput(model),
    reasoning: model.reasoning,
    thinkingLevels: getModelThinkingLevels(model),
    defaultThinkingLevel: resolveModelDefaultThinkingLevel(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(modelSupportsXhigh(model) ? { xhigh: true } : {}),
    ...(toolUse ? { toolUse } : {}),
  };
}

function serializeAuxiliaryVisionModel(model, fallbackRef = null) {
  const parsedFallback = parseModelRef(fallbackRef);
  const id = typeof model?.id === "string" && model.id.trim()
    ? model.id.trim()
    : parsedFallback?.id;
  const provider = typeof model?.provider === "string" && model.provider.trim()
    ? model.provider.trim()
    : parsedFallback?.provider;
  if (!id || !provider) return null;
  return { id, provider };
}

function buildAuxiliaryVisionStatus(engine) {
  const shared = engine.getSharedModels?.() || {};
  const enabled = shared.vision_enabled === true;
  const configured = !!shared.vision;
  const configuredModel = serializeAuxiliaryVisionModel(null, shared.vision);

  if (!enabled) {
    return {
      enabled: false,
      configured,
      available: false,
      unavailableReason: "disabled",
      model: configuredModel,
    };
  }

  if (!configured) {
    return {
      enabled: true,
      configured: false,
      available: false,
      unavailableReason: "not_configured",
      model: null,
    };
  }

  let resolved = null;
  try {
    resolved = engine.resolveModelWithCredentials?.(shared.vision) || null;
  } catch {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_not_found",
      model: configuredModel,
    };
  }

  const model = serializeAuxiliaryVisionModel(resolved?.model, shared.vision);
  if (!resolved?.model) {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_not_found",
      model,
    };
  }

  if (!modelSupportsImageInput(resolved.model)) {
    return {
      enabled: true,
      configured: true,
      available: false,
      unavailableReason: "model_without_image_input",
      model,
    };
  }

  return {
    enabled: true,
    configured: true,
    available: true,
    unavailableReason: null,
    model,
  };
}

export function createModelsRoute(engine) {
  const route = new Hono();

  // 列出可用模型
  route.get("/models", async (c) => {
    try {
      const overrides = engine.config?.models?.overrides;
      const cur = engine.currentModel;
      const activeModel = engine.activeSessionModel;
      const models = engine.availableModels.map(m => serializeModelInfo(m, { current: cur, overrides }));
      return c.json({
        models,
        current: cur?.id || null,
        activeModel: activeModel ? { id: activeModel.id, provider: activeModel.provider } : null,
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 只暴露辅助视觉可用性给 chat surface；不返回设置页的搜索/API 配置。
  route.get("/models/auxiliary-vision", async (c) => {
    try {
      return c.json({ auxiliaryVision: buildAuxiliaryVisionStatus(engine) });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 健康检测：走真实 utility LLM 调用入口，验证模型存在、凭证有效、provider 兼容层可用。
  // 契约：必须提供显式复合模型引用（{id, provider} 或 modelId + provider），无按 id 兜底。
  route.post("/models/health", async (c) => {
    try {
      const body = await safeJson(c);
      const modelRef = parseHealthModelRef(body);
      if (modelRef.error) return c.json({ error: modelRef.error }, 400);

      // 统一凭证解析（找模型 + 拿凭证一步到位）
      const resolved = await engine.resolveModelWithCredentialsFresh(modelRef);

      // Codex Responses API 无法简单探测
      if (resolved.api === "openai-codex-responses") {
        return c.json({ ok: true, status: 0, provider: resolved.provider, skipped: t("error.codexNoHealthCheck") });
      }

      await callText({
        ...callTextConfigFromResolvedModel(resolved),
        temperature: undefined as any,
        signal: undefined as any,
        messages: [{ role: "user", content: HEALTH_CHECK_PROMPT }],
        maxTokens: HEALTH_CHECK_MAX_TOKENS,
        timeoutMs: 15_000,
        usageLedger: engine.usageLedger,
        usageContext: {
          source: {
            subsystem: "utility",
            operation: "model_health",
            surface: "settings",
            trigger: "user",
          },
          attribution: {
            kind: "utility",
            // A health probe from the settings panel is the product checking a
            // provider, not an agent doing work. Billing it to whichever agent
            // the server is focused on would put a cost on that agent's usage
            // account for something it never did, so it stays unattributed.
            agentId: null,
          },
        },
      });

      return c.json({ ok: true, status: 200, provider: resolved.provider });
    } catch (err) {
      return c.json({
        ok: false,
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.context?.reason ? { reason: err.context.reason } : {}),
      });
    }
  });

  // 切换模型（下次 createSession 生效，不改活跃 session）
  route.post("/models/set", async (c) => {
    try {
      const body = await safeJson(c);
      const { modelId, provider } = body;
      if (!modelId) {
        return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      }
      if (!provider) {
        return c.json({ error: t("error.missingParam", { param: "provider" }) }, 400);
      }
      engine.setPendingModel(modelId, provider);
      return c.json({
        ok: true,
        model: engine.currentModel?.name,
        pendingModel: true,
        thinkingLevel: engine.getDefaultThinkingLevel?.() || engine.getThinkingLevel?.() || "medium",
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 会话内切换模型
  route.post("/models/switch", async (c) => {
    try {
      const body = await safeJson(c);
      const { sessionPath, modelId, provider } = body;
      if (!sessionPath) return c.json({ error: t("error.missingParam", { param: "sessionPath" }) }, 400);
      if (!modelId) return c.json({ error: t("error.missingParam", { param: "modelId" }) }, 400);
      if (!provider) return c.json({ error: t("error.missingParam", { param: "provider" }) }, 400);

      if (engine.isSessionStreaming(sessionPath)) {
        return c.json({ error: "cannot switch model while streaming", code: "MODEL_SWITCH_CONFLICT" }, 409);
      }

      const result = await engine.switchSessionModel(sessionPath, modelId, provider);

      // Build model info for response
      const session = engine.getSessionByPath(sessionPath);
      const sessionModel = session?.model;
      const overrides = engine.config?.models?.overrides;
      const modelInfo = serializeModelInfo(sessionModel, { overrides });

      return c.json({ ok: true, model: modelInfo, adaptations: result.adaptations, thinkingLevel: result.thinkingLevel });
    } catch (err) {
      const classified = classifyModelSwitchError(err);
      return c.json({ error: classified.message, code: classified.code }, classified.status as any);
    }
  });

  return route;
}
