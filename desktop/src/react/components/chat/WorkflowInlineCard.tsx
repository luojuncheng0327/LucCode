/**
 * WorkflowInlineCard — 聊天流里的 workflow 概览块（信息架构：inline 只给「大概状态」）
 *
 * 聊天流里只显示 workflow 名、终态耗时和状态，不订阅 streamKey、不展开实时流。
 * 详细节点分布在右侧 WorkflowCard。
 */
import { memo } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities } from '../../stores/agent-activity-slice';
import { formatElapsed } from '../../utils/format-duration';
import { ChatResourceCard } from './ChatResourceCard';
import { WorkflowResourceIcon } from './ChatResourceIcons';
import { WorkflowProgressDots } from '../shared/WorkflowProgressDots';

interface WorkflowInlineCardProps {
  block: {
    taskId: string;
    taskTitle: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
  };
}

const STATUS_LABEL_KEY: Record<string, string> = {
  running: 'chat.workflowInline.running',
  done: 'chat.workflowInline.done',
  failed: 'chat.workflowInline.failed',
  aborted: 'chat.workflowInline.aborted',
};

const STATUS_LABEL_FALLBACK: Record<string, string> = {
  running: '◐ Running',
  done: '✓ Done',
  failed: '✗ Failed',
  aborted: '⊘ Stopped',
};

const STATUS_TONE = {
  running: 'accent',
  done: 'success',
  failed: 'danger',
  aborted: 'muted',
} as const;

function statusTone(status: WorkflowInlineCardProps['block']['streamStatus']) {
  return STATUS_TONE[status] ?? 'neutral';
}

function statusLabel(status: WorkflowInlineCardProps['block']['streamStatus']) {
  const t: (k: string) => string = window.t ?? ((k: string) => k);
  const key = STATUS_LABEL_KEY[status];
  if (key) {
    const translated = t(key);
    if (translated !== key) return translated;
  }
  return STATUS_LABEL_FALLBACK[status] ?? status;
}

export const WorkflowInlineCard = memo(function WorkflowInlineCard({ block }: WorkflowInlineCardProps) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);

  const childNodes = all.filter(
    (a) => (a.kind === 'workflow_agent' || a.kind === 'workflow_step') && a.parentTaskId === block.taskId
  );
  const agentCount = childNodes.filter((a) => a.kind === 'workflow_agent').length;

  let duration = '';
  if (block.finishedAt && block.startedAt) {
    duration = formatElapsed(block.finishedAt - block.startedAt);
  }

  const metaParts: string[] = [];
  if (agentCount > 0) metaParts.push(t('rightWorkspace.workflow.agents', { n: agentCount }));
  if (duration) metaParts.push(duration);
  const titleMeta = metaParts.join(' · ') || undefined;

  return (
    <ChatResourceCard
      variant="task"
      icon={<WorkflowResourceIcon />}
      title={block.taskTitle || t('rightWorkspace.workflow.title')}
      titleMeta={titleMeta}
      subtitle={childNodes.length > 0
        ? <WorkflowProgressDots nodes={childNodes} agents={agents} size="sm" />
        : (block.summary || undefined)
      }
      statusLabel={statusLabel(block.streamStatus)}
      statusTone={statusTone(block.streamStatus)}
    />
  );
});
