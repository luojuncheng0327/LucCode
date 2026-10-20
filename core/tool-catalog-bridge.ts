/**
 * The three tools a session carries in place of the tool schemas it deferred.
 *
 * Search and describe are pure lookups over the catalog. `mcp_call` is the
 * execution path: it resolves the real target, validates arguments against the
 * target's own schema before anything leaves the process, and forwards through
 * the manager so the existing call path (including multi-round tool results)
 * applies unchanged.
 *
 * Permission is the subtle part. The bridge must not become a way to launder
 * one approval into access to every connector, so `mcp_call` never asks to be
 * allowed as itself: it resolves the target first and presents that tool's real
 * capability. A session grant therefore means exactly the same thing whether
 * the model reached the tool directly or through here. The host authorizes that
 * by registering the tool object with the permission layer; see
 * registerBridgeCapabilityDelegates below.
 */

import { Type } from "../lib/pi-sdk/index.ts";
import { registerToolCapabilityDelegate } from "../lib/permission/tool-invocation-permission.ts";
import type { ToolCatalog, ToolCatalogEntry } from "./tool-catalog.ts";

export const BRIDGE_TOOL_NAMES = ["mcp_search_tools", "mcp_describe_tool", "mcp_call"] as const;

const SEARCH_TOOL_NAME = "mcp_search_tools";
const DESCRIBE_TOOL_NAME = "mcp_describe_tool";
const CALL_TOOL_NAME = "mcp_call";

