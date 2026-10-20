import { callTextConfigFromUtilityConfig } from "../core/model-execution-config.ts";
import { createModuleLogger } from "./debug-log.ts";

const ALLOWED_ACTIONS = new Set(["allow", "deny_and_continue", "ask_user", "hard_deny"]);
const REVIEWER_ACTIONS = new Set([...ALLOWED_ACTIONS, "escalate"]);
const FORMAT_FAILURE_CODES = new Set([
  "reviewer_empty_response",
  "reviewer_invalid_json",
  "reviewer_invalid_action",
]);
const SAFE_ERROR_CODES = new Set([
  "LLM_TIMEOUT",
  "LLM_EMPTY_RESPONSE",
  "LLM_AUTH_FAILED",
  "LLM_RATE_LIMITED",
  "FETCH_TIMEOUT",
  "FETCH_SERVER_ERROR",
]);
const REVIEWER_FAILURE_CODES = new Set([
  "reviewer_not_configured",
  "reviewer_config_missing",
  "reviewer_config_unavailable",
  "reviewer_empty_response",
  "reviewer_invalid_json",
  "reviewer_invalid_action",
  "reviewer_timeout",
  "reviewer_auth_failed",
  "reviewer_rate_limited",
  "reviewer_transport_error",
  "reviewer_internal_error",
]);
const reviewerLog = createModuleLogger("approval-reviewer");
type ReviewerId = "small_tool_model" | "large_tool_model";
type ReviewerRole = "utility" | "utility_large";
type ReviewerFailure = {
  kind: "failure";
  reasonCode: string;
  attempts: number;
  errorCode?: string;
  reviewer?: ReviewerId;
};
type ReviewerCandidate = {
  kind: "decision";
  decision: Record<string, unknown>;
  attempts: number;
};
type ReviewerAttemptResult = ReviewerCandidate | ReviewerFailure;
const REVIEWER_SYSTEM_PROMPT = `You are Luc's automatic tool approval reviewer.
Decide whether the requested tool action may run under Auto mode without interrupting the user.
Return JSON only, with this shape:
{"action":"allow|deny_and_continue|ask_user|escalate","reason":"short concrete reason","risk":"low|medium|high|critical","saferAlternative":"optional safer next step","ruleIds":["optional-policy-id"]}

Rules:
- You replace only the human approval decision. You do not expand the sandbox, writable roots, network policy, app capability, or SafetyPolicy.
- Hard safety requests such as credential exposure, destructive deletion outside the authorized workspace, or actions that bypass explicit user confirmation should already be blocked before review; if one reaches you, do not approve it.
- Allow only when the requested action is clearly within the user's visible intent and the supplied trustEnvironment.
- Use ask_user when intent, target, trustEnvironment, or blast radius is unclear. In Auto mode this means the action will not run; it is not a request to interrupt the user.
- Use deny_and_continue when the agent should choose a safer path without asking.
- If you are the small reviewer, allow only obvious low-risk in-scope actions; otherwise use escalate, ask_user, or deny_and_continue.
- If you are the large reviewer, make the final risk decision from the supplied request and trust context.`;
const REVIEWER_FAILURE_REASON = "Automatic approval review could not produce a valid decision.";
const REVIEWER_UNAVAILABLE_REASON = "Automatic approval reviewer unavailable.";
const MAX_REVIEWER_REASON_LENGTH = 240;

function deterministicDecision(request: any = {}) {
  if (isDeferredMutationDraft(request)) {
    return {
      action: "allow",
      reviewer: "policy",
      reason: request.sideEffect?.summary || "Tool action only creates a draft; persistent writes require explicit confirmation.",
      risk: "low",
      ruleIds: [request.sideEffect?.ruleId || "automation-draft-no-write"],
    };
  }
  return null;
}

function isDeferredMutationDraft(request: any = {}) {
  const sideEffect = request.sideEffect;
  return sideEffect?.kind === "deferred_mutation_draft"
    && sideEffect?.commit === "requires_user_confirmation";
}

function normalizeRisk(value, fallback = "medium") {
  return value === "low" || value === "medium" || value === "high" || value === "critical"
    ? value
    : fallback;
}

