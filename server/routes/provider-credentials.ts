import { isMaskedSecretValue } from "../../shared/secret-custody.ts";

export function hasInlineProviderCredentialPatch(block: any) {
  return !!block && typeof block === "object" && (
    Object.prototype.hasOwnProperty.call(block, "api_key")
    || Object.prototype.hasOwnProperty.call(block, "base_url")
  );
}

export function buildInlineProviderCredentialUpdate(block: any, fallbackProvider = "", existingProvider: any = {}) {
  const provider = typeof block?.provider === "string" && block.provider.trim()
    ? block.provider.trim()
    : String(fallbackProvider || "").trim();
  const existing = typeof existingProvider === "function"
    ? existingProvider(provider) || {}
    : existingProvider || {};

  const update: Record<string, any> = {};
  if (Object.prototype.hasOwnProperty.call(block, "api_key")) {
    update.api_key = isMaskedSecretValue(block.api_key)
      ? existing.api_key || ""
      : block.api_key || "";
  }
  if (Object.prototype.hasOwnProperty.call(block, "base_url")) {
    update.base_url = block.base_url || "";
  }

  return { provider, update };
}

export function clearInlineProviderCredentialFields(block: any) {
  if (!block || typeof block !== "object") return;
  block.api_key = "";
  block.base_url = "";
}
