import { memo } from 'react';
import type { AgentActivityEntry } from '../../stores/agent-activity-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { ParallelStepIcon, PipelineStepIcon, LogStepIcon } from './WorkflowStepIcons';
import type { Agent } from '../../types';
import styles from './WorkflowProgressDots.module.css';

const SIZE = { sm: 12, md: 20 } as const;

interface WorkflowProgressDotsProps {
  nodes: AgentActivityEntry[];
  agents: Agent[];
  size?: 'sm' | 'md';
  className?: string;
}

function StepShape({ stepKind, size }: { stepKind: string | null | undefined; size: number }) {
  switch (stepKind) {
    case 'parallel': return <ParallelStepIcon size={size} />;
    case 'pipeline': return <PipelineStepIcon size={size} />;
    case 'log': return <LogStepIcon size={size} />;
    default: return <PipelineStepIcon size={size} />;
  }
}

export const WorkflowProgressDots = memo(function WorkflowProgressDots({
  nodes,
  agents,
  size = 'sm',
  className,
}: WorkflowProgressDotsProps) {
  const px = SIZE[size];
  const sorted = [...nodes].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  return (
    <span className={`${styles.dots}${className ? ` ${className}` : ''}`}>
      {sorted.map((node) => {
        if (node.kind === 'workflow_step') {
          return (
            <span key={node.id} className={styles.dot} data-status={node.status} data-step-kind={node.stepKind}>
              <StepShape stepKind={node.stepKind} size={px} />
            </span>
          );
        }
        const info = resolveAgentDisplayInfo({
          id: node.agentId,
          agents,
          fallbackAgentName: node.label || node.agentName || node.agentId || 'agent',
        });
        return (
          <span
            key={node.id}
            className={`${styles.dot} ${styles.avatarWrap} ${size === 'sm' ? styles.avatarSm : styles.avatarMd}`}
            data-status={node.status}
          >
            <AgentAvatar info={info} alt={info.displayName} />
          </span>
        );
      })}
    </span>
  );
});
