import fs from "node:fs";

export const PI_BUILTIN_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "exec_command",
  "write_stdin",
  "grep",
  "find",
  "ls",
]);

function readPiCodingAgentVersion() {
  let dir = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
  while (dir.href !== new URL("../", dir).href) {
    const pkgUrl = new URL("package.json", dir);
    if (fs.existsSync(pkgUrl)) {
      const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
        return pkg.version;
      }
    }
    dir = new URL("../", dir);
  }
  throw new Error("Unable to resolve @earendil-works/pi-coding-agent package version");
}

export const PI_CODING_AGENT_VERSION = readPiCodingAgentVersion();

export function getPiCodingAgentVersion() {
  return PI_CODING_AGENT_VERSION;
}

export function isPiSdkNameAllowlistVersion(version = getPiCodingAgentVersion()) {
  const [major, minor] = String(version).split(".").map(part => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new Error(`Unsupported @earendil-works/pi-coding-agent version: ${version}`);
  }
  return major > 0 || (major === 0 && minor >= 68);
}

export function assertAgentTool(tool, owner = "createAgentSession.tools") {
  if (!tool || typeof tool !== "object") {
    throw new TypeError(`${owner} must contain tool objects`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError(`${owner} contains a tool without a non-empty string name`);
  }
  if (typeof tool.execute !== "function") {
    throw new TypeError(`${owner}.${tool.name} must have an execute function`);
  }
}

export function getToolDefinitionName(tool, owner = "createAgentSession.customTools") {
  if (!tool || typeof tool !== "object") {
    throw new TypeError(`${owner} must contain tool definition objects`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new TypeError(`${owner} contains a tool without a non-empty string name`);
  }
  return tool.name;
}

function stableJson(value: any, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "undefined" : encoded;
  }
  if (seen.has(value)) return "\"[Circular]\"";
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item, seen)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(",")}}`;
}

function normalizeToolCallId(value: any): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pickAssistantMessageId(...values: any[]): string | null {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidates = [
      value.assistantMessageId,
      value.messageId,
      value.assistantMessage?.id,
      value.message?.id,
      value.turnId,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeToolCallId(candidate);
      if (normalized) return normalized;
    }
  }
  return null;
}

function toolExecutionKey(toolName: string, toolCallId: any, params: any, signal: any, ctx: any): string | null {
  const id = normalizeToolCallId(toolCallId);
  if (id) return `toolCallId:${id}`;

  const assistantMessageId = pickAssistantMessageId(ctx, signal, params);
  if (!assistantMessageId) return null;
  return `assistant:${assistantMessageId}:tool:${toolName}:args:${stableJson(params)}`;
}

function createToolExecutionOnceState(): Map<string, Promise<any>> {
  return new Map();
}

function wrapToolDefinitionExecutionOnce(definition: any, state = createToolExecutionOnceState()) {
  if (!definition || typeof definition.execute !== "function") return definition;
  const execute = definition.execute;
  return {
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const key = toolExecutionKey(definition.name, toolCallId, params, signal, ctx);
      if (!key) return execute(toolCallId, params, signal, onUpdate, ctx);

      const existing = state.get(key);
      if (existing) return existing;

      const promise = Promise.resolve().then(() => execute(toolCallId, params, signal, onUpdate, ctx));
      state.set(key, promise);
      return promise;
    },
  };
}

export function agentToolToToolDefinition(tool, executionState = createToolExecutionOnceState()) {
  assertAgentTool(tool);
  return wrapToolDefinitionExecutionOnce({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    renderCall: tool.renderCall,
    renderResult: tool.renderResult,
    renderShell: tool.renderShell,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      tool.execute(toolCallId, params, signal, onUpdate, ctx),
  }, executionState);
}

export function uniqueToolNames(names) {
  return [...new Set(
    names.filter(name => typeof name === "string" && name.length > 0),
  )];
}

export function normalizeCreateAgentSessionOptions(options, version = getPiCodingAgentVersion()) {
  if (!options || typeof options !== "object") {
    return options;
  }

  if (!isPiSdkNameAllowlistVersion(version)) {
    return options;
  }

  const rawTools = Array.isArray(options.tools) ? options.tools : [];
  const rawCustomTools = Array.isArray(options.customTools) ? options.customTools : [];
  const executionState = createToolExecutionOnceState();

  for (const tool of rawTools) assertAgentTool(tool);
  const convertedBaseTools = rawTools.map(tool => agentToolToToolDefinition(tool, executionState));
  const convertedCustomTools = rawCustomTools.map(tool => (
    wrapToolDefinitionExecutionOnce(tool, executionState)
  ));
  const allowedNames = uniqueToolNames([
    ...rawTools.map(tool => tool.name),
    ...rawCustomTools.map(tool => getToolDefinitionName(tool)),
  ]);

  return {
    ...options,
    tools: allowedNames,
    customTools: [
      ...convertedBaseTools,
      ...convertedCustomTools,
    ],
  };
}
