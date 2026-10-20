import { completeSimple } from "../pi-sdk/index.ts";
import {
  assertSessionSnapshotRequest,
  buildSessionSnapshotRequestContract,
} from "../../core/session-cache-snapshot.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "./cache-strategy-contract.ts";
import { normalizeRequestThinkingLevel } from "../../core/session-thinking-level.ts";

function extractText(response) {
  return response?.content
    ?.filter((block) => block?.type === "text" && typeof block.text === "string")
    ?.map((block) => block.text)
    ?.join("\n")
    ?.trim() || "";
}

function isErrorResponse(response) {
  return response?.stopReason === "error" || response?.stopReason === "aborted";
}

function normalizeSideTaskOptions(options: Record<string, any> = {}) {
  const next = { ...(options || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "reasoning")) {
    next.reasoning = normalizeRequestThinkingLevel(next.reasoning, "off");
  }
  if (Object.prototype.hasOwnProperty.call(next, "thinkingLevel")) {
    next.thinkingLevel = normalizeRequestThinkingLevel(next.thinkingLevel, "off");
  }
  return next;
}

export async function runSessionSnapshotSideTask({
  snapshot,
  model,
  cacheKeyParams = {},
  suffixMessage,
  streamFn = null,
  options = {},
  cacheGroup,
  templateVersion = "v1",
  usageLedger = null,
  usageContext = null,
}: Record<string, any> = {}) {
  if (!snapshot || snapshot.strategy !== CACHE_STRATEGIES.SESSION_SNAPSHOT) {
    throw new Error("Session snapshot side task requires a session snapshot");
  }
  if (!suffixMessage) throw new Error("Session snapshot side task requires a suffix message");
  if (!model) throw new Error("Session snapshot side task requires a model");

  const requestOptions = normalizeSideTaskOptions(options);
  const messages = [...(Array.isArray(snapshot.messages) ? snapshot.messages : []), suffixMessage];
  const context = {
    systemPrompt: snapshot.systemPrompt,
    tools: snapshot.tools || [],
    messages,
  };
  const requestContract = buildSessionSnapshotRequestContract({
    snapshot,
    model,
    cacheKeyParams,
    systemPrompt: context.systemPrompt,
    tools: context.tools,
    messages: context.messages,
    prefixMessageCount: snapshot.messageCount,
  } as any);
  const assertion = assertSessionSnapshotRequest(snapshot, requestContract);
  if (!assertion.ok) {
    const fields = assertion.diffs.map((diff) => diff.field).join(", ");
    throw new Error(`Session snapshot request is not strict: ${fields}`);
  }

  const metadata = buildCacheStrategyMetadata({
    cacheStrategy: CACHE_STRATEGIES.SESSION_SNAPSHOT,
    cacheGroup,
    templateVersion,
    cachePrefixHash: requestContract.cachePrefixHash,
    parentCachePrefixHash: snapshot.cachePrefixHash,
    strict: true,
  } as any);
  const usageRequest = usageLedger?.start?.({
    model: { provider: model?.provider ?? null, modelId: model?.id ?? null, api: model?.api ?? null },
    usageContext,
    metadata,
    costRates: model?.cost,
  }) || null;

  let response;
  try {
    response = streamFn
      ? await (await streamFn(model, context, requestOptions)).result()
      : await completeSimple(model, context, requestOptions);
  } catch (error) {
    if (usageRequest?.requestId) usageLedger?.recordError?.(usageRequest.requestId, error);
    throw error;
  }
  if (isErrorResponse(response)) {
    const error = new Error(response.errorMessage || response.stopReason || "session snapshot side task failed");
    if (usageRequest?.requestId) usageLedger?.recordError?.(usageRequest.requestId, error, "error", { usage: response?.usage });
    throw error;
  }
  usageLedger?.finish?.(usageRequest?.requestId, {
    usage: response?.usage,
    model: { provider: model?.provider ?? null, modelId: model?.id ?? null, api: model?.api ?? null },
    costRates: model?.cost,
  });
  return {
    response,
    text: extractText(response),
    context,
    options: requestOptions,
    metadata,
  };
}
