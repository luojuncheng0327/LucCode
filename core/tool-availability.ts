import {
  computeToolSnapshot,
  DEFAULT_DISABLED_TOOL_NAMES,
} from "../shared/tool-categories.ts";

export function toolNamesFromObjects(tools, { includePluginTools = true } = {}) {
  return (tools || [])
    .filter((tool) => includePluginTools || !tool?._pluginId)
    .map((tool) => tool?.name)
    .filter(Boolean);
}

export function getStableFeatureDisabledToolNames({ channelsEnabled }: { channelsEnabled?: any } = {}) {
  const disabled = [];
  if (channelsEnabled === false) disabled.push("channel");
  return disabled;
}

export function computeRuntimeDisabledToolNames(tools, agentConfig, context = {}, options: { warn?: any } = {}) {
  const disabled = [];
  const warn = typeof options.warn === "function" ? options.warn : null;
  for (const tool of tools || []) {
    if (!tool?.name || typeof tool.isEnabledForAgentConfig !== "function") continue;
    try {
      if (!tool.isEnabledForAgentConfig(agentConfig, context)) {
        disabled.push(tool.name);
      }
    } catch (err) {
      warn?.(`tool "${tool.name}" runtime enablement check failed, disabling for fresh session: ${err.message}`);
      disabled.push(tool.name);
    }
  }
  return disabled;
}

export function computeAvailableToolNames(tools, agentConfig, context = {}, options: { includeRuntimeEnablement?: any; extraDisabled?: any[]; includePluginTools?: any; warn?: any } = {}) {
  const disabled = agentConfig?.tools?.disabled ?? DEFAULT_DISABLED_TOOL_NAMES;
  const runtimeDisabled = options.includeRuntimeEnablement === false
    ? []
    : computeRuntimeDisabledToolNames(tools, agentConfig, context, options);
  const extraDisabled = [
    ...getStableFeatureDisabledToolNames(context),
    ...runtimeDisabled,
    ...(Array.isArray(options.extraDisabled) ? options.extraDisabled : []),
  ];
  return computeToolSnapshot(
    toolNamesFromObjects(tools, { includePluginTools: options.includePluginTools !== false }),
    disabled,
    { extraDisabled },
  );
}

export function filterToolObjectsByAvailability(tools, agentConfig, context = {}, options: { includeRuntimeEnablement?: any; extraDisabled?: any[]; includePluginTools?: any; warn?: any } = {}) {
  const availableNames = new Set(computeAvailableToolNames(tools, agentConfig, context, options));
  return (tools || []).filter((tool) => tool?.name && availableNames.has(tool.name));
}

function reminderLiveAvailabilityProbe(tool) {
  if (typeof tool?.reminderLiveAvailabilityProbe === "function") {
    return tool.reminderLiveAvailabilityProbe;
  }
  if (typeof tool?.metadata?.reminderLiveAvailabilityProbe === "function") {
    return tool.metadata.reminderLiveAvailabilityProbe;
  }
  return null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizedReminderProbeResult(value) {
  if (value === true) return { available: true };
  if (value === false) {
    return { available: false, reason: "probe_reported_unavailable", diagnostics: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("probe must return a boolean or an availability result object");
  }
  if (typeof value.then === "function") {
    throw new TypeError("probe must be synchronous and read-only");
  }
  if (typeof value.available !== "boolean") {
    throw new TypeError("probe result must contain an available boolean");
  }
  if (value.available) return { available: true };
  return {
    available: false,
    reason: typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : "probe_reported_unavailable",
    diagnostics: value.diagnostics && typeof value.diagnostics === "object" && !Array.isArray(value.diagnostics)
      ? { ...value.diagnostics }
      : {},
  };
}

/**
 * Computes the current tool names visible to Reminder preflight. It starts from
 * the exact same names as a normal fresh-session availability calculation, then
 * applies an optional synchronous, read-only probe. Explicit unavailable
 * results are authoritative; probe errors fail open to avoid inventing an
 * outage from missing diagnostics. Normal filtering and execution never
 * consult this hook.
 */
export function computeReminderLiveToolAvailability(
  tools,
  agentConfig,
  context = {},
  options: {
    includeRuntimeEnablement?: boolean;
    extraDisabled?: string[];
    includePluginTools?: boolean;
    warn?: (message: string) => void;
  } = {},
) {
  const normalAvailableToolNames = computeAvailableToolNames(tools, agentConfig, context, options);
  const toolByName = new Map();
  for (const tool of tools || []) {
    if (tool?.name) toolByName.set(tool.name, tool);
  }

  const availableToolNames = [];
  const diagnostics = [];
  const warn = typeof options.warn === "function" ? options.warn : null;

  for (const toolName of normalAvailableToolNames) {
    const probe = reminderLiveAvailabilityProbe(toolByName.get(toolName));
    if (!probe) {
      availableToolNames.push(toolName);
      continue;
    }

    try {
      const result = normalizedReminderProbeResult(probe(agentConfig, context));
      if (result.available) {
        availableToolNames.push(toolName);
        continue;
      }
      diagnostics.push({
        toolName,
        reason: result.reason,
        diagnostics: result.diagnostics,
      });
    } catch (error) {
      const message = errorMessage(error);
      warn?.(`tool "${toolName}" Reminder live availability probe failed: ${message}`);
      availableToolNames.push(toolName);
      diagnostics.push({
        toolName,
        reason: "probe_error",
        diagnostics: { message },
      });
    }
  }

  return { availableToolNames, diagnostics };
}