function normalizeReviewerDecision(raw, reviewer) {
  if (!raw || typeof raw !== "object") return null;
  if (!REVIEWER_ACTIONS.has(raw.action)) return null;
  if (reviewer === "large_tool_model" && raw.action === "escalate") return null;
  const risk = normalizeRisk(raw.risk, raw.action === "allow" ? "medium" : "high");
  if (raw.action === "escalate") {
    return {
      action: "escalate",
      reviewer,
      reason: normalizeReviewerText(raw.reason, "reviewer requested escalation"),
      reasonCode: "reviewer_requested_escalation",
      risk,
      ruleIds: normalizeRuleIds(raw.ruleIds),
    };
  }
  if (reviewer === "small_tool_model" && raw.action === "allow" && (risk === "high" || risk === "critical")) {
    return {
      action: "escalate",
      reviewer,
      reason: normalizeReviewerText(raw.reason, "small reviewer escalated high-risk approval"),
      reasonCode: "reviewer_requested_escalation",
      risk,
      ruleIds: normalizeRuleIds(raw.ruleIds),
    };
  }
  return {
    action: raw.action,
    reviewer,
    reason: normalizeReviewerText(raw.reason, `${reviewer} reviewer decision`),
    reasonCode: reviewerDecisionReasonCode(raw.action),
    risk,
    saferAlternative: typeof raw.saferAlternative === "string" ? raw.saferAlternative : undefined,
    ruleIds: normalizeRuleIds(raw.ruleIds),
  };
}

function normalizeReviewerText(value, fallback) {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
  return (normalized || fallback).slice(0, MAX_REVIEWER_REASON_LENGTH);
}

function normalizeRuleIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, 12)
    .map((item) => item.trim().slice(0, 120));
}

function reviewerDecisionReasonCode(action) {
  if (action === "allow") return "reviewer_allowed";
  if (action === "deny_and_continue") return "reviewer_denied";
  if (action === "hard_deny") return "reviewer_hard_denied";
  return "reviewer_requested_user_confirmation";
}

function reviewerFailureSummary(result) {
  return {
    reviewer: result.reviewer,
    reasonCode: result.reasonCode,
    attempts: result.attempts,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

function fallbackAskUser(failures: ReviewerFailure[] = []) {
  const summaries = failures.map(reviewerFailureSummary);
  const unavailable = summaries.length === 0
    || summaries.every((failure) => failure.reasonCode === "reviewer_not_configured");
  const reasonCode = unavailable ? "approval_reviewer_unavailable" : "approval_review_failed";
  return {
    action: "ask_user",
    reviewer: "policy",
    reason: unavailable ? REVIEWER_UNAVAILABLE_REASON : REVIEWER_FAILURE_REASON,
    reasonCode,
    risk: "medium",
    ruleIds: [reasonCode],
    ...(summaries.length ? { reviewerFailures: summaries } : {}),
  };
}

function buildReviewerInput(request: any, context: any = {}) {
  return {
    request,
    userIntentSummary: context.userIntentSummary || "",
    explicitUserAuthorization: context.explicitUserAuthorization || "",
    sessionPermissionMode: "auto",
    trustEnvironment: {
      cwd: context.cwd || null,
      workspaceFolders: Array.isArray(context.workspaceFolders) ? context.workspaceFolders : [],
      authorizedFolders: Array.isArray(context.authorizedFolders) ? context.authorizedFolders : [],
      knownRemotes: Array.isArray(context.knownRemotes) ? context.knownRemotes : [],
      knownDomains: Array.isArray(context.knownDomains) ? context.knownDomains : [],
      executionContext: context.executionContext || "",
    },
    visibleTranscript: Array.isArray(context.visibleTranscript) ? context.visibleTranscript : [],
    recentApprovalHistory: Array.isArray(context.recentApprovalHistory) ? context.recentApprovalHistory : [],
  };
}

function failureResult(reasonCode, attempts, errorCode?: string): ReviewerFailure {
  return {
    kind: "failure",
    reasonCode,
    attempts,
    ...(errorCode ? { errorCode } : {}),
  };
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return SAFE_ERROR_CODES.has(code) ? code : undefined;
}

function failureFromError(error, attempts, stage: "config" | "call"): ReviewerFailure {
  const errorCode = safeErrorCode(error);
  if (stage === "config") {
    if (errorCode === "LLM_AUTH_FAILED") {
      return failureResult("reviewer_auth_failed", attempts, errorCode);
    }
    return failureResult("reviewer_config_unavailable", attempts, errorCode);
  }
  if (errorCode === "LLM_EMPTY_RESPONSE") {
    return failureResult("reviewer_empty_response", attempts, errorCode);
  }
  if (errorCode === "LLM_TIMEOUT" || errorCode === "FETCH_TIMEOUT") {
    return failureResult("reviewer_timeout", attempts, errorCode);
  }
  if (errorCode === "LLM_AUTH_FAILED") {
    return failureResult("reviewer_auth_failed", attempts, errorCode);
  }
  if (errorCode === "LLM_RATE_LIMITED") {
    return failureResult("reviewer_rate_limited", attempts, errorCode);
  }
  return failureResult("reviewer_transport_error", attempts, errorCode);
}

function parseReviewerOutput(text, role: ReviewerRole, attempts): ReviewerAttemptResult {
  if (typeof text !== "string" || !text.trim()) {
    return failureResult("reviewer_empty_response", attempts);
  }
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  let raw;
  try {
    raw = JSON.parse(candidate);
  } catch {
    // A provider may wrap the JSON object in explanatory text; try the bounded object slice below.
  }
  if (raw === undefined) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        raw = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Classified as reviewer_invalid_json after the bounded parse attempts finish.
      }
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return failureResult("reviewer_invalid_json", attempts);
  }
  if (!REVIEWER_ACTIONS.has(raw.action) || (role === "utility_large" && raw.action === "escalate")) {
    return failureResult("reviewer_invalid_action", attempts);
  }
  return { kind: "decision", decision: raw as Record<string, unknown>, attempts };
}

