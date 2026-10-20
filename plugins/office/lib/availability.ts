import { DEFAULT_DISABLED_TOOL_NAMES } from "../../../shared/tool-categories.ts";

export const OFFICE_OPTIONAL_TOOL_NAME = "office";

export function isOfficeEnabledForAgentConfig(agentConfig: any = {}) {
  const disabled = Array.isArray(agentConfig?.tools?.disabled)
    ? agentConfig.tools.disabled
    : DEFAULT_DISABLED_TOOL_NAMES;
  return !disabled.includes(OFFICE_OPTIONAL_TOOL_NAME);
}
