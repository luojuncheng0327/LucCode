/**
 * Xiaomi MiMo Token Plan provider plugin (API key)
 *
 * Token Plan uses tp- subscription keys against the OpenAI-compatible /v1
 * endpoint. Keep it separate from regular MiMo credentials and do not route
 * STT through the independent Anthropic-compatible endpoint family.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const mimoTokenPlanPlugin = {
  id: "mimo-token-plan",
  displayName: "Xiaomi MiMo Token Plan",
  authType: "api-key",
  defaultBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      speechRecognition: {
        defaultModelId: "mimo-v2.5-asr",
        models: [
          { id: "mimo-v2.5-asr", displayName: "MiMo V2.5 ASR", protocolId: "mimo-chat-completions-asr", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
