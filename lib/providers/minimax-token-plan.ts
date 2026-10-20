/**
 * MiniMax Token Plan provider plugin (API key)
 *
 * Token Plan uses a subscription key that is not interchangeable with the
 * pay-as-you-go MiniMax API key. Keep a separate provider id even though the
 * current official endpoint/protocol matches the regular MiniMax provider.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const minimaxTokenPlanPlugin = {
  id: "minimax-token-plan",
  displayName: "MiniMax Token Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  defaultApi: "anthropic-messages",
};
