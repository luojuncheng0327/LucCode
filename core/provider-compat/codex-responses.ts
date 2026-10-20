/**
 * OpenAI Codex Responses compatibility layer.
 *
 * Handles models using:
 *   - api === "openai-codex-responses"
 *   - provider ids "openai-codex" / "openai-codex-oauth"
 *
 * Protocol problem:
 *   ChatGPT Codex's Responses endpoint does not accept OpenAI public API output
 *   budget fields or temperature controls in Luc's current OAuth route.
 *
 * Deletion condition:
 *   - Codex Responses accepts these request fields with the same semantics as
 *     public OpenAI Responses, or
 *   - pi-ai exposes a first-class Codex provider serializer that omits them.
 */

const CODEX_RESPONSES_API = "openai-codex-responses";
const CODEX_PROVIDER_IDS = new Set(["openai-codex", "openai-codex-oauth"]);
const UNSUPPORTED_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
  "temperature",
];

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  if (lower(model.api) !== CODEX_RESPONSES_API) return false;
  const provider = lower(model.provider);
  return provider === "" || CODEX_PROVIDER_IDS.has(provider);
}

export function apply(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let changed = false;
  for (const field of UNSUPPORTED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      changed = true;
      break;
    }
  }
  if (!changed) return payload;

  const next = { ...payload };
  for (const field of UNSUPPORTED_FIELDS) {
    delete next[field];
  }
  return next;
}
