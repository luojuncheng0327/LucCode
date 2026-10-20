import type { Agent, Session } from '../types';

export type MentionTab = 'files' | 'sessions' | 'agents';

export interface SessionMentionItem {
  kind: 'session';
  id: string;
  sessionId: string;
  name: string;
  detail: string;
  agentId: string | null;
  agentName: string | null;
}

export interface AgentMentionItem {
  kind: 'agent';
  id: string;
  agentId: string;
  name: string;
  detail: string;
  yuan: string;
}

function includesQuery(values: Array<string | null | undefined>, query: string): boolean {
  if (!query) return true;
  return values.some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query));
}

export function buildSessionMentionItems({
  sessions,
  query,
  limit = 20,
}: {
  sessions: Session[];
  query: string;
  limit?: number;
}): SessionMentionItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return sessions
    .filter(session => typeof session.sessionId === 'string' && session.sessionId.trim())
    .filter(session => includesQuery([
      session.title,
      session.firstMessage,
      session.sessionId,
      session.agentName,
    ], needle))
    .slice(0, limit)
    .map(session => {
      const sessionId = session.sessionId!.trim();
      const agentLabel = session.agentName || session.agentId || 'Agent';
      const name = session.title?.trim() || session.firstMessage?.trim() || agentLabel;
      return {
        kind: 'session' as const,
        id: `session:${sessionId}`,
        sessionId,
        name,
        detail: name === agentLabel ? '' : agentLabel,
        agentId: session.agentId,
        agentName: session.agentName,
      };
    });
}

export function buildAgentMentionItems({
  agents,
  query,
  currentAgentId,
  limit = 20,
}: {
  agents: Agent[];
  query: string;
  currentAgentId?: string | null;
  limit?: number;
}): AgentMentionItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return agents
    .filter(agent => agent.id !== currentAgentId)
    .filter(agent => includesQuery([agent.name, agent.id, agent.chatModel?.id], needle))
    .slice(0, limit)
    .map(agent => ({
      kind: 'agent' as const,
      id: `agent:${agent.id}`,
      agentId: agent.id,
      name: agent.name || agent.id,
      detail: agent.chatModel?.id || agent.id,
      yuan: agent.yuan,
    }));
}
