/**
 * agent-actions.ts — Agent CRUD / 身份同步 / 头像
 *
 * 从 app-agents-shim.ts 迁移。直接操作 Zustand store，
 * 不依赖 ctx 注入。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- API 响应 JSON + Record<string, any> patch 对象 */

import { useStore } from './index';
import { lucFetch, lucUrl } from '../hooks/use-luc-fetch';
import { closePreview } from './preview-actions';

declare function t(key: string, vars?: Record<string, string>): any;
declare const i18n: { defaultName: string };

// ── clearChat ──

export function clearChat(): void {
  const s = useStore.getState();

  const sessionPath = s.currentSessionPath;
  if (sessionPath) {
    s.clearSession?.(sessionPath);
  }

  // PreviewItem 内容池不随 clearChat 清空；可见的 preview/tabs 由 workspace
  // 激活流程保存和恢复。清对话只收起当前可见面板。

  useStore.setState({
    welcomeVisible: true,
    memoryEnabled: true,
    sessionTodos: [],
  });

  if (s.previewOpen) closePreview();
}

// ── Agent 身份同步 ──

export async function applyAgentIdentity(opts: any = {}): Promise<void> {
  const { agentName, agentId, userName, ui = {} } = opts;

  const patch: Record<string, any> = {};
  if (agentName !== undefined) patch.agentName = agentName;
  if (agentId !== undefined) patch.currentAgentId = agentId;
  if (userName !== undefined) patch.userName = userName;
  if (opts.yuan !== undefined) patch.agentYuan = opts.yuan;
  if (Object.keys(patch).length > 0) useStore.setState(patch);

  i18n.defaultName = patch.agentName ?? useStore.getState().agentName;

  const { avatars = true, agents = true } = ui;

  const tasks: Promise<any>[] = [];
  if (avatars) {
    tasks.push(
      lucFetch('/api/health').then(r => r.json()).then(d => loadAvatars(d.avatars)).catch(() => loadAvatars()),
    );
  }
  if (agents) tasks.push(loadAgents());
  await Promise.all(tasks);
}

// ── Agent 加载 ──

export async function loadAgents(): Promise<void> {
  try {
    const res = await lucFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const agents = data.agents || [];
    const s = useStore.getState();

    const patch: Record<string, any> = { agents };
    if (!s.currentAgentId) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      if (primary) patch.currentAgentId = primary.id;
    }

    const currentId = patch.currentAgentId ?? s.currentAgentId;
    const currentAgent = agents.find((a: any) => a.id === currentId);
    if (currentAgent?.yuan) patch.agentYuan = currentAgent.yuan;
    if (currentAgent?.name) patch.agentName = currentAgent.name;
    if (typeof currentAgent?.memoryMasterEnabled === 'boolean') {
      patch.memoryMasterEnabled = currentAgent.memoryMasterEnabled;
    }

    useStore.setState(patch);
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

// ── 头像 ──

/**
 * 头像 URL 构造。agent 头像属于某个具体 agent，URL 必须说明是哪一个：
 * 服务端不再替请求挑 agent，缺 agentId 的请求会被拒绝。调用方没有 agent
 * 身份时（启动早期还没选定），显示无头像而不是发一个没有归属的请求。
 */
export function loadAvatars(avatarsInfo?: Record<string, boolean>, agentId?: string | null): void {
  const ts = Date.now();
  const patch: Record<string, any> = {};
  const targetAgentId = agentId ?? useStore.getState().currentAgentId ?? null;

  patch.userAvatarUrl = avatarsInfo?.user
    ? lucUrl(`/api/avatar/user?t=${ts}`)
    : null;
  patch.agentAvatarUrl = avatarsInfo?.agent && targetAgentId
    ? lucUrl(`/api/avatar/agent?agentId=${encodeURIComponent(targetAgentId)}&t=${ts}`)
    : null;

  useStore.setState(patch);
}