function compactReviewerInput(value, depth = 0) {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  if (!value || typeof value !== "object") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactReviewerInput(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    out[key] = compactReviewerInput(item, depth + 1);
  }
  return out;
}

function configForReviewerRole(config, role) {
  return callTextConfigFromUtilityConfig(config, role);
}

export function createModelApprovalReviewer({
  role = "utility",
  resolveUtilityConfig,
  callText,
  timeoutMs = 15_000,
  maxTokens = 220,
}: any = {}) {
  return async (input) => {
    if (typeof resolveUtilityConfig !== "function") {
      return failureResult("reviewer_not_configured", 0);
    }
    if (typeof callText !== "function") {
      return failureResult("reviewer_not_configured", 0);
    }
    const request = input?.request || {};
    const utilityOptions = {
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.sessionPath ? { sessionPath: request.sessionPath } : {}),
    };
    let config;
    try {
      config = await resolveUtilityConfig(Object.keys(utilityOptions).length ? utilityOptions : undefined);
    } catch (error) {
      return failureFromError(error, 0, "config");
    }
    const selected = configForReviewerRole(config, role);
    if (!selected.model || !selected.api || !selected.baseUrl) {
      return failureResult("reviewer_config_missing", 0);
    }
    let priorFormatFailure = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages = [{
        role: "user",
        content: JSON.stringify(compactReviewerInput(input)),
      }];
      if (priorFormatFailure) {
        messages.push({
          role: "user",
          content: `The previous response failed schema validation (${priorFormatFailure}). Return exactly one JSON object using an allowed action and no surrounding text.`,
        });
      }
      let result: ReviewerAttemptResult;
      try {
        const text = await callText({
          ...selected,
          systemPrompt: REVIEWER_SYSTEM_PROMPT,
          messages,
          temperature: 0,
          maxTokens,
          timeoutMs,
          usageContext: `approval_reviewer_${role}`,
        });
        result = parseReviewerOutput(text, role, attempt);
      } catch (error) {
        result = failureFromError(error, attempt, "call");
      }
      if (result.kind === "decision") return result;
      if (attempt === 1 && FORMAT_FAILURE_CODES.has(result.reasonCode)) {
        priorFormatFailure = result.reasonCode;
        continue;
      }
      return result;
    }
    return failureResult("reviewer_internal_error", 2);
  };
}

function sanitizeReturnedFailure(raw, attempts): ReviewerFailure {
  const reasonCode = REVIEWER_FAILURE_CODES.has(raw?.reasonCode)
    ? raw.reasonCode
    : "reviewer_internal_error";
  const errorCode = typeof raw?.errorCode === "string" && SAFE_ERROR_CODES.has(raw.errorCode)
    ? raw.errorCode
    : undefined;
  const normalizedAttempts = Number.isInteger(raw?.attempts) && raw.attempts >= 0
    ? Math.min(raw.attempts, 2)
    : attempts;
  return failureResult(reasonCode, normalizedAttempts, errorCode);
}

