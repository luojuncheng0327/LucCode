export const BROWSER_AGENT_OPEN_BEHAVIORS = ["smart", "current_tab", "new_tab"] as const;

export type BrowserAgentOpenBehavior = typeof BROWSER_AGENT_OPEN_BEHAVIORS[number];

export interface BrowserPreferences {
  acceptCookies: boolean;
  agentOpenBehavior: BrowserAgentOpenBehavior;
}

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = Object.freeze({
  acceptCookies: true,
  agentOpenBehavior: "smart",
});

export function normalizeBrowserPreferences(value: unknown = {}): BrowserPreferences {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const agentOpenBehavior = BROWSER_AGENT_OPEN_BEHAVIORS.includes(input.agentOpenBehavior as BrowserAgentOpenBehavior)
    ? input.agentOpenBehavior as BrowserAgentOpenBehavior
    : DEFAULT_BROWSER_PREFERENCES.agentOpenBehavior;

  return {
    acceptCookies: typeof input.acceptCookies === "boolean"
      ? input.acceptCookies
      : DEFAULT_BROWSER_PREFERENCES.acceptCookies,
    agentOpenBehavior,
  };
}

export function mergeBrowserPreferences(current: unknown, patch: unknown): BrowserPreferences {
  const normalizedCurrent = normalizeBrowserPreferences(current);
  const normalizedPatchSource = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : {};
  return normalizeBrowserPreferences({
    ...normalizedCurrent,
    ...normalizedPatchSource,
  });
}
