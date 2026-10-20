/**
 * Xiaomi MiMo provider plugin
 *
 * 文档：https://dev.mi.com/mimo-open-platform
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const mimoPlugin = {
  id: "mimo",
  displayName: "Xiaomi (MiMo)",
  authType: "api-key",
  defaultBaseUrl: "https://api.xiaomimimo.com/v1",
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
