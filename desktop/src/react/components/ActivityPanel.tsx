import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useStore } from '../stores';
import { usePanel } from '../hooks/use-panel';
import { lucFetch } from '../hooks/use-luc-fetch';
import { fetchConfig, invalidateConfigCache } from '../hooks/use-config';
import { loadSessions, switchSession } from '../stores/session-actions';
import { formatSessionDate, injectCopyButtons, parseMoodFromContent } from '../utils/format';
import { formatElapsed } from '../utils/format-duration';
import { AgentAvatar, resolveAgentDisplayInfo } from '../utils/agent-display';
import { getMd } from '../utils/markdown';
import { useMermaidDiagrams } from '../hooks/use-mermaid-diagrams';
import { Collapse } from '../ui';
import fp from './FloatingPanels.module.css';
import chatStyles from './chat/Chat.module.css';
import { ChatResourceCard, type ChatResourceCardStatusTone } from './chat/ChatResourceCard';
import automationStyles from './automation/AutomationPanel.module.css';
import { AgentTabScroller, type AgentTabScrollerItem } from './automation/AgentTabScroller';
import type { Activity, Agent } from '../types';

interface ActivityItem extends Activity {
  summary?: string;
  label?: string;
  status?: string;
  agentId?: string;
  agentName?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface DetailMessage {
  role: string;
  content: string;
}

const FLEX_COLUMN_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };
const ACTIVITY_BUCKETS = ['automation', 'patrol', 'other'] as const;
type ActivityBucket = typeof ACTIVITY_BUCKETS[number];

function activityBucket(type: string): ActivityBucket {
  if (type === 'heartbeat') return 'patrol';
  if (type === 'cron') return 'automation';
  return 'other';
}

function bucketLabel(bucket: ActivityBucket, t: (k: string) => string) {
  if (bucket === 'automation') return t('activity.automationRuns');
  if (bucket === 'patrol') return t('activity.patrolRuns');
  return t('activity.otherRuns');
}

function activityAgentId(activity: ActivityItem, fallback: string | null) {
  return activity.agentId || fallback || '__unknown__';
}

function groupActivities(activities: ActivityItem[], currentAgentId: string | null) {
  const grouped = new Map<string, Map<ActivityBucket, ActivityItem[]>>();
  for (const activity of activities) {
    const agentId = activityAgentId(activity, currentAgentId);
    const bucket = activityBucket(activity.type);
    const byBucket = grouped.get(agentId) || new Map<ActivityBucket, ActivityItem[]>();
    const list = byBucket.get(bucket) || [];
    list.push(activity);
    byBucket.set(bucket, list);
    grouped.set(agentId, byBucket);
  }
  return grouped;
}

function activityAgentTabIds(agents: Agent[], grouped: Map<string, Map<ActivityBucket, ActivityItem[]>>) {
  const ids = agents.map(agent => agent.id);
  for (const id of grouped.keys()) {
    if (id !== '__unknown__' && !ids.includes(id)) ids.push(id);
  }
  if (grouped.has('__unknown__')) ids.push('__unknown__');
  return ids;
}

function firstNonEmptyBucket(buckets: Map<ActivityBucket, ActivityItem[]> | undefined): ActivityBucket {
  return ACTIVITY_BUCKETS.find(bucket => (buckets?.get(bucket)?.length || 0) > 0) || 'automation';
}

