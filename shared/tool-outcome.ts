export type ToolOutcomeStatus = "succeeded" | "failed" | "unknown";

export type ToolOutcome = {
  status: ToolOutcomeStatus;
  success: boolean;
  error?: string;
};

type ToolResultLike = {
  role?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  content?: unknown;
  details?: unknown;
};

const ERROR_TEXT_MAX_LENGTH = 240;
const LEGACY_ERROR_CODE_RE = /^(?:TOOL_|STOP_TASK_|EXEC_COMMAND_|WRITE_STDIN_)/;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function shortText(value: string): string {
  if (value.length <= ERROR_TEXT_MAX_LENGTH) return value;
  return `${value.slice(0, ERROR_TEXT_MAX_LENGTH - 1)}…`;
}

function soleTextBlock(content: unknown): string | null {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = recordOf(content[0]);
  if (block?.type !== "text") return null;
  return nonEmptyText(block.text);
}

function resultErrorText(result: ToolResultLike): string | null {
  const details = recordOf(result.details);
  return nonEmptyText(details?.error) || soleTextBlock(result.content);
}

/**
 * Read-time compatibility for Luc results written before toolError carried
 * Pi's explicit isError bit. Keep this deliberately narrow: plugin-specific
 * details.error values are diagnostics unless they match Luc's old helper
 * shape exactly.
 */
export function isKnownLegacyLucToolFailure(result: ToolResultLike): boolean {
  const details = recordOf(result.details);
  const errorCode = nonEmptyText(details?.errorCode);
  if (errorCode && (LEGACY_ERROR_CODE_RE.test(errorCode) || errorCode === "mcp_unavailable")) {
    return true;
  }

  const confirmation = recordOf(details?.confirmation);
  if (confirmation?.status === "needs_user_approval_but_unavailable") return true;

  const execCommand = recordOf(details?.execCommand);
  if (execCommand?.ok === false) return true;

  const error = nonEmptyText(details?.error);
  const contentText = soleTextBlock(result.content);
  return !!error && error === contentText;
}

export function projectLiveToolResultOutcome(result: ToolResultLike): ToolOutcome {
  if (result?.isError !== true) return { status: "succeeded", success: true };
  const error = resultErrorText(result);
  return {
    status: "failed",
    success: false,
    ...(error ? { error: shortText(error) } : {}),
  };
}

export function projectToolResultOutcome(result: ToolResultLike): ToolOutcome {
  if (result?.isError === true) return projectLiveToolResultOutcome(result);
  if (!isKnownLegacyLucToolFailure(result)) return { status: "succeeded", success: true };
  const error = resultErrorText(result);
  return { status: "failed", success: false, ...(error ? { error: shortText(error) } : {}) };
}

export function collectToolOutcomesByCallId(messages: unknown): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  if (!Array.isArray(messages)) return outcomes;
  for (const message of messages) {
    const result = recordOf(message) as ToolResultLike | null;
    if (!result || result.role !== "toolResult") continue;
    const toolCallId = nonEmptyText(result.toolCallId);
    if (!toolCallId) continue;
    outcomes.set(toolCallId, projectToolResultOutcome(result));
  }
  return outcomes;
}

export function projectKnownLegacyToolFailures(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const projected = messages.map((message) => {
    const result = recordOf(message) as ToolResultLike | null;
    if (
      !result
      || result.role !== "toolResult"
      || result.isError === true
      || !isKnownLegacyLucToolFailure(result)
    ) {
      return message;
    }
    changed = true;
    return { ...result, isError: true };
  });
  return changed ? projected : messages;
}
