/**
 * Luc cache-preserving compaction Pi SDK Extension
 *
 * 三层防护，防 session 因上下文超限而死锁，同时避免 Pi SDK 原生
 * summarizer 走冷启动请求破坏 prompt cache：
 *
 *   L1 (tool_result hook)：
 *     单条 tool_result 的 text 内容超过 maxToolResultBytes 字节时，
 *     做 head+tail 截断，中间塞省略标记。
 *     防"一次工具调用返回 200KB 直接把 session 推过悬崖"。
 *
 *   L3 (session_before_compact hook)：
 *     pi SDK 进入压缩流程时，分别估算完整缓存前缀请求与原生摘要请求。
 *     两者都超过 contextWindow * hardTruncateThreshold 时才走硬截断；
 *     仅完整前缀请求超限时，auto 模式交回原生摘要，显式模式取消。
 *     两者都可容纳时，追加一条内部压缩指令到原会话前缀后面，让主模型
 *     在同一 prompt cache 前缀上生成 summary，并通过 hook 返回 compaction。
 *
 *   L2（非 hook，session 创建时安装的运行时覆写）：
 *     compaction 的 reserveTokens 不再是固定值，而是按模型窗口推导：
 *     max(16384, 10% × contextWindow)，等价于把触发点放在
 *     min(90% 窗口, 窗口 − 16384)——两者取小。百万级窗口下固定 16384
 *     会让触发点贴到 98% 以上，实际压不了；按比例留白才能给 tool_result
 *     累积留出 buffer。
 *     另外，一轮 agentic run 中途的压缩走 agent loop 的 per-turn 接缝
 *     （prepareNextTurnWithContext）触发，不经过本扩展的任何 hook。
 *
 * 纪律：
 *   - 零 pi SDK 改动，全走官方 ExtensionAPI
 *   - 不调用任何私有方法（不碰 _overflowRecoveryAttempted / _runAutoCompaction）
 *   - 失败路径：auto 模式下 cache-preserving 链路失败时返回 undefined，让 Pi 原生 summarizer 接手；
 *     显式 cache_preserving 模式仍 cancel，保留严格诊断能力
 */

import { computeHardTruncation, truncateTextHeadTail } from "../../core/compaction-utils.ts";
import {
  COMPACTION_OUTPUT_POLICIES,
  buildCachePreservingCompactionPrefix,
  createCachePreservingCompactionResult,
  getCachePreservingCompactionMaxTokens,
  isCompactionHistoryReplayError,
  normalizeCompactionProviderPayload,
  projectMessagesToLatestCompactionUsageEpoch,
  shouldHardTruncateCachePreservingCompaction,
  stripInlineMediaFromCompactionPreparation,
} from "../../core/session-compactor.ts";
import {
  normalizeProviderContextMessages,
} from "../../core/provider-compat.ts";
import {
  isReasoningReplayUnavailable,
  reasoningReplayCanClear,
} from "../../core/provider-compat/reasoning-content-replay.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "../llm/cache-strategy-contract.ts";
import { withProviderCacheAffinity } from "../llm/provider-cache-affinity.ts";
import {
  COMPACTION_MODES,
  normalizeCompactionMode,
} from "../../shared/compaction-mode.ts";
import { convertAgentMessagesToLlm } from "../pi-sdk/index.ts";
import { createModuleLogger } from "../debug-log.ts";
import { normalizeRequestThinkingLevel } from "../../core/session-thinking-level.ts";

const log = createModuleLogger("compaction-guard");

export class CompactionSessionOwnershipError extends Error {
  code = "COMPACTION_SESSION_OWNERSHIP_UNPROVEN";
  sessionPath: any;

  constructor(message: string, sessionPath: any = null) {
    super(message);
    this.name = "CompactionSessionOwnershipError";
    this.sessionPath = sessionPath;
  }
}

