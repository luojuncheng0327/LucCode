const VALID_CALL_PURPOSES = new Set([
  "auxiliary_vision",
  "utility",
  "health_check",
  "summary",
  "chat",
]);

function normalizeCallPurpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_CALL_PURPOSES.has(normalized) ? normalized : null;
}

export function buildProviderCompatOptions({
  mode = "utility",
  callPurpose,
  explicitMaxTokens,
  outputBudgetSource,
}: {
  mode?: string;
  callPurpose?: unknown;
  explicitMaxTokens?: number | null;
  outputBudgetSource?: unknown;
} = {}) {
  const normalizedPurpose = normalizeCallPurpose(callPurpose);
  return {
    mode,
    ...(mode === "utility" ? { reasoningLevel: "off" } : {}),
    ...(normalizedPurpose ? { callPurpose: normalizedPurpose } : {}),
    ...(explicitMaxTokens !== null && explicitMaxTokens !== undefined ? { outputBudgetSource } : {}),
  };
}
