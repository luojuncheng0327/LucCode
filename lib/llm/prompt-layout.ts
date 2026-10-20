import crypto from "crypto";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
} from "./cache-strategy-contract.ts";

function hashStablePrefix(parts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

export function buildUtilityPromptLayout({
  cacheGroup,
  templateVersion,
  systemPrompt,
  userContent,
}) {
  const stableSystemPrompt = String(systemPrompt || "");
  const stableTemplateVersion = String(templateVersion || "v1");
  const stableCacheGroup = String(cacheGroup || "utility.unknown");
  return {
    systemPrompt: stableSystemPrompt,
    messages: [{ role: "user", content: String(userContent || "") }],
    usageMetadata: buildCacheStrategyMetadata({
      cacheStrategy: CACHE_STRATEGIES.UTILITY_TEMPLATE,
      cacheGroup: stableCacheGroup,
      templateVersion: stableTemplateVersion,
      cachePrefixHash: hashStablePrefix({
        cacheStrategy: CACHE_STRATEGIES.UTILITY_TEMPLATE,
        cacheGroup: stableCacheGroup,
        templateVersion: stableTemplateVersion,
        systemPrompt: stableSystemPrompt,
      }),
      strict: true,
    }),
  };
}

export function attachPromptLayoutMetadata(usageContext, usageMetadata) {
  return {
    ...(usageContext || {}),
    metadata: {
      ...(usageContext?.metadata || {}),
      ...(usageMetadata || {}),
    },
  };
}
