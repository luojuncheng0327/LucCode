export const RUNTIME_API_KEY_PREFIX = "luc-runtime-api-key:";

export function buildRuntimeApiKeyRef(providerId) {
  return `${RUNTIME_API_KEY_PREFIX}${providerId}`;
}

