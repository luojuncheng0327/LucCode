function toolOk(message, details = {}) {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}

function toolError(message, details = {}) {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, ...details },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findRuntimeCtx(args) {
  for (let i = args.length - 1; i >= 2; i -= 1) {
    const value = args[i];
    if (value && typeof value === "object" && (value.sessionManager || value.sessionId || value.sessionRef || value.sessionPath || value.agentId || value.model)) {
      return value;
    }
  }
  return null;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createDevToolError(message, code) {
  const err = new Error(message) as Error & { code?: string; status?: number };
  err.code = code;
  err.status = 400;
  return err;
}

function normalizeSessionTarget(params, runtimeCtx) {
  const hasParamTarget = !!(params?.sessionId || params?.sessionRef || params?.sessionPath);
  const source = hasParamTarget ? params : runtimeCtx;
  const rawRef = source?.sessionRef && typeof source.sessionRef === "object"
    ? source.sessionRef
    : null;
  const explicitSessionId = textOrNull(source?.sessionId);
  const refSessionId = textOrNull(rawRef?.sessionId);
  if (explicitSessionId && refSessionId && explicitSessionId !== refSessionId) {
    throw createDevToolError(
      "sessionId does not match sessionRef.sessionId",
      "PLUGIN_DEV_SESSION_ID_MISMATCH",
    );
  }
  const sessionId = explicitSessionId || refSessionId;
  const sessionPath = textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path)
    || textOrNull(source?.sessionPath)
    || (!hasParamTarget ? textOrNull(runtimeCtx?.sessionManager?.getSessionFile?.()) : null);
  const legacySessionPath = textOrNull(rawRef?.legacySessionPath)
    || textOrNull(source?.legacySessionPath);
  if (!sessionId) {
    return sessionPath ? { sessionPath } : {};
  }
  const sessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    sessionRef,
  };
}

function createSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function createPluginDevTool({
  name,
  description,
  parameters,
  service,
  handler,
  permissionAction,
  permissionKind = "review",
}) {
  return {
    name,
    description,
    parameters,
    metadata: { pluginDevTool: true },
    sessionPermission: {
      resolveInvocation: () => ({
        action: permissionAction,
        kind: permissionKind,
        capability: `${name}.${permissionAction}`,
      }),
    },
    execute: async (...args) => {
      const params = args[1] || {};
      const runtimeCtx = findRuntimeCtx(args);
      try {
        const result = await handler({ params, runtimeCtx, service });
        return toolOk(safeJson(result), result);
      } catch (err) {
        return toolError(err?.message || String(err), {
          errorCode: err?.code || "PLUGIN_DEV_TOOL_ERROR",
          status: err?.status || 500,
        });
      }
    },
  };
}

