import { memo, useEffect, useState } from 'react';
import { ChatResourceCard } from './ChatResourceCard';
import { lucFetch } from '../../hooks/use-luc-fetch';
import { useStore } from '../../stores';
import { sessionIdForPathFromLocatorState } from '../../stores/session-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from './Chat.module.css';

/**
 * SessionCollabDraftCard — 跨 session 协作草稿确认卡（send / create）
 *
 * 渲染 `suggestion_card` 里 kind 为 `session_send_draft` / `session_create_draft`
 * 的 block：send 卡编辑目标 session 的消息正文，create 卡编辑目标 Agent 与首条消息。
 * 确认走 POST /api/session-collab/apply，忽略走 POST /api/session-collab/reject，
 * 两者都把决策落到源 session 的 JSONL（见 lib/session-collab/decision-record.ts），
 * 历史重建时 server 端用 core/message-utils.ts 的 overlaySessionCollabDecision
 * 覆盖 block.status（+ resultSessionId），所以重开 session 不会回弹 pending。
 */

type ApplyErrorState =
  | { code: 'draft_expired'; text: string }
  | { code: 'draft_in_flight'; text: string }
  | { code: 'first_message_failed'; text: string; sessionId?: string }
  | { code: 'apply_failed'; text: string };

function shortIdTail(id: string | null): string {
  return id ? `…${id.slice(-4)}` : '';
}