const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024; // 32KB ≈ 8K token
const DEFAULT_HARD_TRUNCATE_THRESHOLD = 0.85;    // 两种摘要请求都超 85% 窗口 → 硬截断

function hardTruncateFromPreparation(event: any, ctx: any, preparation: any) {
  const sm = ctx.sessionManager;
  const pathEntries = event.branchEntries || sm?.getBranch?.() || [];
  const keepRecentTokens = preparation.settings?.keepRecentTokens ?? 20_000;

  return {
    keepRecentTokens,
    pathEntries,
    truncation: computeHardTruncation(pathEntries, keepRecentTokens, {
      summary: "[由于对话过长且摘要请求本身会超限，早期对话历史已被硬截断（luc-cache-preserving-compaction）]",
      reason: "compaction-guard-hard-truncate",
    }),
  };
}

function readThinkingLevel(ctx: any) {
  try {
    const level = ctx?.getThinkingLevel?.();
    if (typeof level === "string") return level;
  } catch {
    // Older or stale extension contexts may not expose getThinkingLevel.
  }
  try {
    const level = ctx?.sessionManager?.buildSessionContext?.()?.thinkingLevel;
    return typeof level === "string" ? level : undefined;
  } catch {
    return undefined;
  }
}

function snapshotCacheKeyParams(snapshot: any, fallbackThinkingLevel: any) {
  const fallback = normalizeRequestThinkingLevel(fallbackThinkingLevel, "off");
  const normalizeParams = (params) => {
    const out = { ...(params || {}) };
    out.thinkingLevel = normalizeRequestThinkingLevel(out.thinkingLevel || fallback, "off");
    if (Object.prototype.hasOwnProperty.call(out, "reasoning")) {
      out.reasoning = normalizeRequestThinkingLevel(out.reasoning, "off");
    }
    return out;
  };
  if (snapshot?.cacheKeyParams && typeof snapshot.cacheKeyParams === "object" && !Array.isArray(snapshot.cacheKeyParams)) {
    return normalizeParams(snapshot.cacheKeyParams);
  }
  return normalizeParams({ thinkingLevel: fallback });
}

/**
 * Factory。
 * @param {object} [opts]
 * @param {number} [opts.maxToolResultBytes=32768] - L1 单条 tool_result text 字节上限
 * @param {number} [opts.hardTruncateThreshold=0.85] - L3 触发硬截断的窗口占比
 * @returns {(pi: object) => void}
 */
