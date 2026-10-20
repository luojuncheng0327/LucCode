# Provider 兼容层规范

> 本目录是 luc 唯一的 provider-specific payload 兼容层。
> 任何按 provider 走分支的代码都必须遵守本文件规则。

## 核心纪律

1. **唯一对外入口**：所有出站 payload 兼容必须经过 [`core/provider-compat.ts`](../provider-compat.ts) 的 `normalizeProviderPayload(payload, model, options)`。chat 路径（`engine.ts` 注册的 `before_provider_request` 钩子）和 utility 路径（`llm-client.ts` 的 `callText`）共享这一个入口。需要在 provider serializer 之前处理的 replay/history 规则，以及只影响模型可见副本的通用 content projection，走同文件的 `normalizeProviderContextMessages(messages, model, options)`。
2. **通用补丁留主入口**：与 provider 无关的处理（空 tools 数组剥离、按 `compat.thinkingFormat` 剥离不兼容的 `thinking` 字段、移除 SDK 注入的隐式 output cap、孤儿 toolResult 配对兜底、reasoning replay 契约、按 `compat.audioTransport` 执行音频 transport pre-pass）写在 `provider-compat.ts` 主入口或同目录通用 helper。孤儿 toolResult 兜底逻辑在 [`tool-pairing.ts`](tool-pairing.ts)；reasoning replay 执行逻辑在 [`reasoning-content-replay.ts`](reasoning-content-replay.ts)。两者都是 provider-agnostic helper，不参与 first-match-wins 分发。
3. **Provider-specific 补丁拆子文件**：每个 provider 一个 `core/provider-compat/<name>.ts`，互不串扰。
4. **接口契约**：每个子文件 export `matches(model) → boolean`（必须容忍 `model = null/undefined`，不抛错）和 `apply(payload, model, options) → payload`（不可 mutate 输入 payload）。如果该 provider 有 serializer 前的 replay/history 约束，可以额外 export `normalizeContextMessages(messages, model, options) → messages`。
5. **dispatch 单调性**：dispatcher 按数组顺序遍历，第一个 `matches` 返回 true 的子模块负责处理（first-match-wins）。一个 model 只匹配一个子模块。新 provider 默认加在数组末尾；只有当模块的 `matches` 是另一模块的子集（更具体的规则）时才前置，避免被通用规则吞掉。
6. **禁止散落**：调用点（`callText`、`engine.ts` 钩子、route handler 等）禁止内联 provider-specific 补丁。一旦发现，迁移到本目录。

## Pi SDK 与 Luc 双层边界

Luc 的 provider 出站链路有两层兼容逻辑，排查时必须同时看：

1. **Pi SDK provider serializer / compat**：负责 session、model registry、provider serializer，以及上游内置的兼容探测。它会先按自己的 provider 语义组装请求体。
2. **Luc provider-compat**：负责最终出站 payload 翻译。`before_provider_request` 和 utility `callText` 都会进入 `normalizeProviderPayload()`，所以 Pi SDK 组出的 payload 不一定就是最终发给供应商的 payload。

两层职责边界：

| 层 | 可以处理 | 禁止处理 |
|---|---|---|
| Pi SDK session/model 层 | session lifecycle、模型选择、SDK 支持的 thinking level 枚举、provider serializer 基础结构 | Luc 用户可见语义的最终决策、供应商特殊字段散落到调用点 |
| Luc provider-compat 层 | provider wire protocol 翻译，例如 `thinking`、`reasoning_effort`、`max_tokens`、历史 `reasoning_content` replay | Agent plan、system prompt、memory、工具列表、session 状态、用户可见 thinking level 的语义判断 |

常见误判：

- 看 Pi SDK 会以为某些 provider 仍发送上游字段，实际 Luc 子模块可能在最终出站前改写。
- 看 Luc provider-compat 会以为所有 thinking 问题都能在 payload 层修；如果 Pi SDK session 层已经 clamp 了 thinking level，payload 层已经来不及恢复原始意图。
- `OpenAI-compatible` 只说明请求大信封相似，不说明 thinking 控制、tool replay、effort 枚举等细节兼容。