export interface BridgeToolDeps {
  catalog: ToolCatalog;
  mcpCall: (serverId: string, toolName: string, args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
  resolveMcpPermission: (serverId: string, toolName: string) => string;
  /** Resolves a deferred builtin tool's own invocation descriptor. */
  resolveBuiltinInvocation?: (name: string, params: unknown) => unknown;
  /** Executes a deferred builtin tool in place of the MCP call path. */
  builtinCall?: (name: string, args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  log?: { warn?: (message: string) => void; log?: (message: string) => void };
}

function text(value: string) {
  return { content: [{ type: "text", text: value }] };
}

/**
 * Resolve `(server, tool)` to a catalog entry.
 *
 * The model sees catalog names in the manifest and in search results, but the
 * server's own name for a tool is what appears in its documentation, so both
 * are accepted. The server must own the resolved entry either way: a tool named
 * under the wrong server never resolves.
 */
function resolveTarget(catalog: ToolCatalog, server: unknown, tool: unknown): ToolCatalogEntry | null {
  const serverId = typeof server === "string" ? server.trim() : "";
  const toolName = typeof tool === "string" ? tool.trim() : "";
  if (!serverId || !toolName) return null;

  const byCatalogName = catalog.get(toolName);
  if (byCatalogName && byCatalogName.serverId === serverId) return byCatalogName;

  for (const entry of catalog.all()) {
    if (entry.serverId === serverId && entry.toolName === toolName) return entry;
  }
  return null;
}

function schemaProperties(schema: unknown): Record<string, any> {
  const properties = (schema as any)?.properties;
  return properties && typeof properties === "object" ? properties : {};
}

function requiredNames(schema: unknown): string[] {
  const required = (schema as any)?.required;
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [];
}

function jsonTypeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Structural check against the target's declared schema, run before any remote
 * call. This is a guard against wasted round trips and confusing server-side
 * errors, not a security boundary: the server remains the authority on its own
 * input. Only types the schema actually declares are enforced.
 */
function validateArguments(schema: unknown, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const properties = schemaProperties(schema);
  for (const name of requiredNames(schema)) {
    if (args[name] === undefined) problems.push(`缺少必填参数 ${name}`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const declared = properties[name]?.type;
    if (typeof declared !== "string") continue;
    const actual = jsonTypeOf(value);
    const ok = declared === "integer"
      ? actual === "number" && Number.isInteger(value as number)
      : actual === declared;
    if (!ok) problems.push(`参数 ${name} 需要 ${declared}，收到 ${actual}`);
  }
  return problems;
}

function renderHit(entry: ToolCatalogEntry, schemaRequired?: string[]): string {
  const required = schemaRequired?.length
    ? `必填：${schemaRequired.join(", ")}`
    : (entry.paramsSummary ? `参数：${entry.paramsSummary}` : "无参数");
  return [
    `${entry.name}（${entry.serverLabel}）`,
    entry.description || "无描述",
    required,
  ].join("\n  ");
}

function nearNames(catalog: ToolCatalog, name: string, limit = 3): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  return catalog.all()
    .filter((entry) => entry.name.toLowerCase().includes(needle) || entry.toolName.toLowerCase().includes(needle))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

function renderSchema(schema: unknown): string {
  const properties = schemaProperties(schema);
  const required = new Set(requiredNames(schema));
  const names = Object.keys(properties);
  if (names.length === 0) return "无参数";
  return names.map((name) => {
    const spec = properties[name] || {};
    const flag = required.has(name) ? "必填" : "可选";
    const type = typeof spec.type === "string" ? spec.type : "any";
    const description = typeof spec.description === "string" && spec.description ? ` — ${spec.description}` : "";
    return `- ${name}（${type}，${flag}）${description}`;
  }).join("\n");
}

function callExample(entry: ToolCatalogEntry, schema: unknown): string {
  const properties = schemaProperties(schema);
  const example: Record<string, unknown> = {};
  for (const name of requiredNames(schema)) {
    const type = properties[name]?.type;
    example[name] = type === "number" || type === "integer"
      ? 0
      : type === "boolean"
        ? true
        : type === "array"
          ? []
          : type === "object"
            ? {}
            : `<${name}>`;
  }
  return JSON.stringify({ server: entry.serverId, tool: entry.name, arguments: example }, null, 2);
}

export function createBridgeTools({
  catalog,
  mcpCall,
  resolveMcpPermission,
  resolveBuiltinInvocation,
  builtinCall,
  log,
}: BridgeToolDeps) {
  const searchTool = {
    name: SEARCH_TOOL_NAME,
    label: "Search MCP Tools",
    description:
      "Search the extension tools provided by external MCP connectors. These are optional integrations with outside services, not your built-in abilities. Use it when a request needs an external system and you do not already have a loaded tool for it.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords describing the capability you need." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results, default 5." })),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "read",
        kind: "read",
        capability: `${SEARCH_TOOL_NAME}.read`,
      }),
    },
    execute: async (_id: string, params: any) => {
      const hits = catalog.search(String(params?.query ?? ""), {
        limit: Number.isFinite(params?.limit) ? Number(params.limit) : undefined,
      });
      if (hits.length === 0) {
        return text(
          `No matching external tool. Try different keywords, or use ${DESCRIBE_TOOL_NAME} if you already know a tool name.`,
        );
      }
      const body = hits.map((hit) => renderHit(hit)).join("\n\n");
      return text(`${hits.length} 个匹配的外部工具：\n\n${body}\n\n用 ${DESCRIBE_TOOL_NAME} 查看完整参数，再用 ${CALL_TOOL_NAME} 调用。`);
    },
  };

