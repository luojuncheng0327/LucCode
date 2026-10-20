/**
 * Anthropic provider plugin (API key)
 */

/** @type {import('../provider-registry.ts').ProviderPlugin} */
export const anthropicPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  authType: "api-key",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultApi: "anthropic-messages",
};
