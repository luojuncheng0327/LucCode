/**
 * Tool invocation argument summary shared by live WS events and history hydration.
 *
 * Keep this list intentionally small: these values are rendered in chat UI, so
 * large/sensitive payloads such as file contents must stay out of the summary.
 */
export const TOOL_ARG_SUMMARY_KEYS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "chars",
  "process_id",
  "pattern",
  "url",
  "query",
  "key",
  "value",
  "action",
  "type",
  "schedule",
  "prompt",
  "label",
] as const;

export type ToolArgSummaryKey = typeof TOOL_ARG_SUMMARY_KEYS[number];
export type ToolArgSummary = Partial<Record<ToolArgSummaryKey, unknown>>;

export function summarizeToolArgs(rawArgs: unknown): ToolArgSummary | undefined {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;
  const record = rawArgs as Record<string, unknown>;
  const args: ToolArgSummary = {};
  for (const key of TOOL_ARG_SUMMARY_KEYS) {
    if (record[key] !== undefined) args[key] = record[key];
  }
  return Object.keys(args).length ? args : undefined;
}
