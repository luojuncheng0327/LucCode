/**
 * SubagentCard — 子 Agent 静态预览状态卡片
 *
 * 聊天流中的概览卡只显示静态任务与终态，不订阅 child session 高频流。
 * 详情实时流由 SubagentSessionPreview 在打开时订阅。
 */

import { memo, useState, useEffect, useCallback } from 'react';
import { lucUrl } from '../../hooks/use-luc-fetch';
import { useStore } from '../../stores';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { ChatResourceCard } from './ChatResourceCard';
import type { ChatResourceCardStatusTone } from './ChatResourceCard';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SubagentCardProps {
  block: {
    taskId: string;
    task: string;
    taskTitle: string;
    agentId?: string;
    agentName?: string;
    requestedAgentId?: string;
    requestedAgentName?: string;
    executorAgentId?: string;
    executorAgentNameSnapshot?: string;
    sessionId?: string | null;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    label?: string | null;
    reuseInstance?: string | null;
  };
}

export const SubagentCard = memo(function SubagentCard({ block }: SubagentCardProps) {
  const [status, setStatus] = useState(block.streamStatus);
  const t = window.t ?? ((k: string) => k);

  // 头像：优先用 agent 头像 API，fallback 到 yuan 剪影头像
  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const agentId = block.agentId || block.executorAgentId || currentAgentId || '';
  const displayInfo = resolveAgentDisplayInfo({
    id: agentId || null,
    agents,
    fallbackAgentName: block.agentName || block.executorAgentNameSnapshot || block.agentId || 'Subagent',
  });
  const agentName = displayInfo.displayName;

  // Sync block prop changes (from block_update patch)
  useEffect(() => {
    setStatus(block.streamStatus);
  }, [block.streamStatus]);

  // "已中断" 仅在历史加载时判断：组件首次 mount 时如果 streamKey 为空且 status=running，
  // 等待一小段时间让 block_update 到达。如果一直没到才标记中断。
  const [waitedForKey, setWaitedForKey] = useState(false);
  useEffect(() => {
    if (block.streamKey || status !== 'running') return;
    const timer = setTimeout(() => setWaitedForKey(true), 3000);
    return () => clearTimeout(timer);
  }, [block.streamKey, status]);

  const isInterrupted = status === 'running' && !block.streamKey && waitedForKey;

  const handleAbort = useCallback(async () => {
    try {
      const res = await fetch(lucUrl(`/api/task/${block.taskId}/abort`), { method: 'POST' });
      if (res.ok) {
        setStatus('aborted');
      }
    } catch { /* user-initiated abort; silent on network failure */ }
  }, [block.taskId]);

  const displayLabel = block.label || block.reuseInstance || null;
  const statusLabel = isInterrupted
    ? t('subagent.status.interrupted')
    : status === 'aborted'
      ? t('subagent.status.aborted')
      : status === 'done'
        ? t('subagent.status.done')
        : status === 'failed'
          ? t('subagent.status.failed')
          : t('subagent.status.dispatched');
  const statusTone: ChatResourceCardStatusTone = status === 'done'
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : status === 'running' && !isInterrupted
        ? 'accent'
        : 'muted';

  return (
    <ChatResourceCard
      variant="task"
      className={`${styles.subagentResourceCard} ${styles[`subagent-${status}`]}`}
      icon={(
        <AgentAvatar
          info={displayInfo}
          className={styles.subagentAvatar}
          alt={agentName}
        />
      )}
      title={agentName}
      titleMeta={displayLabel ? `· ${displayLabel}` : undefined}
      subtitle={block.taskTitle}
      statusLabel={statusLabel}
      statusTone={statusTone}
      actionSlot={status === 'running' && !isInterrupted && (
        <button
          type="button"
          className={styles.subagentAbortBtn}
          onClick={(event) => {
            event.stopPropagation();
            void handleAbort();
          }}
          title={t('subagentAbort')}
        >
          ✕
        </button>
      )}
    />
  );
});
