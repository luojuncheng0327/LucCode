/**
 * AgentActivityCard — 右侧「子助手」卡（复刻群聊 Agent 动态：行 + 展开实时流）
 *
 * 消费统一 Agent Activity 真相源（agentActivitiesBySession），按当前对话 sessionPath
 * 筛 kind=subagent。每行复刻群聊：头像 + 名字 + 最新动态；点击展开子会话实时流
 * （复用 chat/SubagentSessionPreview，传 childSessionPath）。无子助手时返回 null（desk 撑满）。
 */
import { useEffect, useRef, useState } from 'react';
import { Collapse } from '@/ui';
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SubagentSessionPreview } from '../chat/SubagentSessionPreview';
import type { Agent } from '../../types';
import styles from './AgentActivityCard.module.css';

function rank(status: AgentActivityEntry['status']): number {
  return status === 'running' ? 0 : 1; // 运行中优先
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SubagentActivityRow({ entry, agents, open, onToggle }: {
  entry: AgentActivityEntry;
  agents: Agent[];
  open: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const info = resolveAgentDisplayInfo({
    id: entry.agentId,
    agents,
    fallbackAgentName: entry.agentName || entry.agentId || 'Subagent',
  });
  const displayLabel = entry.label || null;

  // 展开且子会话已就绪时，把 preview entry 的 sessionPath 对齐到 childSessionPath。
  // SubagentSessionPreview 内部用它做 race 校验；右侧卡自持此契约，不依赖群聊 SubagentCard 是否 mount。
  useEffect(() => {
    if (open && entry.childSessionPath) {
      useStore.getState().setSubagentPreviewSessionPath(entry.id, entry.childSessionPath);
    }
  }, [open, entry.childSessionPath, entry.id]);

  return (
    <div className={styles.item}>
      <button
        type="button"
        className={styles.activityRow}
        data-status={entry.status}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={styles.avatar}>
          <AgentAvatar info={info} className={styles.avatarImg} alt={info.displayName} />
        </span>
        <span className={styles.nameGroup}>
          <span className={styles.name} title={info.displayName}>{info.displayName}</span>
          {displayLabel ? <span className={styles.instance} title={displayLabel}>·{displayLabel}</span> : null}
        </span>
        <span className={styles.summary} title={entry.summary || ''}>{entry.summary || ''}</span>
      </button>
      <Collapse open={open}>
        <div className={styles.details}>
          <div ref={scrollRef} className={styles.scroll}>
            <SubagentSessionPreview
              taskId={entry.id}
              sessionPath={entry.childSessionPath}
              agentId={entry.agentId}
              streamStatus={entry.status}
              summary={entry.summary}
              scrollContainerRef={scrollRef}
            />
          </div>
        </div>
      </Collapse>
    </div>
  );
}

export function AgentActivityCard() {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);
  const t = window.t ?? ((k: string) => k);

  // 这张卡只管 subagent；workflow 已拆到 WorkflowCard，巡检系统级不进当前对话。
  const activities = all.filter((a) => a.kind === 'subagent');
  if (!activities.length) return null;

  const sorted = [...activities].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <section className={`universal-card ${styles.card}`} aria-label={t('rightWorkspace.subagent.title')} data-collapsed={collapsed || undefined}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.subagent.title')}</span>
        <span className={styles.count}>{sorted.length}</span>
        <Chevron open={!collapsed} />
      </button>
      <Collapse open={!collapsed}>
        <div className={styles.list}>
          {sorted.map((a) => (
            <SubagentActivityRow
              key={a.id}
              entry={a}
              agents={agents}
              open={expanded[a.id] === true}
              onToggle={() => setExpanded((prev) => ({ ...prev, [a.id]: !prev[a.id] }))}
            />
          ))}
        </div>
      </Collapse>
    </section>
  );
}