  const describeTool = {
    name: DESCRIBE_TOOL_NAME,
    label: "Describe MCP Tool",
    description:
      "Show the full parameter schema and a call example for one tool provided by an external MCP connector. Use it before calling a tool you have not called yet in this conversation.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact tool name, as returned by mcp_search_tools." }),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "read",
        kind: "read",
        capability: `${DESCRIBE_TOOL_NAME}.read`,
      }),
    },
    execute: async (_id: string, params: any) => {
      const requested = String(params?.name ?? "");
      const described = catalog.describe(requested);
      if (!described) {
        const suggestions = nearNames(catalog, requested);
        return text(suggestions.length > 0
          ? `No tool named ${requested}. Closest matches: ${suggestions.join(", ")}.`
          : `No tool named ${requested}. Use ${SEARCH_TOOL_NAME} to find one.`);
      }
      return text([
        `${described.name}（${described.serverLabel}）`,
        described.description || "无描述",
        "",
        "参数：",
        renderSchema(described.schema),
        "",
        `调用示例（${CALL_TOOL_NAME}）：`,
        callExample(catalog.get(described.name)!, described.schema),
      ].join("\n"));
    },
  };

  const callTool = {
    name: CALL_TOOL_NAME,
    label: "Call MCP Tool",
    description:
      "Call one tool provided by an external MCP connector, by server and tool name, with a JSON arguments object. Look the tool up with mcp_search_tools or mcp_describe_tool first so the arguments match its schema.",
    parameters: Type.Object({
      server: Type.String({ description: "Server id that owns the tool." }),
      tool: Type.String({ description: "Tool name to invoke." }),
      arguments: Type.Optional(Type.Object({}, {
        description: "Arguments object matching the tool's schema.",
        additionalProperties: true,
      })),
    }),
    sessionPermission: {
      /**
       * Resolve the real target and speak in its name. Returning null for an
       * unresolvable target makes the permission layer fail closed, so a call
       * to something outside the catalog never reaches the network.
       */
      resolveInvocation: (params: any) => {
        const entry = resolveTarget(catalog, params?.server, params?.tool);
        if (!entry) return null;
        if (entry.origin === "builtin") {
          // A deferred builtin already owns a permission voice; speaking for it
          // means repeating what it says, not restating it in MCP terms.
          return resolveBuiltinInvocation?.(entry.name, params?.arguments ?? {}) ?? null;
        }
        const kind = resolveMcpPermission(entry.serverId, entry.toolName);
        // No `target`: the invocation target vocabulary is a closed set that
        // does not cover MCP tools, and the capability already names the tool
        // exactly. The reviewer still sees server and tool in the call params.
        return {
          action: "invoke",
          kind: kind === "read" ? "read" : "review",
          capability: `${entry.name}.invoke`,
        };
      },
    },
    execute: async (_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: unknown) => {
      const entry = resolveTarget(catalog, params?.server, params?.tool);
      if (!entry) {
        const suggestions = nearNames(catalog, String(params?.tool ?? ""));
        return text(suggestions.length > 0
          ? `Tool not found: ${params?.tool} on server ${params?.server}. Closest matches: ${suggestions.join(", ")}.`
          : `Tool not found: ${params?.tool} on server ${params?.server}. Use ${SEARCH_TOOL_NAME} to find the right name.`);
      }

      const rawArgs = params?.arguments;
      if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
        return text(`arguments 必须是一个 JSON 对象，收到 ${jsonTypeOf(rawArgs)}。`);
      }
      const args = (rawArgs ?? {}) as Record<string, unknown>;

      const described = catalog.describe(entry.name);
      const problems = described?.schema ? validateArguments(described.schema, args) : [];
      if (problems.length > 0) {
        return text([
          `${entry.name} 的参数不满足它的 schema，未发起调用：`,
          ...problems.map((problem) => `- ${problem}`),
          "",
          `用 ${DESCRIBE_TOOL_NAME}("${entry.name}") 查看完整参数。`,
        ].join("\n"));
      }

      try {
        if (entry.origin === "builtin") {
          if (!builtinCall) return text(`${entry.name} 当前不可调用。`);
          return await builtinCall(entry.name, args, ctx) as any;
        }
        return await mcpCall(entry.serverId, entry.toolName, args, ctx) as any;
      } catch (error: any) {
        log?.warn?.(`mcp_call ${entry.name} failed: ${error?.message || error}`);
        return text(`调用 ${entry.name} 失败：${error?.message || String(error)}`);
      }
    },
  };

  return [searchTool, describeTool, callTool];
}

/**
 * Authorize the bridge to speak for the tools it fronts.
 *
 * The predicate is deliberately a live catalog lookup rather than a pattern:
 * the bridge may only claim a capability belonging to a tool that is actually
 * in the catalog right now. A tool that leaves the catalog immediately stops
 * being claimable, and no capability outside the catalog is ever accepted.
 *
 * Registration is keyed on the tool object itself, so this must be called with
 * the same objects createBridgeTools returned, before they are wrapped.
 */
export function registerBridgeCapabilityDelegates(
  tools: readonly any[],
  { catalog }: { catalog: ToolCatalog },
): void {
  const callTool = tools.find((tool) => tool?.name === CALL_TOOL_NAME);
  if (!callTool) return;
  registerToolCapabilityDelegate(callTool, (capability, action) => {
    const suffix = `.${action}`;
    if (!capability.endsWith(suffix)) return false;
    return catalog.has(capability.slice(0, -suffix.length));
  });
}