export function ActivityPanel() {
  const activities = useStore(s => s.activities) as ActivityItem[];
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentName = useStore(s => s.agentName);
  const setActivities = useStore(s => s.setActivities);

  const [hbEnabled, setHbEnabled] = useState(true);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(currentAgentId);
  const [selectedBucket, setSelectedBucket] = useState<ActivityBucket>('automation');
  const t = window.t ?? ((p: string) => p);
  const groupedActivities = useMemo(() => groupActivities(activities, currentAgentId), [activities, currentAgentId]);
  const agentTabs = useMemo(() => activityAgentTabIds(agents, groupedActivities), [agents, groupedActivities]);
  const activeAgentId = selectedAgentId && agentTabs.includes(selectedAgentId)
    ? selectedAgentId
    : currentAgentId && agentTabs.includes(currentAgentId)
      ? currentAgentId
      : agentTabs[0] || null;
  const activeBuckets = activeAgentId ? groupedActivities.get(activeAgentId) : undefined;
  const activeActivities = activeBuckets?.get(selectedBucket) || [];
  const agentTabItems = useMemo<AgentTabScrollerItem[]>(() => agentTabs.map(agentId => {
    const buckets = groupedActivities.get(agentId);
    const firstActivity = ACTIVITY_BUCKETS
      .flatMap(bucket => buckets?.get(bucket) || [])
      .find(Boolean);
    const info = resolveAgentDisplayInfo({
      id: agentId === '__unknown__' ? null : agentId,
      agents,
      fallbackAgentName: firstActivity?.agentName || agentName,
    });
    return {
      id: agentId,
      label: info.displayName,
      avatar: <AgentAvatar info={info} className={automationStyles.agentTabAvatar} />,
    };
  }), [agentName, agentTabs, agents, groupedActivities]);

  useEffect(() => {
    if (activeAgentId && activeAgentId !== selectedAgentId) {
      setSelectedAgentId(activeAgentId);
    }
  }, [activeAgentId, selectedAgentId]);

  useEffect(() => {
    setSelectedBucket(firstNonEmptyBucket(activeBuckets));
  }, [activeAgentId, activeBuckets]);

  const loadData = useCallback(() => {
    lucFetch('/api/desk/activities')
      .then(r => r.json())
      .then(data => setActivities(data.activities || []))
      .catch(err => console.warn('[activity] fetch activities failed:', err));
    fetchConfig()
      .then(data => setHbEnabled(data.desk?.heartbeat_master !== false))
      .catch(err => console.warn('[activity] fetch config failed:', err));
  }, [setActivities]);

  const { visible, close: closePanel } = usePanel('activity', loadData, [currentAgentId]);
  const close = useCallback(() => { closePanel(); }, [closePanel]);

  const toggleHeartbeat = useCallback(async () => {
    const next = !hbEnabled;
    setHbEnabled(next);
    try {
      await lucFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desk: { heartbeat_master: next } }),
      });
      invalidateConfigCache();
    } catch {
      setHbEnabled(!next); // rollback
    }
  }, [hbEnabled]);

  const promoteActivity = useCallback(async (activityId: string) => {
    try {
      const res = await lucFetch(`/api/desk/activities/${activityId}/promote`, { method: 'POST' });
      const data = await res.json();
      if (data.error || !data.sessionPath) return;
      await loadSessions();
      await switchSession(data.sessionPath);
      const latest = useStore.getState().activities;
      setActivities(latest.filter(a => a.id !== activityId));
    } catch (err) {
      console.error('[activity] promote failed:', err);
    }
  }, [setActivities]);

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="activityPanel">
      <div className={fp.floatingPanelInner}>
        <div id="activityListView" style={FLEX_COLUMN_STYLE}>
          <div className={fp.floatingPanelHeader}>
              <h2 className={fp.floatingPanelTitle}>{t('activity.title')}</h2>
              <div className={fp.activityHbToggle}>
                <span className="luc-toggle-label">{t('activity.heartbeat')}</span>
                <button
                  className={'luc-toggle' + (hbEnabled ? ' on' : '')}
                  onClick={toggleHeartbeat}
                />
              </div>
            <button className={fp.floatingPanelClose} onClick={close}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className={fp.floatingPanelBody}>
            <div className={fp.activityCards} id="activityCards">
              {agentTabs.length === 0 ? (
                <div className={fp.activityEmpty}>{t('activity.empty')}</div>
              ) : (
                <>
                  <AgentTabScroller
                    items={agentTabItems}
                    activeId={activeAgentId}
                    ariaLabel={t('activity.agentTabs')}
                    previousLabel={t('activity.previousAgent')}
                    nextLabel={t('activity.nextAgent')}
                    onSelect={agentId => {
                      setSelectedAgentId(agentId);
                      setSelectedBucket(firstNonEmptyBucket(groupedActivities.get(agentId)));
                    }}
                  />
                  <div className={automationStyles.categoryTabs} role="tablist" aria-label={t('activity.categoryTabs')}>
                    {ACTIVITY_BUCKETS.map(bucket => {
                      const count = activeBuckets?.get(bucket)?.length || 0;
                      const active = bucket === selectedBucket;
                      return (
                        <button
                          key={bucket}
                          className={automationStyles.categoryTab}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          data-active={active}
                          onClick={() => setSelectedBucket(bucket)}
                        >
                          <span>{bucketLabel(bucket, t)}</span>
                          <span className={automationStyles.categoryTabCount}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className={automationStyles.groupList}>
                    {activeActivities.length === 0 ? (
                      <div className={fp.activityEmpty}>{t('activity.emptyForCategory')}</div>
                    ) : activeActivities.map(a => (
                      <ActivityCard
                        key={a.id}
                        activity={a}
                        agents={agents}
                        currentAgentId={currentAgentId}
                        agentName={agentName}
                        onPromote={promoteActivity}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityCard({
  activity: a,
  agents,
  currentAgentId,
  agentName,
  onPromote,
}: {
  activity: ActivityItem;
  agents: Agent[];
  currentAgentId: string | null;
  agentName: string;
  onPromote: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DetailMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const agentId = a.agentId || currentAgentId;
  const displayInfo = resolveAgentDisplayInfo({
    id: agentId,
    agents,
    fallbackAgentName: a.agentName || agentName,
  });

  const t = window.t ?? ((p: string) => p);
  const typeText = a.type === 'heartbeat' ? t('activity.heartbeat')
    : a.type === 'subagent' ? t('activity.subagent')
    : (a.label || t('activity.cron'));
  const canUseSession = !!a.sessionFile;

  let durationText = '';
  if (a.finishedAt && a.startedAt) {
    durationText = t('activity.duration', { text: formatElapsed(a.finishedAt - a.startedAt) });
  }
  const timeText = a.startedAt ? formatSessionDate(new Date(a.startedAt).toISOString()) : '';
  const subtitle = a.summary || (a.type === 'heartbeat' ? t('activity.patrolDone') : t('activity.cronDone'));
  const statusLabel = a.status === 'error'
    ? t('activity.error')
    : a.status === 'running'
      ? t('common.executing')
      : durationText || timeText;
  const statusTone: ChatResourceCardStatusTone = a.status === 'error'
    ? 'danger'
    : a.status === 'running'
      ? 'accent'
      : 'muted';

  useEffect(() => {
    if (!open || !canUseSession || messages !== null || loadError) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    void lucFetch(`/api/desk/activities/${a.id}/session`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setMessages(Array.isArray(data.messages) ? data.messages : []);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [a.id, canUseSession, loadError, messages, open]);

  const toggleOpen = () => {
    if (!canUseSession) return;
    if (!open && loadError) setLoadError(false);
    setOpen(v => !v);
  };

  return (
    <div className={fp.activitySessionItem} data-open={open || undefined}>
      <ChatResourceCard
        className={`${fp.activitySessionCard}${a.status === 'error' ? ` ${fp.activitySessionCardError}` : ''}`}
        icon={<AgentAvatar info={displayInfo} className={fp.activitySessionAvatar} alt={displayInfo.displayName} />}
        title={displayInfo.displayName}
        titleMeta={`· ${typeText}`}
        subtitle={subtitle}
        statusLabel={statusLabel}
        statusTone={statusTone}
        actionSlot={(
          <>
            <button
              type="button"
              className={fp.activitySessionAction}
              data-active={open || undefined}
              onClick={toggleOpen}
              disabled={!canUseSession}
              title={open ? t('activity.collapse') : t('activity.expand')}
              aria-label={open ? t('activity.collapse') : t('activity.expand')}
              aria-expanded={open}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <button
              type="button"
              className={fp.activitySessionAction}
              onClick={() => onPromote(a.id)}
              disabled={!canUseSession}
              title={t('activity.promote')}
              aria-label={t('activity.promote')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="17 11 12 6 7 11" />
                <line x1="12" y1="6" x2="12" y2="18" />
              </svg>
            </button>
          </>
        )}
      />
      <Collapse open={open}>
        <ActivityInlineTranscript
          messages={messages || []}
          loading={loading}
          error={loadError}
        />
      </Collapse>
    </div>
  );
}

function ActivityInlineTranscript({ messages, loading, error }: {
  messages: DetailMessage[];
  loading: boolean;
  error: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = window.t ?? ((p: string) => p);
  const mdInstance = getMd();

  useEffect(() => {
    if (bodyRef.current) {
      injectCopyButtons(bodyRef.current);
    }
  }, [messages]);
  useMermaidDiagrams(bodyRef, [messages]);

  if (loading) {
    return <div className={fp.activityInlineTranscript}>{t('activity.loadingSession')}</div>;
  }
  if (error) {
    return <div className={fp.activityInlineTranscript}>{t('activity.sessionLoadFailed')}</div>;
  }
  if (messages.length === 0) {
    return <div className={fp.activityInlineTranscript}>{t('activity.noSessionMessages')}</div>;
  }

  return (
    <div className={fp.activityInlineTranscript} ref={bodyRef}>
      {messages.map((m, i) => {
        if (m.role === 'assistant') {
          const { mood, text } = parseMoodFromContent(m.content);
          return (
            <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgAssistant}`}>
              <div className={fp.activityDetailBubble}>
                {mood && (
                  <details className={chatStyles.moodWrapper}>
                    <summary className={chatStyles.moodSummary}>{t('mood.label')}</summary>
                    <div className={chatStyles.moodBlock}>{mood}</div>
                  </details>
                )}
                {text && (
                  <div
                    className="md-content"
                    dangerouslySetInnerHTML={{
                      __html: mdInstance
                        ? mdInstance.render(text.replace(/<tool_code>[\s\S]*?<\/tool_code>\s*/g, ''))
                        : text,
                    }}
                  />
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={`msg-${i}`} className={`${fp.activityDetailMsg} ${fp.activityDetailMsgUser}`}>
            <div className={fp.activityDetailBubble}>{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}
