import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "../pi-sdk/index.ts";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "./cache-strategy-contract.ts";
import { stripClosedInternalNarrationBlocks } from "../text/internal-narration.ts";

const SUMMARY_HEADINGS = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Next Steps",
  "Critical Context",
];
const PROGRESS_HEADINGS = ["Done", "In Progress", "Blocked"];
const SUMMARY_HEADING_SEQUENCE = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
];
const INTERNAL_NARRATION_TYPES = ["mood", "pulse", "reflect"] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

type InternalNarrationType = typeof INTERNAL_NARRATION_TYPES[number];

export type CachePreservingCompactionAgentRunDiagnostics = {
  providerRequests: number;
  toolIntentCount: number;
  repaired: boolean;
  sanitizedNarrationTypes: InternalNarrationType[];
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    text: string;
    isError: boolean;
  }>;
};

export interface CachePreservingCompactionCacheMetadata {
  cacheStrategy?: string;
  cacheGroup?: string;
  templateVersion?: string;
  cachePrefixHash?: string;
  parentCachePrefixHash?: string;
  strict?: boolean;
  degradeReason?: string;
  [key: string]: unknown;
}

export interface CachePreservingCompactionUsageLedger {
  start?(meta: {
    model: { provider: string | null; modelId: string | null; api: string | null };
    usageContext: unknown;
    metadata: CachePreservingCompactionCacheMetadata | null;
    costRates: unknown;
  }): { requestId?: string } | null | undefined;
  finish?(requestId: string, result: unknown): unknown;
  recordError?(requestId: string, error: unknown, status?: string, result?: unknown): unknown;
}

export interface CachePreservingCompactionAgentRunOptions {
  liveMessages?: AgentMessage[];
  systemPrompt?: string;
  tools?: AgentTool<any>[];
  model: AgentLoopConfig["model"];
  instruction: AgentMessage;
  streamFn: StreamFn;
  streamOptions?: Record<string, unknown>;
  convertToLlm: AgentLoopConfig["convertToLlm"];
  transformContext?: AgentLoopConfig["transformContext"];
  signal?: AbortSignal;
  usageLedger?: CachePreservingCompactionUsageLedger | null;
  usageContext?: unknown;
  cacheMetadata?: CachePreservingCompactionCacheMetadata | null;
  /** Deliberately ignored: temporary AgentRun events never enter the live event lane. */
  emit?: (event: AgentEvent) => unknown;
}

export interface CachePreservingCompactionAgentRunResult {
  summary: string;
  diagnostics: CachePreservingCompactionAgentRunDiagnostics;
}

type RunnerDiagnostics = CachePreservingCompactionAgentRunDiagnostics;
type RunnerError = Error & { diagnostics?: RunnerDiagnostics };

interface BuildLoopConfigOptions {
  model: AgentLoopConfig["model"];
  convertToLlm: AgentLoopConfig["convertToLlm"];
  transformContext?: AgentLoopConfig["transformContext"];
  streamOptions: Record<string, unknown>;
  shouldStopAfterTurn: NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>;
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function clonePlaceholderTools(tools: any[]): AgentTool<any>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute() {
      return {
        content: textContent(
          "Tool intent was preserved for protocol continuity. No live tool was executed. "
          + "Continue by returning the structured compaction summary without tools.",
        ),
        details: { placeholder: true },
      };
    },
  }));
}

function normalizeThinkingLevel(value: unknown) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return THINKING_LEVELS.has(normalized) ? normalized : "off";
}

