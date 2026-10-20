function clonePlain<T>(value: T): T {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as T;
}

function compactJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeNotifyAutomationParams(params: unknown = {}) {
  const source = asRecord(params) || {};
  return {
    title: typeof source.title === "string" ? source.title : "",
    body: typeof source.body === "string" ? source.body : "",
    ...(Array.isArray(source.channels) ? { channels: source.channels } : {}),
    ...(Array.isArray(source.bridgePlatforms) ? { bridgePlatforms: source.bridgePlatforms } : {}),
    ...(typeof source.contextPolicy === "string" ? { contextPolicy: source.contextPolicy } : {}),
    ...(typeof source.audience === "string" ? { audience: source.audience } : {}),
  };
}

export function buildNotifyAgentRunPrompt(params: unknown = {}) {
  const payload = normalizeNotifyAutomationParams(params);
  return [
    "这是一个自动化 Agent Run。触发后只完成下面的固定通知动作，不要扩展成其他任务。",
    "",
    "请调用 notify 工具发送通知，参数如下：",
    compactJson(payload),
    "",
    "发送完成后，用一句话说明发送结果；如果 notify 工具不可用或发送失败，明确说明失败原因。",
  ].join("\n");
}

export function buildPluginActionAgentRunPrompt({
  pluginId,
  actionId,
  params,
}: {
  pluginId: string;
  actionId: string;
  params?: unknown;
}) {
  const normalizedPluginId = typeof pluginId === "string" ? pluginId.trim() : "";
  const normalizedActionId = typeof actionId === "string" ? actionId.trim() : "";
  return [
    "这是一个自动化 Agent Run。触发后只完成下面的插件动作，不要扩展成其他任务。",
    "",
    `插件动作：${normalizedPluginId}/${normalizedActionId}`,
    "参数：",
    compactJson(params && typeof params === "object" && !Array.isArray(params) ? params : {}),
    "",
    "请调用对应插件工具执行这个动作。若工具不可用，明确说明失败原因。",
  ].join("\n");
}

export function createAgentSessionAutomationExecutor({
  agentId,
  prompt,
  model = "",
  executionContext = null,
  migratedFrom = null,
}: {
  agentId?: string | null;
  prompt: string;
  model?: unknown;
  executionContext?: unknown;
  migratedFrom?: unknown;
}) {
  return {
    kind: "agent_session",
    agentId: typeof agentId === "string" && agentId.trim() ? agentId.trim() : null,
    prompt: typeof prompt === "string" ? prompt : "",
    model: clonePlain(model ?? ""),
    executionContext: clonePlain(executionContext ?? null),
    ...(migratedFrom ? { migratedFrom: clonePlain(migratedFrom) } : {}),
  };
}
