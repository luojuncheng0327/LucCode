import {
  XAI_OAUTH_RESOURCE_URL,
  xaiOAuthProvider,
} from "../auth/xai-oauth.ts";
import {
  buildXaiOauthCliModelHeaders,
  buildXaiOauthCliProviderHeaders,
} from "./xai-oauth-cli-headers.ts";

const XAI_OAUTH_CLI_PROVIDER_HEADERS = buildXaiOauthCliProviderHeaders();

const GROK_OAUTH_MODELS = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    api: "openai-responses",
    context: 500_000,
    maxOutput: 128_000,
    image: true,
    reasoning: true,
  },
  {
    id: "grok-4.5-latest",
    name: "Grok 4.5 Latest",
    api: "openai-responses",
    context: 500_000,
    maxOutput: 128_000,
    image: true,
    reasoning: true,
  },
  {
    id: "grok-build-latest",
    name: "Grok Build Latest",
    api: "openai-responses",
    context: 500_000,
    maxOutput: 128_000,
    image: true,
    reasoning: true,
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    api: "openai-responses",
    context: 1_000_000,
    maxOutput: 128_000,
    image: true,
    reasoning: true,
  },
];

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const xaiOAuthPlugin = {
  id: "xai-oauth",
  displayName: "xAI Grok (OAuth)",
  authType: "oauth",
  authJsonKey: "xai-oauth",
  defaultBaseUrl: XAI_OAUTH_RESOURCE_URL,
  defaultApi: "openai-responses",
  headers: XAI_OAUTH_CLI_PROVIDER_HEADERS,
  models: GROK_OAUTH_MODELS,
  modelExecutionHeaders: buildXaiOauthCliModelHeaders,
  capabilities: {
    chat: {
      runtimeProviderId: "xai-oauth",
      displayProviderId: "xai-oauth",
      projection: "models-json",
      credentialSource: "auth-storage",
      allowListSource: "provider.models",
    },
  },
  runtime: {
    kind: "oauth-http",
    protocolId: "openai-responses",
    allowedBaseUrlOrigins: ["https://cli-chat-proxy.grok.com"],
  },
  sdkProvider: {
    providerId: "xai-oauth",
    config: {
      name: "xAI Grok (OAuth)",
      baseUrl: XAI_OAUTH_RESOURCE_URL,
      api: "openai-responses",
      headers: XAI_OAUTH_CLI_PROVIDER_HEADERS,
      oauth: xaiOAuthProvider,
    },
  },
};
