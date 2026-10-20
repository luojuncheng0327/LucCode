/**
 * DeepSeek Responses provider plugin
 *
 * DeepSeek 官方 endpoint 的 OpenAI Responses 协议通道，与 OpenAI ChatCompletions
 * 通道（./deepseek.ts）是同一厂商的不同接入方式，同 moonshot / kimi-coding 的先例。
 *
 * 为什么单独一个 provider：Responses 与 ChatCompletions 的 effort 枚举、输出预算
 * 字段、思考链回放载体都不同，混在一个 provider 里只能靠用户手改 api 字段，切错
 * 协议时供应商静默忽略参数而不报错。
 *
 * 覆盖范围：V4-Flash、V4-Pro、V4-Flash-Vision-Exp 三个模型均原生支持 Responses
 * 通道（V4-Pro 官方 2026-08-13 更新日志确认已原生支持）。
 *
 * 思考档位：三个模型官方声明档位一致，均为 low / high（默认）/ max 三档；
 * medium 与 xhigh 是兼容值，服务端会折算成 high。客户端照常发用户选的档位即可，
 * 服务端具体如何折算不在客户端预判。
 *
 * 文档：https://api-docs.deepseek.com/guides/responses_api/
 *       https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
 */

const DEEPSEEK_RESPONSES_MODELS = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-responses",
    context: 1_000_000,
    maxOutput: 384_000,
    image: false,
    reasoning: true,
    xhigh: true,
    thinkingLevels: ["off", "low", "high", "max"],
    defaultThinkingLevel: "high",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-responses",
    context: 1_000_000,
    maxOutput: 384_000,
    image: false,
    reasoning: true,
    xhigh: true,
    thinkingLevels: ["off", "low", "high", "max"],
    defaultThinkingLevel: "high",
  },
  {
    id: "deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Exp)",
    api: "openai-responses",
    context: 1_000_000,
    maxOutput: 384_000,
    image: true,
    reasoning: true,
    xhigh: true,
    thinkingLevels: ["off", "low", "high", "max"],
    defaultThinkingLevel: "high",
  },
];

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const deepseekResponsesPlugin = {
  id: "deepseek-responses",
  displayName: "DeepSeek (Responses)",
  authType: "api-key",
  defaultBaseUrl: "https://api.deepseek.com",
  defaultApi: "openai-responses",
  models: DEEPSEEK_RESPONSES_MODELS,
};
