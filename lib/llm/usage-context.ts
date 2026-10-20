export const UNKNOWN_USAGE_CONTEXT = Object.freeze({
  source: Object.freeze({
    subsystem: "unknown",
    operation: "unknown",
    surface: "unknown",
    trigger: "unknown",
  }),
  attribution: Object.freeze({ kind: "unknown" }),
});

export function normalizeUsageContext(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return UNKNOWN_USAGE_CONTEXT;
  }

  const sourceInput = isRecord(input.source) ? input.source : {};
  const attributionInput = isRecord(input.attribution) ? input.attribution : {};
  const source: Record<string, any> = {
    subsystem: stringOr(sourceInput.subsystem, "unknown"),
    operation: stringOr(sourceInput.operation, "unknown"),
    surface: stringOr(sourceInput.surface, "unknown"),
    trigger: stringOr(sourceInput.trigger, "unknown"),
  };
  if (isRecord(sourceInput.parent)) source.parent = { ...sourceInput.parent };
  if (isRecord(sourceInput.actor)) source.actor = { ...sourceInput.actor };

  return {
    source,
    attribution: stringOr(attributionInput.kind, "")
      ? { ...attributionInput, kind: stringOr(attributionInput.kind, "unknown") }
      : { kind: "unknown" },
  };
}

export function isUnknownUsageContext(ctx) {
  return !ctx
    || ctx.source?.subsystem === "unknown"
    || ctx.source?.operation === "unknown"
    || ctx.attribution?.kind === "unknown";
}

export function attributionSessionPath(attribution) {
  if (!attribution || typeof attribution !== "object") return null;
  return typeof attribution.sessionPath === "string" && attribution.sessionPath
    ? attribution.sessionPath
    : null;
}

export function attributionSessionId(attribution) {
  if (!attribution || typeof attribution !== "object") return null;
  return typeof attribution.sessionId === "string" && attribution.sessionId.trim()
    ? attribution.sessionId.trim()
    : null;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