export const SessionCollabDraftCard = memo(function SessionCollabDraftCard({ block, sessionPath }: { block: any; sessionPath?: string }) {
  const isCreate = block.kind === 'session_create_draft';
  const detail = block.detail || {};
  const draft = detail.draft || {};

  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const fallbackAgentName = useStore(s => s.agentName) || 'Luc';
  const fallbackAgentYuan = useStore(s => s.agentYuan) || 'luc';
  // reject 的 sourceSessionId 必须是真正的 sessionId，不能拿 sessionPath 充数——
  // 走 store 里 path→sessionId 的既有映射（session-slice.ts），查不到就不带这个字段，
  // 后端对活条目（store.get 命中）本就不强制要求它。
  const sourceSessionId = useStore(state => sessionIdForPathFromLocatorState(state, sessionPath));
  const targetSessionId = (block.target?.sessionId as string | undefined) || null;
  const targetSessionTitle = useStore(s => (
    targetSessionId ? (s.sessions.find(se => se.sessionId === targetSessionId)?.title ?? null) : null
  ));

  const [status, setStatus] = useState(block.status);
  const [draftMessage, setDraftMessage] = useState<string>(
    ((isCreate ? draft.firstMessage : draft.message) as string) || '',
  );
  const [draftTitle, setDraftTitle] = useState<string>((draft.title as string) || '');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    (draft.agentId as string) || currentAgentId || agents[0]?.id || null,
  );
  const [errorState, setErrorState] = useState<ApplyErrorState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);

  useEffect(() => {
    setStatus(block.status);
  }, [block.status]);

  const effectiveAgentId = selectedAgentId || currentAgentId || agents[0]?.id || null;
  const selectedAgentInfo = resolveAgentDisplayInfo({
    id: effectiveAgentId,
    agents,
    fallbackAgentName,
    fallbackAgentYuan,
  });
  // send 卡头像跟目标 session 的归属 agent 走，跟本地选择器无关；
  // create 卡头像跟随 agent 选择器当前值（selectedAgentInfo）。
  const targetAgentInfo = resolveAgentDisplayInfo({
    id: (block.target?.agentId as string) || null,
    agents,
    fallbackAgentName: (block.target?.agentName as string) || undefined,
    fallbackAgentYuan: (block.target?.agentId as string) || undefined,
  });
  const headerAgentInfo = isCreate ? selectedAgentInfo : targetAgentInfo;
  // send 卡标题优先用 store 里按 sessionId 匹配到的真实会话名；查不到时按契约退化，
  // 任何一级都不允许把裸 sessionId 露出来给用户看。
  const displayTitle = isCreate
    ? (block.title || window.t('sessionCollab.messageField'))
    : (targetSessionTitle
        || (block.target?.sessionTitle as string | undefined)
        || (block.target?.agentName
              ? `${block.target.agentName as string} ${shortIdTail(targetSessionId)}`.trim()
              : null)
        || window.t('sessionCollab.messageField'));

  const pending = status === 'pending';
  const expired = errorState?.code === 'draft_expired';

  const handleApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorState(null);
    try {
      const editedDraft = isCreate
        ? { ...draft, agentId: effectiveAgentId, title: draftTitle, firstMessage: draftMessage }
        : { ...draft, message: draftMessage };
      const res = await lucFetch('/api/session-collab/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestionId: block.suggestionId, draft: editedDraft }),
        throwOnHttpError: false,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCreatedSessionId((data?.result?.sessionId as string) || null);
        setStatus('approved');
        return;
      }
      const code = data?.code;
      if (code === 'draft_expired') {
        setErrorState({ code: 'draft_expired', text: window.t('sessionCollab.expired') });
        return;
      }
      if (code === 'draft_in_flight') {
        setErrorState({ code: 'draft_in_flight', text: window.t('sessionCollab.inFlight') });
        return;
      }
      if (code === 'first_message_failed') {
        const sid = (data?.sessionId as string) || '';
        setErrorState({
          code: 'first_message_failed',
          sessionId: sid,
          text: window.t('sessionCollab.halfCreated', { id: sid }),
        });
        return;
      }
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.sendFailed', { error: (data?.error as string) || res.statusText }),
      });
    } catch (err: any) {
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.sendFailed', { error: err?.message || String(err) }),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleIgnore = async () => {
    if (submitting || rejecting) return;
    setRejecting(true);
    setErrorState(null);
    try {
      const body: Record<string, unknown> = { suggestionId: block.suggestionId };
      if (sourceSessionId) body.sourceSessionId = sourceSessionId;
      const res = await lucFetch('/api/session-collab/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        throwOnHttpError: false,
      });
      // 后端契约：活条目命中直接废弃，200；条目已过期（比如重复点击）404 一样按
      // 已忽略收敛——不是错误，用户的意图（不想要这条草稿）已经达成。
      if (res.ok || res.status === 404) {
        setStatus('rejected');
        return;
      }
      if (res.status === 409) {
        setErrorState({ code: 'draft_in_flight', text: window.t('sessionCollab.inFlight') });
        return;
      }
      const data = await res.json().catch(() => ({}));
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.rejectFailed', { error: (data?.error as string) || res.statusText }),
      });
    } catch (err: any) {
      setErrorState({
        code: 'apply_failed',
        text: window.t('sessionCollab.rejectFailed', { error: err?.message || String(err) }),
      });
    } finally {
      setRejecting(false);
    }
  };

  if (!pending) {
    const isApproved = status === 'approved';
    const effectiveCreatedId = createdSessionId || (block.resultSessionId as string | undefined) || null;
    const subtitle = isApproved && isCreate && effectiveCreatedId
      ? window.t('sessionCollab.createdSession', { id: effectiveCreatedId })
      : block.description;
    return (
      <ChatResourceCard
        icon={<AgentAvatar info={headerAgentInfo} className={styles.sessionCollabDraftAvatar} alt={headerAgentInfo.displayName} />}
        title={displayTitle}
        subtitle={subtitle}
        statusLabel={isApproved ? window.t('common.approved') : window.t('common.rejected')}
        statusTone={isApproved ? 'success' : 'muted'}
        className={styles.sessionCollabDraftCard}
      />
    );
  }

  // create 编辑卡走无头形态：头部行（头像+agent 名+消息预览）与下方的
  // 助手选择器/消息输入完全重复，属无效信息（用户确认的取舍）。
  // 字段顺序：助手 → 标题 → 首条消息。send 卡头部是目标会话信息，保留。
  const pendingCardProps = isCreate
    ? { headerless: true as const }
    : {
      icon: <AgentAvatar info={headerAgentInfo} className={styles.sessionCollabDraftAvatar} alt={headerAgentInfo.displayName} />,
      title: displayTitle,
      subtitle: block.description,
      expandable: false,
      expanded: true,
    };
  return (
    <ChatResourceCard
      {...pendingCardProps}
      className={styles.sessionCollabDraftCard}
    >
      <div className={styles.sessionCollabDraftBody}>
        {isCreate && (
          <>
            <label className={styles.automationDraftField}>
              <span>{window.t('automation.field.agent')}</span>
              <SelectWidget
                className={styles.automationDraftAgentSelect}
                triggerClassName={styles.automationDraftControlButton}
                popupClassName={styles.automationDraftAgentPopup}
                value={effectiveAgentId || ''}
                options={agents.map((agent: any): SelectOption => ({
                  value: agent.id,
                  label: agent.name || agent.id,
                }))}
                onChange={(value) => setSelectedAgentId(value)}
                align="start"
                density="comfortable"
                renderTrigger={(_option, isOpen) => (
                  <>
                    <AgentAvatar info={selectedAgentInfo} className={styles.automationDraftAgentAvatar} />
                    <span className={styles.automationDraftAgentName}>{selectedAgentInfo.displayName}</span>
                    <svg className={styles.automationDraftControlArrow} data-open={isOpen} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </>
                )}
                renderOption={(option, selected) => {
                  const info = resolveAgentDisplayInfo({
                    id: option.value,
                    agents,
                    fallbackAgentName: option.label,
                  });
                  return (
                    <span className={styles.automationDraftAgentOption} data-selected={selected}>
                      <AgentAvatar info={info} className={styles.automationDraftAgentAvatar} />
                      <span>{info.displayName}</span>
                    </span>
                  );
                }}
              />
            </label>
            <input
              className={styles.sessionCollabDraftTitleInput}
              value={draftTitle}
              onChange={e => setDraftTitle(e.target.value)}
              placeholder={window.t('automation.field.label')}
              spellCheck={false}
            />
          </>
        )}
        <textarea
          className={styles.sessionCollabDraftTextarea}
          value={draftMessage}
          onChange={e => setDraftMessage(e.target.value)}
          aria-label={window.t('sessionCollab.messageField')}
          spellCheck={false}
        />
        {errorState && (
          <div className={styles.sessionCollabDraftError}>{errorState.text}</div>
        )}
        <div className={styles.automationDraftActions}>
          <button
            className={styles.automationDraftTextButton}
            type="button"
            onClick={handleIgnore}
            disabled={submitting || rejecting}
          >
            {window.t('sessionCollab.ignore')}
          </button>
          <button
            className={styles.automationDraftPrimaryButton}
            type="button"
            onClick={handleApprove}
            disabled={submitting || rejecting || expired}
          >
            {window.t(isCreate ? 'sessionCollab.confirmCreate' : 'sessionCollab.confirmSend')}
          </button>
        </div>
      </div>
    </ChatResourceCard>
  );
});