排查 provider / reasoning bug 的顺序：

1. 查 `core/model-sync.ts` 与 `shared/model-capabilities.ts`：模型是否投影了正确的 `compat.thinkingFormat` / `compat.reasoningProfile`。
2. 查 Pi SDK serializer：进入 Luc compat 前，SDK 会生成什么 payload，是否存在 session 层 clamp 或枚举转换。
3. 查 `core/provider-compat.ts` dispatcher：最终会命中哪个子模块，是否 first-match-wins 被更通用模块吞掉。
4. 查 provider 子模块：`matches()` 范围、`apply()` 字段翻译、utility/off 行为、历史 replay 规则。
5. 加最终出站契约测试：优先用 `normalizeProviderPayload()` 和 model-sync 测试固定最终 payload，而不是只测试 Pi SDK 中间形态。

## 新增 provider 补丁的步骤

1. 在 `core/provider-compat/` 下新建 `<provider>.ts`
2. 文件顶部 JSDoc 注释必须写明：
   - 处理的 provider（`provider` 字段值或 baseUrl 模式）
   - 解决的具体协议问题（链接到官方文档）
   - **删除条件**（即什么情况下整个文件可整块删掉）
3. export `matches(model)` 和 `apply(payload, model, options)`，签名见下文
4. 在 `core/provider-compat.ts` 的 `PROVIDER_MODULES` 数组末尾加入 import
5. 在 `tests/provider-compat/<provider>.test.ts` 加测试：
   - `matches` 真值表（正例 / 反例 / `model=null`）
   - `apply` 在 `mode: "chat"` 和 `mode: "utility"` 两种上下文的行为
   - 不可变性断言（apply 不 mutate 输入 payload）

## 升级 SDK 时的检查清单

升级 `@mariozechner/pi-coding-agent` 或 `@mariozechner/pi-ai` 后必须执行：

1. 跑 `npm test` 全套，重点关注 `tests/provider-compat.test.ts` 和 `tests/provider-compat/*.test.ts`
2. 检查每个 `provider-compat/*.ts` 顶部的"删除条件"，对照 SDK 升级 changelog 看是否还需要保留
3. 如果某个 provider 子模块的删除条件已满足（SDK 升级后官方一等公民化），删除该文件并从 `PROVIDER_MODULES` 移除 import
4. 检查 SDK 是否仍完整保存 canonical `AssistantMessage`，并在 serializer 中原样回放 signed thinking block、reasoning item、`reasoning_details` 与 `thoughtSignature`。禁止把普通 `message.content` 当成 reasoning fallback。

## 接口契约

### `matches(model) → boolean`

```js
/**
 * 判断本模块是否处理这个 model。
 *
 * 实现要求：
 *   - 纯函数，无副作用
 *   - 优先用 provider / baseUrl / quirks / compat.thinkingFormat 等数据声明字段，避免按 model.id 字符串硬匹配
 *   - 必须容忍字段缺失：遇到 model = null/undefined 或目标字段不存在时返回 false，
 *     不抛错（dispatcher 不能因为某个子模块的 matches 崩溃影响其他模块）
 *   - 不可依赖 `this`：dispatcher 通过 `import * as mod` 的 namespace object 调用，
 *     namespace 是 frozen 的且无 `this` 上下文。matches 与 apply 都必须是顶层导出的独立函数
 */
export function matches(model) { ... }
```

### `apply(payload, model, options) → payload`

```js
/**
 * 对 payload 应用本 provider 的全部兼容补丁。
 *
 * 实现要求：
 *   - 不可变契约：返回新对象（或原对象，未修改时）；不直接 mutate 调用方传入的 payload
 *   - 必须能处理 mode: "chat" 和 mode: "utility" 两种调用上下文
 *   - 必须能容忍 model 字段缺失（保守处理，宁可不补也别错补）
 *   - `options` 字段是开放扩展的：dispatcher 把调用方传入的整个 options 透传给所有子模块；子模块按需读取自己关心的字段，未识别的字段必须忽略，不报错
 */
export function apply(payload, model, options) { ... }
```

