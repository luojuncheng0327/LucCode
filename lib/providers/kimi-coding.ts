/**
 * Kimi Coding Plan provider plugin
 *
 * 月之暗面 Kimi 会员 Coding 权益，按官方推荐走 OpenAI-compatible 协议。
 * 与 moonshot (OpenAI 兼容) 是同一厂商的不同接入方式。
 *
 * 文档：https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents.html
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const kimiCodingPlugin = {
  id: "kimi-coding",
  displayName: "Kimi Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.kimi.com/coding/v1",
  defaultApi: "openai-completions",
};
