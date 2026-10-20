import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useMemo } from 'react';
import { useStore } from '../../stores';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import styles from './MentionBadgeView.module.css';

export function MentionBadgeView({ node }: NodeViewProps) {
  const label = String(node.attrs.label || node.attrs.sessionId || node.attrs.agentId || '');
  const kind = node.type.name === 'agentBadge' ? 'agent' : 'session';
  const agents = useStore(state => state.agents);
  const agentInfo = useMemo(() => kind === 'agent'
    ? resolveAgentDisplayInfo({
      id: String(node.attrs.agentId || ''),
      agents,
      fallbackAgentName: label,
    })
    : null, [agents, kind, label, node.attrs.agentId]);

  return (
    <NodeViewWrapper as="span" className={styles.badge} data-mention-kind={kind}>
      <span className={styles.at} aria-hidden="true">@</span>
      {kind === 'agent' && agentInfo ? (
        <AgentAvatar info={agentInfo} className={styles.avatar} alt="" />
      ) : (
        <span className={styles.icon} aria-hidden="true"><SessionMentionIcon /></span>
      )}
      <span className={styles.name}>{label}</span>
    </NodeViewWrapper>
  );
}

function SessionMentionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
