import type { PermissionMode } from '../components/input/PlanModeButton';

export interface QuickChatRuntimeAgent {
  id: string;
  name?: string | null;
  yuan?: string | null;
  hasAvatar?: boolean;
  isPrimary?: boolean;
  isCurrent?: boolean;
  memoryMasterEnabled?: boolean;
}

export function pickQuickChatRuntimeAgent(
  agents: QuickChatRuntimeAgent[],
  fallbackAgentId?: string | null,
): QuickChatRuntimeAgent | null {
  if (!Array.isArray(agents) || agents.length === 0) return null;
  return agents.find((agent) => agent.isCurrent)
    || (fallbackAgentId ? agents.find((agent) => agent.id === fallbackAgentId) : null)
    || agents.find((agent) => agent.isPrimary)
    || agents[0]
    || null;
}

export function shouldAdoptRuntimeAgentForQuickChat(sessionPath: string | null): boolean {
  return !sessionPath;
}

export function resolveQuickChatPermissionMode(data: any): PermissionMode {
  return (data?.permissionMode || data?.defaultMode || data?.mode || 'ask') as PermissionMode;
}
