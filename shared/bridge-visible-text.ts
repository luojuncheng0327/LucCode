const BRIDGE_TIME_TAG_RE = /<t>\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*<\/t>/gi;

export function sanitizeBridgeVisibleText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.replace(BRIDGE_TIME_TAG_RE, "").replace(/^[ \t]+/, "");
}