function normalizeReviewerReturn(raw, reviewer: ReviewerId, attempts): ReviewerAttemptResult {
  if (raw?.kind === "failure") return sanitizeReturnedFailure(raw, attempts);
  const returnedAttempts = raw?.kind === "decision" && Number.isInteger(raw.attempts)
    ? Math.min(Math.max(raw.attempts, 1), 2)
    : attempts;
  const candidate = raw?.kind === "decision" ? raw.decision : raw;
  if (typeof candidate === "string" || candidate == null) {
    return parseReviewerOutput(
      typeof candidate === "string" ? candidate : "",
      reviewer === "large_tool_model" ? "utility_large" : "utility",
      returnedAttempts,
    );
  }
  const decision = normalizeReviewerDecision(candidate, reviewer);
  if (!decision) return failureResult("reviewer_invalid_action", returnedAttempts);
  return { kind: "decision", decision, attempts: returnedAttempts };
}

function logReviewerFailure(result: ReviewerFailure) {
  const errorCode = result.errorCode ? ` errorCode=${result.errorCode}` : "";
  reviewerLog.warn(
    `reviewer=${result.reviewer || "unknown"} outcome=failure reasonCode=${result.reasonCode} attempts=${result.attempts}${errorCode}`,
  );
}

async function callReviewer(fn, input, reviewer: ReviewerId) {
  if (typeof fn !== "function") {
    return { ...failureResult("reviewer_not_configured", 0), reviewer };
  }
  let priorFormatFailure = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let result: ReviewerAttemptResult;
    try {
      const raw = attempt > 1
        ? await fn(input, { attempt, formatCorrection: priorFormatFailure })
        : await fn(input);
      result = normalizeReviewerReturn(raw, reviewer, attempt);
    } catch (error) {
      result = failureFromError(error, attempt, "call");
    }
    if (result.kind === "decision") return result;
    if (attempt === 1 && result.attempts < 2 && FORMAT_FAILURE_CODES.has(result.reasonCode)) {
      priorFormatFailure = result.reasonCode;
      continue;
    }
    const failure = { ...result, reviewer };
    logReviewerFailure(failure);
    return failure;
  }
  const failure = { ...failureResult("reviewer_internal_error", 2), reviewer };
  logReviewerFailure(failure);
  return failure;
}

function isLowRiskAllow(result) {
  return result?.kind === "decision"
    && result.decision?.action === "allow"
    && result.decision.risk === "low";
}

function isAllowedReviewerAction(result) {
  return result?.kind === "decision" && ALLOWED_ACTIONS.has(result.decision?.action);
}

function isConservativeDecision(result) {
  return isAllowedReviewerAction(result) && result.decision.action !== "allow";
}

function failuresFromResults(...results): ReviewerFailure[] {
  return results.filter((result) => result?.kind === "failure");
}

function decisionWithFailures(result, ...failures) {
  const summaries = failuresFromResults(...failures).map(reviewerFailureSummary);
  return {
    ...result.decision,
    ...(summaries.length ? { reviewerFailures: summaries } : {}),
  };
}

export function createApprovalGateway({
  smallToolModelReviewer = null,
  largeToolModelReviewer = null,
} = {}) {
  return {
    async review(request, context = {}) {
      const policyDecision = deterministicDecision(request);
      if (policyDecision) return policyDecision;

      const reviewerInput = buildReviewerInput(request, context);
      const smallDecision = await callReviewer(
        smallToolModelReviewer,
        reviewerInput,
        "small_tool_model",
      );
      const hasLargeReviewer = typeof largeToolModelReviewer === "function";
      if (isLowRiskAllow(smallDecision)) {
        return decisionWithFailures(smallDecision);
      }
      if (!hasLargeReviewer && isConservativeDecision(smallDecision)) {
        return decisionWithFailures(smallDecision);
      }

      const largeDecision = await callReviewer(
        largeToolModelReviewer,
        reviewerInput,
        "large_tool_model",
      );
      if (isAllowedReviewerAction(largeDecision)) {
        return decisionWithFailures(largeDecision, smallDecision);
      }
      if (isConservativeDecision(smallDecision)) {
        return decisionWithFailures(smallDecision, largeDecision);
      }

      return fallbackAskUser(failuresFromResults(smallDecision, largeDecision));
    },
  };
}