export function createPluginDevTools({ pluginDevService, getAgentId }: { pluginDevService?: any; getAgentId?: any } = {}) {
  if (!pluginDevService) return [];
  return [
    createPluginDevTool({
      name: "plugin_dev_install",
      description: "Install a Luc plugin source directory into the isolated development plugin slot. Requires the Agent plugin dev tools setting to be enabled by the user.",
      service: pluginDevService,
      parameters: createSchema({
        sourcePath: { type: "string", description: "Absolute path to the plugin source directory." },
        pluginId: { type: "string", description: "Optional expected plugin id from manifest.json." },
        allowFullAccess: { type: "boolean", description: "Temporarily allow full-access while this dev slot is loaded." },
      }, ["sourcePath"]),
      permissionAction: "install",
      handler: ({ params, service }) => service.installFromSource({
        sourcePath: params.sourcePath,
        pluginId: params.pluginId,
        allowFullAccess: params.allowFullAccess === true,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_reload",
      description: "Reload a previously installed development plugin from its remembered source slot.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        devRunId: { type: "string", description: "Optional active dev run id guard." },
        allowFullAccess: { type: "boolean" },
      }, ["pluginId"]),
      permissionAction: "reload",
      handler: ({ params, service }) => service.reloadPlugin(params.pluginId, {
        devRunId: params.devRunId,
        allowFullAccess: params.allowFullAccess,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_enable",
      description: "Enable a development plugin without changing normal plugin preferences.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        devRunId: { type: "string", description: "Optional active dev run id guard." },
        allowFullAccess: { type: "boolean" },
      }, ["pluginId"]),
      permissionAction: "enable",
      handler: ({ params, service }) => service.enablePlugin(params.pluginId, {
        devRunId: params.devRunId,
        allowFullAccess: params.allowFullAccess,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_disable",
      description: "Disable a development plugin without changing normal plugin preferences.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        devRunId: { type: "string", description: "Optional active dev run id guard." },
      }, ["pluginId"]),
      permissionAction: "disable",
      handler: ({ params, service }) => service.disablePlugin(params.pluginId, {
        devRunId: params.devRunId,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_reset",
      description: "Reset a development plugin by reloading it from its remembered source slot and creating a fresh dev run.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        devRunId: { type: "string", description: "Optional active dev run id guard." },
        allowFullAccess: { type: "boolean" },
      }, ["pluginId"]),
      permissionAction: "reset",
      handler: ({ params, service }) => service.resetPlugin(params.pluginId, {
        devRunId: params.devRunId,
        allowFullAccess: params.allowFullAccess,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_uninstall",
      description: "Uninstall a development plugin from the isolated dev plugin directory and forget its dev slot.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        devRunId: { type: "string", description: "Optional active dev run id guard." },
      }, ["pluginId"]),
      permissionAction: "uninstall",
      handler: ({ params, service }) => service.uninstallPlugin(params.pluginId, {
        devRunId: params.devRunId,
      }),
    }),
    createPluginDevTool({
      name: "plugin_dev_invoke_tool",
      description: "Invoke one loaded development plugin tool with explicit input for smoke testing.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        toolName: { type: "string" },
        input: { type: "object", additionalProperties: true },
        sessionId: { type: "string" },
        sessionRef: { type: "object", additionalProperties: true },
        sessionPath: { type: "string" },
        agentId: { type: "string" },
      }, ["pluginId", "toolName"]),
      permissionAction: "invoke",
      handler: ({ params, runtimeCtx, service }) => {
        const sessionTarget = normalizeSessionTarget(params, runtimeCtx);
        return service.invokeTool({
          pluginId: params.pluginId,
          toolName: params.toolName,
          input: params.input || {},
          ...sessionTarget,
          agentId: params.agentId || runtimeCtx?.agentId || getAgentId?.(),
        });
      },
    }),
    createPluginDevTool({
      name: "plugin_dev_diagnostics",
      description: "Read development plugin slots, load status, logs, UI surfaces, and scenarios.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
      }),
      permissionAction: "diagnose",
      permissionKind: "read",
      handler: ({ params, service }) => service.getDiagnostics(params.pluginId),
    }),
    createPluginDevTool({
      name: "plugin_dev_list_surfaces",
      description: "List page and widget surfaces exposed by development plugins.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
      }),
      permissionAction: "list",
      permissionKind: "read",
      handler: ({ params, service }) => service.listSurfaces(params.pluginId),
    }),
    createPluginDevTool({
      name: "plugin_dev_describe_surface",
      description: "Describe a plugin UI surface with an element-first debugging strategy.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        kind: { type: "string" },
        route: { type: "string" },
      }, ["pluginId"]),
      permissionAction: "describe",
      permissionKind: "read",
      handler: ({ params, service }) => service.describeSurfaceDebug(params),
    }),
    createPluginDevTool({
      name: "plugin_dev_run_scenario",
      description: "Run one manifest.dev.scenarios smoke test for a development plugin.",
      service: pluginDevService,
      parameters: createSchema({
        pluginId: { type: "string" },
        scenarioId: { type: "string" },
        allowDestructive: { type: "boolean" },
      }, ["pluginId", "scenarioId"]),
      permissionAction: "run",
      handler: ({ params, service }) => service.runScenario(params),
    }),
  ];
}