function createRepairInstruction(issues: string[], draft: string): AgentMessage {
  return {
    role: "user",
    content: textContent([
      "Internal compaction summary repair.",
      "The previous draft cannot be accepted.",
      "Do not call tools. Do not address the user.",
      `Validation failures:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
      `Return only the repaired summary with these level-two headings exactly once and in order:\n${
        SUMMARY_HEADINGS.map((heading) => `## ${heading}`).join("\n")
      }`,
      `Inside "## Progress", use exactly these level-three headings once and in order:\n${
        PROGRESS_HEADINGS.map((heading) => `### ${heading}`).join("\n")
      }`,
      `<draft-summary>\n${draft}\n</draft-summary>`,
    ].join("\n\n")),
    timestamp: Date.now(),
  };
}

function sanitizeSummary(rawText: string) {
  let text = String(rawText || "");
  const removed = new Set<InternalNarrationType>();

  for (const type of INTERNAL_NARRATION_TYPES) {
    const completeXmlBlock = new RegExp(
      `<${type}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${type}\\s*>`,
      "gi",
    );
    const completeFencedBlock = new RegExp(
      `\`\`\`${type}\\b[\\s\\S]*?\`\`\``,
      "gi",
    );
    if (completeXmlBlock.test(text) || completeFencedBlock.test(text)) {
      removed.add(type);
    }
  }
  text = stripClosedInternalNarrationBlocks(text);
  text = text.replace(/\r?\n[ \t]*\r?\n[ \t]*\r?\n+/g, "\n\n");

  const unmatched = new Set<InternalNarrationType>();
  const remainingTag = /<\/?(mood|pulse|reflect)\b/gi;
  for (const match of text.matchAll(remainingTag)) {
    unmatched.add(match[1].toLowerCase() as InternalNarrationType);
  }
  const remainingFence = /```(mood|pulse|reflect)\b/gi;
  for (const match of text.matchAll(remainingFence)) {
    unmatched.add(match[1].toLowerCase() as InternalNarrationType);
  }

  return {
    text: text.trim(),
    removed: [...removed],
    unmatched: [...unmatched],
  };
}

function validateSummary(text: string, unmatchedNarration: InternalNarrationType[]) {
  const issues: string[] = [];
  if (!text.trim()) issues.push("summary is empty");
  if (unmatchedNarration.length > 0) {
    issues.push(`unmatched internal narration tag(s): ${unmatchedNarration.join(", ")}`);
  }

  const headings = [...text.matchAll(/^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)]
    .map((match) => `${match[1]} ${match[2].trim()}`);
  if (headings.length !== SUMMARY_HEADING_SEQUENCE.length) {
    issues.push(
      `expected ${SUMMARY_HEADING_SEQUENCE.length} structured headings, received ${headings.length}`,
    );
  }
  for (let index = 0; index < SUMMARY_HEADING_SEQUENCE.length; index += 1) {
    if (headings[index] !== SUMMARY_HEADING_SEQUENCE[index]) {
      issues.push(
        `heading ${index + 1} must be "${SUMMARY_HEADING_SEQUENCE[index]}"`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

function extractAssistantText(message: any) {
  return message?.content
    ?.filter((block: any) => block?.type === "text" && typeof block.text === "string")
    ?.map((block: any) => block.text)
    ?.join("\n")
    ?.trim() || "";
}

function latestAssistant(messages: AgentMessage[]) {
  return [...messages].reverse().find((message: any) => message?.role === "assistant") as any;
}

function diagnosticsSnapshot(diagnostics: RunnerDiagnostics): RunnerDiagnostics {
  return {
    ...diagnostics,
    sanitizedNarrationTypes: [...diagnostics.sanitizedNarrationTypes],
    toolResults: diagnostics.toolResults.map((result) => ({ ...result })),
  };
}

function laneError(message: string, diagnostics: RunnerDiagnostics): RunnerError {
  const error: RunnerError = new Error(message);
  error.diagnostics = diagnosticsSnapshot(diagnostics);
  return error;
}

function abortError(message: string, diagnostics: RunnerDiagnostics): RunnerError {
  const error = laneError(message, diagnostics);
  error.name = "AbortError";
  return error;
}

function recoveryMetadata(
  cacheMetadata: CachePreservingCompactionCacheMetadata | null,
  degradeReason: string,
) {
  return buildCacheStrategyMetadata({
    cacheStrategy: CACHE_STRATEGIES.CACHE_RECOVERY,
    cacheGroup: cacheMetadata?.cacheGroup || "compaction.history",
    templateVersion: `${cacheMetadata?.templateVersion || "agent-run.v1"}.repair`,
    cachePrefixHash: "",
    parentCachePrefixHash: cacheMetadata?.cachePrefixHash || "",
    strict: false,
    degradeReason,
  });
}

function modelLedgerIdentity(model: AgentLoopConfig["model"]) {
  return {
    provider: model?.provider ?? null,
    modelId: model?.id ?? null,
    api: model?.api ?? null,
  };
}

function buildLoopConfig({
  model,
  convertToLlm,
  transformContext,
  streamOptions,
  shouldStopAfterTurn,
}: BuildLoopConfigOptions): AgentLoopConfig {
  const options: Record<string, any> = { ...(streamOptions || {}) };
  const requestedThinking = options.thinkingLevel ?? options.reasoning;
  delete options.thinkingLevel;
  delete options.toolChoice;
  delete options.beforeToolCall;
  delete options.afterToolCall;
  delete options.prepareNextTurn;
  delete options.shouldStopAfterTurn;
  delete options.getSteeringMessages;
  delete options.getFollowUpMessages;

  if (requestedThinking !== undefined) {
    const thinkingLevel = normalizeThinkingLevel(requestedThinking);
    if (model?.reasoning && thinkingLevel !== "off") {
      options.reasoning = thinkingLevel;
    } else {
      delete options.reasoning;
    }
  }

  const config: AgentLoopConfig = {
    ...options,
    model,
    convertToLlm,
    toolExecution: "sequential",
    shouldStopAfterTurn,
    getSteeringMessages: async () => [],
    getFollowUpMessages: async () => [],
  };
  if (typeof transformContext === "function") config.transformContext = transformContext;
  return config;
}

export async function runCachePreservingCompactionAgentRun({
  liveMessages = [],
  systemPrompt = "",
  tools = [],
  model,
  instruction,
  streamFn,
  streamOptions = {},
  convertToLlm,
  transformContext,
  signal,
  usageLedger = null,
  usageContext = null,
  cacheMetadata = null,
}: CachePreservingCompactionAgentRunOptions): Promise<CachePreservingCompactionAgentRunResult> {
  if (!model) throw new Error("Cache-preserving compaction AgentRun requires a model");
  if (!instruction) throw new Error("Cache-preserving compaction AgentRun requires an instruction");
  if (typeof streamFn !== "function") {
    throw new Error("Cache-preserving compaction AgentRun requires an isolated stream function");
  }
  if (typeof convertToLlm !== "function") {
    throw new Error("Cache-preserving compaction AgentRun requires convertToLlm");
  }

  const diagnostics: RunnerDiagnostics = {
    providerRequests: 0,
    toolIntentCount: 0,
    repaired: false,
    sanitizedNarrationTypes: [],
    toolResults: [],
  };
  if (signal?.aborted) throw abortError("Cache-preserving compaction AgentRun aborted", diagnostics);

  const placeholderTools = clonePlaceholderTools(Array.isArray(tools) ? tools : []);
  const context: AgentContext = {
    systemPrompt,
    messages: [...(Array.isArray(liveMessages) ? liveMessages : [])],
    tools: placeholderTools,
  };
  const pendingUsage: Array<{ requestId?: string; settled: boolean }> = [];
  let requestPhase: "strict" | "tool_recovery" | "format_repair" = "strict";
  let toolViolation = "";

  const settleUsage = (message: any) => {
    const pending = pendingUsage.find((entry) => !entry.settled);
    if (!pending) return;
    pending.settled = true;
    if (!pending.requestId) return;
    const result = {
      usage: message?.usage,
      model: modelLedgerIdentity(model),
      costRates: model?.cost,
    };
    if (message?.stopReason === "error" || message?.stopReason === "aborted") {
      const error = new Error(message?.errorMessage || message.stopReason);
      usageLedger?.recordError?.(pending.requestId, error, "error", result);
      return;
    }
    usageLedger?.finish?.(pending.requestId, result);
  };

  const localEmit = async (event: AgentEvent) => {
    if (event.type === "message_end" && (event.message as any)?.role === "assistant") {
      settleUsage(event.message);
    }
    if (event.type === "message_end" && (event.message as any)?.role === "toolResult") {
      const message: any = event.message;
      diagnostics.toolResults.push({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: message.content
          ?.filter((block: any) => block?.type === "text")
          ?.map((block: any) => block.text)
          ?.join("\n")
          ?.trim() || "",
        isError: Boolean(message.isError),
      });
    }
  };

  const isolatedStreamFn: StreamFn = async (selectedModel: any, providerContext: any, options: any) => {
    diagnostics.providerRequests += 1;
    const metadata = requestPhase === "strict" && diagnostics.providerRequests === 1
      ? (cacheMetadata ? { ...cacheMetadata } : null)
      : recoveryMetadata(
        cacheMetadata,
        requestPhase === "format_repair" ? "summary_format_repair" : "tool_intent_recovery",
      );
    const usageRequest = usageLedger?.start?.({
      model: modelLedgerIdentity(model),
      usageContext,
      metadata,
      costRates: model?.cost,
    }) || {};
    const pending = { requestId: usageRequest.requestId, settled: false };
    pendingUsage.push(pending);
    try {
      return await streamFn(selectedModel, providerContext, options);
    } catch (error) {
      pending.settled = true;
      if (pending.requestId) usageLedger?.recordError?.(pending.requestId, error);
      throw error;
    }
  };

  const shouldStopAfterTurn = ({ message }: any) => {
    const toolCalls = message?.content?.filter((block: any) => block?.type === "toolCall") || [];
    if (toolCalls.length === 0) return false;
    const previousIntentCount = diagnostics.toolIntentCount;
    diagnostics.toolIntentCount += toolCalls.length;
    if (previousIntentCount > 0 || diagnostics.providerRequests > 1) {
      toolViolation = "Tool intent appeared after the first placeholder recovery turn";
      return true;
    }
    if (toolCalls.length > 1 || diagnostics.toolIntentCount > 1) {
      toolViolation = "Compaction AgentRun tool intent ceiling exceeded";
      return true;
    }
    requestPhase = "tool_recovery";
    return false;
  };

  const config = buildLoopConfig({
    model,
    convertToLlm,
    transformContext,
    streamOptions,
    shouldStopAfterTurn,
  });

  const runTurn = async (prompt: AgentMessage) => {
    try {
      const newMessages = await runAgentLoop(
        [prompt],
        context,
        config,
        localEmit,
        signal,
        isolatedStreamFn,
      );
      context.messages.push(...newMessages);
      return newMessages;
    } catch (error) {
      for (const pending of pendingUsage.filter((entry) => !entry.settled)) {
        pending.settled = true;
        if (pending.requestId) usageLedger?.recordError?.(pending.requestId, error);
      }
      if ((error as RunnerError)?.diagnostics) throw error;
      const wrapped = laneError(
        error instanceof Error ? error.message : String(error),
        diagnostics,
      );
      if (signal?.aborted) wrapped.name = "AbortError";
      throw wrapped;
    }
  };

  const firstMessages = await runTurn(instruction);
  if (toolViolation) throw laneError(toolViolation, diagnostics);
  let finalMessage = latestAssistant(firstMessages);
  if (!finalMessage) throw laneError("Compaction AgentRun returned no assistant message", diagnostics);
  if (finalMessage.stopReason !== "stop") {
    if (signal?.aborted || finalMessage.stopReason === "aborted" && signal) {
      throw abortError("Cache-preserving compaction AgentRun aborted", diagnostics);
    }
    throw laneError(
      `Cache-preserving compaction AgentRun failed with stop reason: ${finalMessage.stopReason}`,
      diagnostics,
    );
  }

  let rawText = extractAssistantText(finalMessage);
  let sanitized = sanitizeSummary(rawText);
  for (const type of sanitized.removed) {
    if (!diagnostics.sanitizedNarrationTypes.includes(type)) {
      diagnostics.sanitizedNarrationTypes.push(type);
    }
  }
  let validation = validateSummary(sanitized.text, sanitized.unmatched);

  if (!validation.ok) {
    diagnostics.repaired = true;
    requestPhase = "format_repair";
    const repairMessages = await runTurn(createRepairInstruction(validation.issues, rawText));
    if (toolViolation) throw laneError(toolViolation, diagnostics);
    finalMessage = latestAssistant(repairMessages);
    if (!finalMessage) {
      throw laneError("Compaction AgentRun repair returned no assistant message", diagnostics);
    }
    if (finalMessage.stopReason !== "stop") {
      if (signal?.aborted || finalMessage.stopReason === "aborted" && signal) {
        throw abortError("Cache-preserving compaction AgentRun repair aborted", diagnostics);
      }
      throw laneError(
        `Cache-preserving compaction AgentRun repair failed with stop reason: ${finalMessage.stopReason}`,
        diagnostics,
      );
    }
    rawText = extractAssistantText(finalMessage);
    sanitized = sanitizeSummary(rawText);
    for (const type of sanitized.removed) {
      if (!diagnostics.sanitizedNarrationTypes.includes(type)) {
        diagnostics.sanitizedNarrationTypes.push(type);
      }
    }
    validation = validateSummary(sanitized.text, sanitized.unmatched);
    if (!validation.ok) {
      throw laneError(
        `Compaction summary invalid after one repair: ${validation.issues.join("; ")}`,
        diagnostics,
      );
    }
  }

  return {
    summary: sanitized.text,
    diagnostics: diagnosticsSnapshot(diagnostics),
  };
}