## Thinking 格式声明

`reasoning` 只表示模型具备思考能力，不表示请求体该使用哪种字段。
请求侧思考控制统一由 `model.compat.thinkingFormat` 表示：

| 值 | 请求体格式 | 例子 |
|---|---|---|
| `anthropic` | `thinking: { type, budget_tokens }` | Anthropic、Kimi Coding、MiniMax Anthropic API |
| `qwen` | `enable_thinking: boolean` | DashScope / SiliconFlow / ModelScope 上的 Qwen-style 模型 |
| `qwen-chat-template` | `chat_template_kwargs: { enable_thinking, preserve_thinking }` | MiMo OpenAI-compatible API, including Xiaomi Token Plan `/v1` endpoints |
| `zhipu` | `thinking: { type, clear_thinking }` | Zhipu / BigModel GLM OpenAI-compatible API |
| `deepseek` | DeepSeek 子模块统一转换 | DeepSeek V4 / reasoner |
| `openrouter` | `reasoning: { effort }`，历史推理细节由 SDK 通过 `reasoning_details` 回放 | OpenRouter-hosted reasoning models, e.g. DeepSeek / MiMo via OpenRouter |
| `kimi` | `thinking: { type, keep? }` + `reasoning_effort`，历史推理用 `reasoning_content` 回放 | Kimi Code `/coding/v1`、Moonshot OpenAI-compatible thinking models |
| `volcengine` | `thinking: { type }` + provider 支持时的 `reasoning_effort` | Volcengine Ark Chat Completions / Agent-Coding Plan reasoning models |

`compat.reasoningProfile` 表示同一 wire format 内部更细的协议契约，例如
`deepseek-v4-anthropic` 表示 Anthropic Messages 请求体，但思考强度要写入
`output_config.effort`，并且工具调用历史需要在 serializer 前校验 thinking replay。

## Reasoning replay 契约

历史推理回传由 `compat.reasoningReplay` 单独声明，不再由每个 provider 子模块各写一套恢复逻辑：

| carrier | 典型协议 | 执行责任 |
|---|---|---|
| `reasoning_content` | Kimi、DeepSeek、MiMo、Zhipu Chat Completions | Luc 在 serializer 前验证 canonical signed thinking，并在最终 payload 再校验 tool-call 历史 |
| `thinking_blocks` | Anthropic Messages | Pi SDK 保存并原样回放 signed / redacted thinking block |
| `reasoning_items` | OpenAI Responses | Pi SDK 保存完整 reasoning item JSON 并回放 |
| `reasoning_details` | OpenRouter | Pi SDK 通过 tool-call `thoughtSignature` 回放完整 details |
| `thought_signature` | Gemini native | Pi SDK 保存并原样回放 thought signature |

`policy` 只有三种：`none`、`preserve`、`require-tool-call`。显式声明优先于推导；通用 OpenAI-compatible 模型不会因为 `reasoning: true` 自动获得 `reasoning_content`。只有协议明确支持丢弃历史推理时才声明 `clearable: true`；当前只有 Zhipu `clear_thinking` 恢复路径具备该能力，压缩流程不得替 Kimi / DeepSeek / MiMo 静默清空。

Pi Session JSONL 持久化完整 canonical assistant message，包括 thinking block、签名、tool call 与 provider/model 身份。Luc 不另建 reasoning sidecar。跨同一 `reasoning_content` 供应商族切换模型时，只改模型可见副本的身份以阻止 SDK 把 signed thinking 降级；持久化原文不改。跨供应商族、缺失签名或普通 text fallback 一律 fail closed。

`core/model-sync.ts` 会在投影 `models.json` 时把已知模型能力补成显式
`compat.thinkingFormat` / `compat.reasoningProfile`。`shared/model-capabilities.ts`
保留旧 `models.json` 的读时兼容，避免升级后必须重新保存 provider 才恢复思考。

## 新增 FRC / Thinking 模型的维护规则

