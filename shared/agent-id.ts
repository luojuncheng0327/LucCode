/**
 * Canonical Agent ID contract.
 *
 * Agent IDs are durable identity keys and directory names. The accepted
 * alphabet deliberately excludes Unicode, whitespace, dots, and path syntax
 * so the same value is safe on macOS, Linux, Windows, URLs, and MCP
 * identifiers. Existing safe ASCII IDs may contain uppercase letters and
 * underscores; display names remain fully Unicode.
 */

export const AGENT_ID_MAX_LENGTH = 64;
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

export class InvalidAgentIdError extends Error {
  declare code: "INVALID_AGENT_ID";
  declare statusCode: 400;
  declare agentId: unknown;

  constructor(agentId: unknown) {
    const preview = JSON.stringify(String(agentId ?? "").slice(0, 80));
    super(
      `Invalid agent ID ${preview}: use 1-${AGENT_ID_MAX_LENGTH} ASCII letters, digits, underscores, or hyphens, `
      + "and include at least one letter or digit.",
    );
    this.name = "InvalidAgentIdError";
    this.code = "INVALID_AGENT_ID";
    this.statusCode = 400;
    this.agentId = agentId;
  }
}

export function isValidAgentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > AGENT_ID_MAX_LENGTH) return false;
  if (!AGENT_ID_PATTERN.test(value)) return false;
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return !WINDOWS_RESERVED_NAMES.has(value.toLowerCase());
}

export function assertValidAgentId(value: unknown): asserts value is string {
  if (!isValidAgentId(value)) throw new InvalidAgentIdError(value);
}
