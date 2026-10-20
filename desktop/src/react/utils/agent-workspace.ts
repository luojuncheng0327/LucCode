import type { Agent } from '../types';
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.ts';

export function findPrimaryAgent(agents: Agent[]): Agent | null {
  return agents.find(agent => agent.isPrimary) || agents[0] || null;
}

export function resolveAgentWorkspace(agent: Agent | null | undefined): string | null {
  return normalizeWorkspacePath(agent?.effectiveHomeFolder)
    || normalizeWorkspacePath(agent?.homeFolder);
}

export function isSameWorkspacePath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  if (normalizedLeft === null || normalizedRight === null) return false;
  const windowsStyle = /^[A-Za-z]:\//.test(normalizedLeft)
    || /^[A-Za-z]:\//.test(normalizedRight)
    || normalizedLeft.startsWith('//')
    || normalizedRight.startsWith('//');
  return windowsStyle
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
