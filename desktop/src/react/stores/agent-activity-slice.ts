/**
 * agent-activity-slice.ts — Agent Activity 实时活动（后台任务）
 *
 * 消费后端 ActivityHub 广播的 agent_activity 事件。entry 自带 sessionId + sessionPath；
 * store 内部按 sessionId/scoped key 分桶，sessionPath 只作为实时流 locator 和旧数据兼容键。
 */

import { sessionScopedKey, sessionScopedValue, type SessionLocatorState } from './session-slice';

export interface AgentActivityEntry {
  id: string;
  kind: 'subagent' | 'workflow' | 'workflow_agent' | 'workflow_step' | 'heartbeat' | 'cron';
  status: 'running' | 'done' | 'failed' | 'aborted';
  sessionId?: string | null;
  sessionPath: string | null;
  agentId: string | null;
  agentName: string | null;
  summary: string | null;
  childSessionId?: string | null;
  childSessionPath: string | null;
  threadId?: string | null;
  threadKind?: string | null;
  access?: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  // workflow_agent 子节点和 subagent 都会用 label：节点名或子 Agent 展示标签。
  parentTaskId?: string | null;
  label?: string | null;
  phaseLabel?: string | null;
  tokens?: number | null;
  stepKind?: 'parallel' | 'pipeline' | 'log' | null;
}

export interface AgentActivitySlice {
  /** 按 session identity key 存储的活动列表（读旧 path key 兼容） */
  agentActivitiesBySession: Record<string, AgentActivityEntry[]>;
  upsertAgentActivity: (entry: AgentActivityEntry) => void;
  clearAgentActivities: (sessionPath: string) => void;
}

export const createAgentActivitySlice = (
  set: (partial: Partial<AgentActivitySlice> | ((s: AgentActivitySlice) => Partial<AgentActivitySlice>)) => void
): AgentActivitySlice => ({
  agentActivitiesBySession: {},
  upsertAgentActivity: (entry) => {
    const sp = entry?.sessionPath;
    if (!sp || !entry?.id) return; // 无归属/无 id 不入库（禁止从焦点 session 兜底）
    set((s) => {
      const key = entry.sessionId?.trim() || sessionScopedKey(s as AgentActivitySlice & SessionLocatorState, sp) || sp;
      const list = sessionScopedValue(s as AgentActivitySlice & SessionLocatorState, s.agentActivitiesBySession, sp) || [];
      const idx = list.findIndex((e) => e.id === entry.id);
      const next = idx >= 0
        ? list.map((e) => (e.id === entry.id ? { ...e, ...entry } : e))
        : [...list, entry];
      const agentActivitiesBySession = { ...s.agentActivitiesBySession, [key]: next };
      if (key !== sp) delete agentActivitiesBySession[sp];
      return { agentActivitiesBySession };
    });
  },
  clearAgentActivities: (sessionPath) => {
    set((s) => {
      const key = sessionScopedKey(s as AgentActivitySlice & SessionLocatorState, sessionPath) || sessionPath;
      if (!s.agentActivitiesBySession[key] && !s.agentActivitiesBySession[sessionPath]) return {};
      const next = { ...s.agentActivitiesBySession };
      delete next[key];
      delete next[sessionPath];
      return { agentActivitiesBySession: next };
    });
  },
});

// ── Selectors ──
const EMPTY: AgentActivityEntry[] = [];
/** 当前对话的活动列表（稳定空引用，避免无活动时触发 re-render） */
export const selectAgentActivities =
  (sessionPath: string | null) =>
  (s: AgentActivitySlice & SessionLocatorState): AgentActivityEntry[] =>
    sessionPath ? (sessionScopedValue(s, s.agentActivitiesBySession, sessionPath) || EMPTY) : EMPTY;