export function createCompactionGuardExtension(opts: Record<string, any> = {}) {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const hardTruncateThreshold = opts.hardTruncateThreshold ?? DEFAULT_HARD_TRUNCATE_THRESHOLD;
  const cacheCompactor = opts.cacheCompactor ?? createCachePreservingCompactionResult;
  const usageLedger = opts.usageLedger || null;
  const buildUsageContext = typeof opts.buildUsageContext === "function" ? opts.buildUsageContext : null;
  const getCompactionMode = typeof opts.getCompactionMode === "function"
    ? opts.getCompactionMode
    : () => COMPACTION_MODES.AUTO;
  const buildSessionCacheSnapshot = typeof opts.buildSessionCacheSnapshot === "function"
    ? opts.buildSessionCacheSnapshot
    : null;
  const getSessionProviderCacheAffinityKey = typeof opts.getSessionProviderCacheAffinityKey === "function"
    ? opts.getSessionProviderCacheAffinityKey
    : null;
  const getSessionTransformContext = typeof opts.getSessionTransformContext === "function"
    ? opts.getSessionTransformContext
    : null;
  const getSessionAgentRunRuntime = typeof opts.getSessionAgentRunRuntime === "function"
    ? opts.getSessionAgentRunRuntime
    : null;
  // Provider quirks that a live request applies to its payload have to apply to
  // the compaction request too: the two share a cache prefix, so normalizing
  // them differently breaks the cache. This reads the same per-session options
  // the live path reads, from the same place, rather than restating them.
  const getProviderCompatOptions = typeof opts.getProviderCompatOptions === "function"
    ? opts.getProviderCompatOptions
    : null;
  // Same reason, one layer up: whether this request reasons at all, and at which
  // level, is decided for the whole session in one place. Deriving it here from
  // the session's thinking level alone gave a different answer than the live
  // request whenever the preference had a say, and the compaction request then
  // rode a prefix that did not exist.
  const getRequestReasoningLevel = typeof opts.getRequestReasoningLevel === "function"
    ? opts.getRequestReasoningLevel
    : null;

  function resolveReasoningLevelForRequest(ctx: any) {
    if (!getRequestReasoningLevel) {
      throw new CompactionSessionOwnershipError(
        "Cache-preserving compaction requires the shared request reasoning level resolver",
        ctx?.sessionManager?.getSessionFile?.() || null,
      );
    }
    return getRequestReasoningLevel(ctx);
  }

  function readCompactionMode(event: any, ctx: any) {
    try {
      return normalizeCompactionMode(getCompactionMode({ event, ctx }));
    } catch (err) {
      log.warn(`[L3] compaction mode resolver failed, using auto: ${err?.message || err}`);
      return COMPACTION_MODES.AUTO;
    }
  }

  function fallBackToPiNative(reason: string) {
    log.warn(`[L3] cache-preserving compaction unavailable; falling back to Pi SDK native summarizer: ${reason}`);
    return undefined;
  }

  return function (pi) {
    // A live compactionSummary starts a new usage epoch. Retained assistant
    // messages are ordered after that summary but still carry usage from the
    // old, much larger prompt. Pi AI's output clamp reads that usage before it
    // builds the provider payload, so clear it only in this context projection.
    pi.on("context", (event) => {
      const messages = projectMessagesToLatestCompactionUsageEpoch(event.messages);
      return messages === event.messages ? undefined : { messages };
    });

    // ── L1: tool_result 单条硬限 ──
    pi.on("tool_result", (event) => {
      try {
        // 错误返回保留完整，帮 debug
        if (event.isError) return undefined;
        if (!Array.isArray(event.content)) return undefined;

        let changed = false;
        const newContent = event.content.map((block) => {
          if (!block || block.type !== "text" || typeof block.text !== "string") return block;
          const res = truncateTextHeadTail(block.text, { maxBytes: maxToolResultBytes });
          if (!res.truncated) return block;
          changed = true;
          log.log(
            `[L1] tool_result text truncated: tool=${event.toolName || "?"} ` +
            `original=${res.originalBytes}B → ${Buffer.byteLength(res.text, "utf8")}B`
          );
          return { ...block, text: res.text };
        });

        if (changed) return { content: newContent };
        return undefined;
      } catch (err) {
        log.warn(`[L1] tool_result hook error (passthrough): ${err?.message || err}`);
        return undefined;
      }
    });

    // ── L3: 压缩前预判，必败时走硬截断 ──
    pi.on("session_before_compact", async (event, ctx) => {
      let allowNativeFallback = false;
      try {
        const rawPreparation = event?.preparation;
        if (!rawPreparation) return { cancel: true };

        const compactionMode = readCompactionMode(event, ctx);
        if (compactionMode === COMPACTION_MODES.PI_COMPATIBLE) {
          log.log("[L3] pi-compatible compaction selected; falling through to Pi SDK native summarizer");
          return undefined;
        }
        allowNativeFallback = compactionMode === COMPACTION_MODES.AUTO;

        const model = ctx?.model;
        if (!model) return { cancel: true };

        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0) return { cancel: true };
        if (event.signal?.aborted) return { cancel: true };
        const sessionPath = ctx.sessionManager?.getSessionFile?.() || null;
        if (!sessionPath) {
          throw new CompactionSessionOwnershipError(
            "Cache-preserving compaction requires an explicit session path",
          );
        }
        if (!getSessionTransformContext) {
          throw new CompactionSessionOwnershipError(
            "Cache-preserving compaction requires a session ownership resolver",
            sessionPath,
          );
        }
        const transformContext = getSessionTransformContext(sessionPath);
        if (typeof transformContext !== "function") {
          throw new CompactionSessionOwnershipError(
            `Cache-preserving compaction session ownership is unresolved: ${sessionPath}`,
            sessionPath,
          );
        }
        if (!getSessionAgentRunRuntime) {
          throw new CompactionSessionOwnershipError(
            "Cache-preserving compaction requires a keyed AgentRun runtime resolver",
            sessionPath,
          );
        }
        const agentRunRuntime = getSessionAgentRunRuntime(sessionPath);
        if (
          typeof agentRunRuntime?.streamFn !== "function"
          || !Array.isArray(agentRunRuntime?.tools)
        ) {
          throw new CompactionSessionOwnershipError(
            `Cache-preserving compaction AgentRun runtime is incomplete: ${sessionPath}`,
            sessionPath,
          );
        }
        const runtimeStreamOptions = (
          agentRunRuntime.streamOptions
          && typeof agentRunRuntime.streamOptions === "object"
          && !Array.isArray(agentRunRuntime.streamOptions)
        )
          ? agentRunRuntime.streamOptions
          : {};
        const runtimeTools = agentRunRuntime.tools;

        const builtContext = ctx.sessionManager?.buildSessionContext?.();
        const rawMessages = Array.isArray(builtContext?.messages)
          ? builtContext.messages
          : [];
        const preparation = stripInlineMediaFromCompactionPreparation(rawPreparation);
        // The thinking level is the session's own, because it keys the cache
        // entry; the reasoning level the request carries is the session-wide
        // answer, because it shapes the body the cache entry was written from.
        const thinkingLevel = normalizeRequestThinkingLevel(readThinkingLevel(ctx), "off");
        const reasoningLevel = resolveReasoningLevelForRequest(ctx);
        let reasoningReplay = "preserve";
        let cacheMetadataOverride = null;
        const systemPrompt = ctx.getSystemPrompt?.() || builtContext?.systemPrompt || "";
        const buildPrefix = (requestReplay) => buildCachePreservingCompactionPrefix({
          liveMessages: rawMessages,
          preparation: rawPreparation,
          model,
          customInstructions: event.customInstructions,
          transformContext,
          convertToLlm: convertAgentMessagesToLlm,
          normalizeMessages: (providerMessages) => normalizeProviderContextMessages(
            providerMessages,
            model,
            {
              mode: "chat",
              reasoningLevel,
              reasoningReplay: requestReplay,
            },
          ),
          signal: event.signal,
        });
        let prefix;
        try {
          prefix = await buildPrefix(reasoningReplay);
        } catch (err) {
          if (!isReasoningReplayUnavailable(err) || !reasoningReplayCanClear(model)) throw err;
          reasoningReplay = "clear";
          cacheMetadataOverride = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          } as any);
          prefix = await buildPrefix(reasoningReplay);
          log.warn(`[L3] cache recovery compaction: reasoning replay unavailable, historical thinking cleared for this compaction`);
        }
        if (prefix.historyRecovery) {
          cacheMetadataOverride = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "malformed_reasoning_history_trim",
          });
          log.warn(
            `[L3] cache recovery compaction: removed ${prefix.historyRecovery.removedMessageCount} `
            + `provider-visible messages at a complete old-history tool boundary`,
          );
        }
        const messages = prefix.messages;
        const fit = shouldHardTruncateCachePreservingCompaction({
          preparation: rawPreparation,
          messages,
          retainedMessageCount: prefix.retainedMessageCount,
          model,
          instruction: prefix.instruction,
          systemPrompt,
          tools: runtimeTools,
          customInstructions: event.customInstructions,
          hardTruncateThreshold,
        });
        if (fit.shouldHardTruncate) {
          const { keepRecentTokens, truncation } = hardTruncateFromPreparation(event, ctx, preparation);
          if (!truncation) {
            log.warn(
              `[L3] hard-truncate unavailable for cache-preserving request: ` +
              `cacheTokens=${fit.cachePreservingBudget.totalTokens} ` +
              `nativeTokens=${fit.nativeSummaryBudget.totalTokens} ` +
              `threshold=${fit.threshold} contextWindow=${fit.contextWindow}`
            );
            return { cancel: true };
          }
          log.log(
            `[L3] compaction requests hard-truncate: cacheTokens=${fit.cachePreservingBudget.totalTokens} ` +
            `nativeTokens=${fit.nativeSummaryBudget.totalTokens} ` +
            `> threshold=${fit.threshold} (ctx=${fit.contextWindow}), keep=${keepRecentTokens}`
          );
          return { compaction: truncation };
        }
        if (fit.shouldUseNativeFallback) {
          const reason = (
            `full-prefix request exceeds threshold while Pi native request fits ` +
            `(A=${fit.cachePreservingBudget.totalTokens}, B=${fit.nativeSummaryBudget.totalTokens}, ` +
            `threshold=${fit.threshold})`
          );
          return allowNativeFallback ? fallBackToPiNative(reason) : { cancel: true };
        }

        const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
        if (!auth?.ok) {
          log.warn(`[L3] model auth unavailable for cache-preserving compaction: ${auth?.error || model.id}`);
          if (allowNativeFallback) {
            return fallBackToPiNative(`model auth unavailable for cache-preserving compaction: ${auth?.error || model.id}`);
          }
          return { cancel: true };
        }
        const sessionSnapshot = buildSessionCacheSnapshot
          ? buildSessionCacheSnapshot(sessionPath, {
            reason: "compaction.history",
            messages,
          })
          : null;
        const requestCacheKeyParams = cacheMetadataOverride
          ? {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay,
          }
          : snapshotCacheKeyParams(sessionSnapshot, thinkingLevel);
        const requestThinkingLevel = typeof requestCacheKeyParams.thinkingLevel === "string"
          ? normalizeRequestThinkingLevel(requestCacheKeyParams.thinkingLevel, "off")
          : normalizeRequestThinkingLevel(thinkingLevel, "off");

        const providerCacheAffinityKey = getSessionProviderCacheAffinityKey?.(sessionPath)
          || ctx.sessionManager?.getSessionId?.();
        const buildCompactorRequest = ({
          requestMessages = messages,
          requestInstruction = prefix.instruction,
          requestRetainedMessageCount = prefix.retainedMessageCount,
          requestReplay = reasoningReplay,
          requestMetadataOverride = cacheMetadataOverride,
          requestKeyParams = requestCacheKeyParams,
          requestThinking = requestMetadataOverride ? thinkingLevel : requestThinkingLevel,
          // The cache key can be recovered from the snapshot, but the reasoning
          // the body carries stays the session's one answer either way: a
          // request that reasons differently than the live requests it follows
          // cannot ride their prefix, whichever key it is filed under.
          requestReasoning = reasoningLevel,
          requestHistoryRecovery = prefix.historyRecovery,
        } = {}) => ({
          preparation,
          model,
          systemPrompt,
          messages: requestMessages,
          retainedMessageCount: requestRetainedMessageCount,
          instruction: requestInstruction,
          messagesAreNormalized: true,
          tools: runtimeTools,
          sessionSnapshot,
          cacheKeyParams: requestKeyParams,
          cacheMetadataOverride: requestMetadataOverride,
          customInstructions: event.customInstructions,
          signal: event.signal,
          thinkingLevel: requestThinking,
          reasoningLevel: requestReasoning,
          outputPolicy: COMPACTION_OUTPUT_POLICIES.PROVIDER_DEFAULT,
          streamFn: agentRunRuntime.streamFn,
          streamOptions: withProviderCacheAffinity({
            ...runtimeStreamOptions,
            apiKey: auth.apiKey,
            headers: {
              ...(runtimeStreamOptions.headers || {}),
              ...(auth.headers || {}),
            },
            sessionId: runtimeStreamOptions.sessionId ?? ctx.sessionManager?.getSessionId?.(),
            onPayload: async (payload, requestModel) => {
              const ordinaryPayload = typeof runtimeStreamOptions.onPayload === "function"
                ? await runtimeStreamOptions.onPayload(payload, requestModel || model)
                : undefined;
              return normalizeCompactionProviderPayload(
                ordinaryPayload === undefined ? payload : ordinaryPayload,
                requestModel || model,
                {
                  ...(getProviderCompatOptions?.(sessionPath) || {}),
                  outputPolicy: COMPACTION_OUTPUT_POLICIES.PROVIDER_DEFAULT,
                  boundedMaxTokens: getCachePreservingCompactionMaxTokens(preparation),
                  reasoningLevel: requestReasoning,
                  reasoningReplay: requestReplay,
                },
              );
            },
          }, model, providerCacheAffinityKey),
          convertToLlm: async (input: any[]) => input,
          usageLedger,
          usageContext: buildUsageContext?.({ event, ctx, model }) || null,
          historyRecovery: requestHistoryRecovery,
        });

        async function retryWithClearedReasoningReplay(originalError: any) {
          if (
            !isReasoningReplayUnavailable(originalError)
            || reasoningReplay === "clear"
            || !reasoningReplayCanClear(model)
          ) {
            throw originalError;
          }
          const recoveryMetadata = buildCacheStrategyMetadata({
            cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
            cacheGroup: "compaction.history",
            templateVersion: "v1",
            strict: false,
            degradeReason: "reasoning_replay_unavailable",
          } as any);
          const recoveryPrefix = await buildPrefix("clear");
          const recoveryCacheKeyParams = {
            thinkingLevel: normalizeRequestThinkingLevel(thinkingLevel, "off"),
            reasoningReplay: "clear",
          };
          log.warn(`[L3] cache recovery compaction: reasoning replay failed during request build, retrying with historical thinking cleared`);
          return await cacheCompactor(buildCompactorRequest({
            requestMessages: recoveryPrefix.messages,
            requestInstruction: recoveryPrefix.instruction,
            requestRetainedMessageCount: recoveryPrefix.retainedMessageCount,
            requestReplay: "clear",
            requestMetadataOverride: recoveryMetadata,
            requestKeyParams: recoveryCacheKeyParams,
            requestThinking: thinkingLevel,
            requestReasoning: reasoningLevel,
            requestHistoryRecovery: recoveryPrefix.historyRecovery,
          }));
        }

        let compaction;
        try {
          compaction = await cacheCompactor(buildCompactorRequest());
        } catch (err) {
          compaction = await retryWithClearedReasoningReplay(err);
        }

        log.log(
          `[L3] cache-preserving compaction: tokensBefore=${compaction.tokensBefore} ` +
          `firstKept=${compaction.firstKeptEntryId}`
        );
        return { compaction };
      } catch (err) {
        // An aborted compaction is finished, not failed. Handing it to the
        // native summarizer would start a fresh uncached request for a result
        // nobody is waiting for any more, so stop here even in auto mode.
        if (event.signal?.aborted || err?.name === "AbortError") {
          log.log("[L3] cache-preserving compaction aborted; stopping without a native summary");
          return { cancel: true };
        }
        if (isCompactionHistoryReplayError(err)) {
          throw err;
        }
        if (allowNativeFallback) {
          return fallBackToPiNative(err?.message || String(err));
        }
        log.warn(`[L3] session_before_compact hook error (cancelled): ${err?.message || err}`);
        return { cancel: true };
      }
    });
  };
}
