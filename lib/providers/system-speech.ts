/**
 * System speech provider.
 *
 * This declares the local OS/browser speech recognition lane. It is selectable
 * only when a runtime adapter is registered for the current platform.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const systemSpeechPlugin = {
  id: "system-speech",
  displayName: "系统语音识别",
  authType: "none",
  defaultBaseUrl: "",
  defaultApi: "system-speech",
  capabilities: {
    chat: {
      projection: "none",
      runtimeProviderId: "system-speech",
      displayProviderId: "system-speech",
      allowListSource: "none",
    },
    media: {
      speechRecognition: {
        defaultModelId: "system-speech",
        models: [
          { id: "system-speech", displayName: "系统语音识别", protocolId: "system-speech-recognition", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