接入新模型时按下面顺序判断，避免把 provider 契约散到调用点：

1. 先确认模型是否具备 `reasoning` 能力。`reasoning: true` 只打开 UI / 偏好层的思考控制，不决定请求字段。
2. 再确认请求体大类，优先复用已有 `compat.thinkingFormat`：`anthropic`、`qwen`、`deepseek` 等。
3. 如果新模型和现有 format 使用同一种 wire format，但参数名、强度枚举、tool call 历史或 replay 规则不同，新增 `compat.reasoningProfile`。
4. profile 推导优先使用显式 `model.compat.reasoningProfile`；读时兼容可以在 `shared/model-capabilities.ts` 基于 provider / baseUrl / api / known model family 推导。
5. provider 的请求控制写在 `core/provider-compat/<provider>.ts`；跨 provider 通用的 replay 语义写在 `compat.reasoningReplay` 与中心 helper。只有无法由 carrier/policy 表达的供应商规则才留在子模块。
6. 每个 profile 都要有测试覆盖：model-sync 投影、profile 推导、chat payload、utility payload、历史回放规则；SDK 原生 carrier 至少要有契约矩阵或 conformance 测试。

判断标准：如果换一个同 format 的 provider 之后规则还成立，放进 `thinkingFormat`；如果只对某个 provider 或某个模型族成立，放进 `reasoningProfile`。

## 输出预算策略

`maxOutput` / `model.maxTokens` 在 Luc 数据层表示模型能力上限，不表示每次请求的默认输出长度。
当前 Pi SDK 在调用方未传 `maxTokens` 时，会先用 `model.maxTokens`，再按本轮剩余上下文收紧，最后把结果写进请求体。
Luc 在最终请求发出前把这个默认值进一步限制到 65,536。这样模型的普通回答默认最多使用 64K 输出空间，
同时不会把 SDK 因上下文不足而已经压到 20K、8K 等更小的安全值反向抬高。

通用层通过 `provider-compat/output-budget.ts` 处理这件事。该文件内部维护
`OUTPUT_CAP_CAPABILITIES`，集中声明 output cap 是否必填、是否需要保留 SDK
默认值，并通过 `resolveOutputBudgetPolicy()` 把请求来源、provider 能力和
最终上限收敛成一个可测试的策略对象，避免把 provider 规则散落在调用点。

1. chat 请求未声明用户或系统级预算时，最终 output cap 为 `min(SDK 已收紧的值, 65,536, model.maxTokens)`。模型能力小于 64K 时按真实能力走，剩余上下文更小时继续保留更小值。
2. utility 请求由具体消费任务决定预算。`callText` 不从 `model.maxTokens` 合成默认 output cap；标题、健康检查、记忆摘要等任务需要限制长度时必须显式传 `maxTokens`。
3. Anthropic / Bedrock / `anthropic-messages` 这类协议必填 output cap 的 provider 在字段缺失时补齐预算；chat 使用 64K 默认目标，utility 继续遵守任务自己的显式预算或模型能力边界。
4. 官方 DeepSeek endpoint 继续交给 `deepseek.ts` 统一转换字段并确保 thinking 输出预算合法，进入该模块前已经完成 64K 默认限制。
5. 真正的用户级或系统级单次输出上限，调用方必须通过 `options.outputBudgetSource = "user" | "system"` 或等价显式 source 传入。显式值可以高于 64K，但一定会被 `model.maxTokens` 截住，不能超过模型声明的真实能力。
6. chat hook 只能看到 SDK 已按剩余上下文处理过的最终值，拿不到更细的来源。source 为 `unspecified` 时，兼容层只做向下限制，不会把任何较小值抬高；调用方若要表达 128K / 256K 等显式意图，必须携带 source，不能靠数值猜测。

## 音频输入 transport

Luc 内部用 `{ type: "audio", data, mimeType }` 表示当前轮音频。UI、SessionFile、历史恢复、`@附件`、压缩与缓存逻辑只处理这个内部语义，不按 provider 写分支。

出站请求分两步：

