export const id = "jimeng-cli";
export const displayName = "即梦 CLI";
export const authType = "none";

// Provider identity is static, while models and mode schemas are discovered
// from the locally installed dreamina executable at runtime. Empty declarations
// keep a failed or unloaded discovery source from advertising stale models.
export const capabilities = {
  chat: {
    projection: "none",
    runtimeProviderId: "jimeng-cli",
    displayProviderId: "jimeng-cli",
  },
  media: {
    imageGeneration: { models: [] },
    videoGeneration: { models: [] },
  },
};
