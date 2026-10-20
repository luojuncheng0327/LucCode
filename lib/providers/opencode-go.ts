/**
 * OpenCode Go provider plugin.
 *
 * Docs: https://opencode.ai/docs/go/
 * OpenCode Go exposes selected coding-agent models through an OpenAI-compatible
 * `/chat/completions` endpoint at https://opencode.ai/zen/go/v1.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const opencodeGoPlugin = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  authType: "api-key",
  defaultBaseUrl: "https://opencode.ai/zen/go/v1",
  defaultApi: "openai-completions",
};
