/**
 * Fireworks AI provider plugin
 *
 * 文档：https://docs.fireworks.ai
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const fireworksPlugin = {
  id: "fireworks",
  displayName: "Fireworks AI",
  authType: "api-key",
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  defaultApi: "openai-completions",
};