1. `core/provider-media-serializer.ts` 在 utility 路径把当前轮 audio block 直接序列化成 Chat Completions 官方 `{ type: "input_audio", input_audio: { data, format } }`，其中 `format` 只允许 `wav` / `mp3`。
2. chat 路径仍经过 Pi SDK，它会把非 text block 统一输出成 `image_url` data URL。`normalizeProviderPayload()` 在 first-match-wins provider 子模块之前，根据 `shared/model-capabilities.ts` 的 `resolveModelAudioInputTransport(model)` 执行 audio transport pre-pass。当前 `mimo-input-audio` 与 `openai-input-audio` 都复用 [`input-audio.ts`](input-audio.ts)，把 Pi SDK 产出的 `data:audio/...` 或旧 canonical audio block 转成同一个 `input_audio` 结构；不支持的音频格式必须显式报错，不允许继续伪装成 `image_url`。

接入未来 DeepSeek 音频时，优先在 known model / provider sync 投影里声明：

```json
{
  "compat": {
    "lucAudioInput": true,
    "audioTransport": "openai-input-audio"
  }
}
```

如果 DeepSeek 使用不同 wire format，再新增独立 transport 常量和 provider-agnostic helper；不要在 UI、SessionFile、`desktop-session-submit` 或 `session-coordinator` 里写 DeepSeek 分支。

## 已知子模块

下表按 `core/provider-compat.ts` 的 `PROVIDER_MODULES` 数组顺序排列，也就是
first-match-wins 的实际匹配次序。改数组顺序时同步改这张表。

| 文件 | 处理 provider | 删除条件 |
|---|---|---|
| [`deepseek-responses.ts`](deepseek-responses.ts) | DeepSeek 官方 endpoint 的 Responses 协议：effort 枚举翻译、`max_output_tokens` 字段名、清理 ChatCompletions 残留字段、显式 `effort:"none"` 关思考。**必须排在 `deepseek` 之前**（更具体的子集） | pi-ai 原生按 DeepSeek Responses 词汇表发送 effort 与输出预算 |
| [`deepseek.ts`](deepseek.ts) | DeepSeek 思考开关、effort、预算与 Anthropic profile 特例；reasoning_content 通用回放由中心 helper 负责 | DeepSeek 请求控制被 pi-ai 原生覆盖，且 Anthropic profile 不再需要额外规则 |
| [`kimi.ts`](kimi.ts) | Kimi Code / Moonshot 思考控制（`thinking: { type, keep }` + `reasoning_effort`），避免 Kimi-only 字段外溢到通用 OpenAI-compatible 路径 | pi-ai 原生处理 Kimi thinking 控制与 reasoning_content 回放 |
| [`mimo.ts`](mimo.ts) | MiMo OpenAI-compatible 思考开关（chat_template_kwargs），覆盖官网与 Xiaomi Token Plan `/v1` endpoint | MiMo 不再通过 chat_template_kwargs 控制 thinking |
| [`qwen.ts`](qwen.ts) | Qwen-style 思考模型 `enable_thinking` quirk；DashScope 视频输入复用 `openai-video-url` 转换 | quirks 系统重构 / Qwen-style 协议改成 reasoning_effort；DashScope 和 Pi SDK 原生支持 video_url |
| [`zhipu.ts`](zhipu.ts) | Zhipu / GLM OpenAI-compatible 思考模式协议（thinking.type、clear_thinking）与 OpenAI-only 字段清理；reasoning_content 校验由中心 helper 负责 | pi-ai 原生处理 GLM thinking 控制和 Zhipu 不支持的 OpenAI-only 字段 |
| [`volcengine.ts`](volcengine.ts) | Volcengine Ark OpenAI-compatible 思考模式协议（thinking.type、reasoning_effort 映射、utility/off 清理） | pi-ai 原生处理 Volcengine thinking 控制、effort 枚举和 utility/off 历史清理 |
| [`longcat.ts`](longcat.ts) | LongCat 的 `thinking` 对象式 reasoning 控制；utility 调用显式关思考并在回放前清掉过期 reasoning 历史 | pi-ai 原生处理 LongCat thinking 控制与 utility 历史清理 |
| [`agnes.ts`](agnes.ts) | Agnes AI：官方文档未定义结构化 reasoning carrier，阻止把它当 Luc reasoning 模型而把私有推理挤进正文 | Agnes 发布稳定的结构化 reasoning 流/回放协议，且 Luc 通过 `compat.thinkingFormat` 映射 |
| [`openai-input-audio.ts`](openai-input-audio.ts) | OpenAI Chat Completions 音频模型的 `input_audio` 分发入口（转换本身复用 `input-audio.ts`） | Pi SDK 把本地音频附件直接序列化成 OpenAI 的 `input_audio` part |
| [`openai-video-url.ts`](openai-video-url.ts) | OpenAI-compatible 视频输入 `image_url data:video` → `video_url`，当前用于 Moonshot Kimi 与 DashScope Qwen | Pi SDK 原生按 video MIME 输出 `video_url`；或相关 provider 接受 `image_url data:video` |
| [`openrouter.ts`](openrouter.ts) | OpenRouter 托管的 Claude adaptive-only 模型：effort 走 OpenRouter 的 `verbosity` 字段，发 Anthropic 原生 `thinking` 或通用 `reasoning.effort` 会打错线 | pi-ai 原生产出该请求形状；或 OpenRouter 改为接受标准 reasoning effort 字段且语义一致 |
| [`anthropic.ts`](anthropic.ts) | Anthropic Messages prompt-cache marker：chat 路径由 Pi SDK 注入 `cache_control`，utility 是直接 HTTP，本模块补齐同一份契约 | utility 路径也经由 Pi SDK 注入 cache_control |
| [`codex-responses.ts`](codex-responses.ts) | ChatGPT Codex Responses OAuth endpoint 不支持的 output cap / temperature 字段清理 | Codex Responses 接受这些字段且语义与 OpenAI public Responses 一致；或 pi-ai 原生 Codex serializer 已省略 |

