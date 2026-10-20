/**
 * OpenCode Zen provider plugin.
 *
 * Zen routes each model through its native wire protocol. Keep that protocol
 * on the model declaration instead of forcing the entire provider through one
 * shared API shape.
 */

import { getPiModels } from "../pi-sdk/index.ts";

const models = getPiModels("opencode").map((model) => ({
  id: model.id,
  name: model.name,
  api: model.api,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  image: model.input?.includes?.("image") === true,
  reasoning: model.reasoning === true,
  ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  ...(model.compat ? { compat: model.compat } : {}),
}));

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const opencodePlugin = {
  id: "opencode",
  displayName: "OpenCode Zen",
  authType: "api-key",
  defaultBaseUrl: "https://opencode.ai/zen",
  defaultApi: "anthropic-messages",
  models,
};
