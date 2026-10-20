/**
 * Grok CLI chat-proxy request markers for xai-oauth.
 *
 * cli-chat-proxy.grok.com requires these headers (Cherry Studio / pi-grok-build
 * contract). Missing x-grok-client-version surfaces as HTTP 426 with version
 * "(none)". Floor from that error is >= 0.1.202; we pin near current
 * @xai-official/grok rather than Cherry's stale 0.2.16.
 */

export const GROK_CLI_CLIENT_VERSION = "0.2.95";
export const GROK_CLI_CLIENT_IDENTIFIER = "luc";

export function buildXaiOauthCliProviderHeaders(): Record<string, string> {
  return {
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": GROK_CLI_CLIENT_VERSION,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
  };
}

export function buildXaiOauthCliModelHeaders(modelId: string): Record<string, string> {
  const id = String(modelId || "").trim().toLowerCase().split("/").pop() || "";
  if (!id) return {};
  return { "x-grok-model-override": id };
}