### Provider-agnostic helper（不参与 first-match-wins）

这些文件不在 `PROVIDER_MODULES` 里，由主入口按能力声明直接调用：

| 文件 | 职责 | 删除条件 |
|---|---|---|
| [`input-audio.ts`](input-audio.ts) | 通用 OpenAI-compatible 音频 transport 转换，由主入口按 `compat.audioTransport` 调用 | Pi SDK / provider serializer 原生按模型 transport 输出正确音频块 |
| [`tool-pairing.ts`](tool-pairing.ts) | 孤儿 toolResult 配对兜底（issue #1285）：重放时补齐被丢弃的 assistant tool_calls | Pi SDK 重放不再丢弃 `stopReason=error/aborted` 轮次的 tool call |
| [`reasoning-content-replay.ts`](reasoning-content-replay.ts) | `reasoning_content` carrier 的历史回放执行与 fail-closed 校验 | 所有相关 provider 的 replay 由 Pi SDK 原生保存回放 |
| [`output-budget.ts`](output-budget.ts) | 通用输出预算策略：`OUTPUT_CAP_CAPABILITIES` + `resolveOutputBudgetPolicy()` | Pi SDK 原生支持 Luc 的默认预算与显式预算来源 |
| [`deepseek-thinking-budget.ts`](deepseek-thinking-budget.ts) | 仅在 DeepSeek 请求完全没带预算时补一个值；**不覆盖** Pi SDK `clampMaxTokensToContext` 算好的既有预算 | DeepSeek 请求缺预算时服务端有明确默认，或 SDK 始终携带预算 |

子模块的对外 API 仅有 `matches` 和 `apply` 两个 export。其它 export（如 replay helper 的 `extractReasoningFromContent`、`ensureReasoningContentForToolCalls`）属于实现细节、仅供同文件和单元测试访问，**不构成对外契约**。升级 SDK 想删 helper 时不需顾虑外部依赖。

## 历史背景

本架构分几步落地：先由 README 奠基本文，再收口到 llm-client 的统一入口。根因是 DeepSeek 思考模式下的 400 响应。
