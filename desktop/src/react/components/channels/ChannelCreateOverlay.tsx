/**
 * ChannelCreateOverlay — 创建频道弹窗
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { createChannel } from '../../stores/channel-actions';
import { AgentAvatar, refreshAgentAvatarVersion, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { Overlay } from '../../ui';
import type { Agent } from '../../types';
import styles from './Channels.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any -- catch(err: any) 提取 message */

export function refreshCreateAvatarTs() { refreshAgentAvatarVersion(); }

function AgentChipAvatar({ agent, agents }: {
  agent: Agent;
  agents: Agent[];
}) {
  const info = resolveAgentDisplayInfo({
    id: agent.id,
    agents,
    fallbackAgentName: agent.name,
    fallbackAgentYuan: agent.yuan,
  });

  return (
    <span className={styles.chipAvatar}>
      <AgentAvatar info={info} className={styles.chipAvatarImg} />
    </span>
  );
}

export function ChannelCreateOverlay() {
  const { t } = useI18n();
  const agents = useStore(s => s.agents);
  const visible = useStore(s => s.channelCreateOverlayVisible);
  const setVisible = useStore(s => s.setChannelCreateOverlayVisible);

  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  // When overlay becomes visible, reset form and select all agents
  useEffect(() => {
    if (visible) {
      setName('');
      setIntro('');
      setSelectedMembers(agents.map((a) => a.id));
      setNameError(false);
      setMembersError(false);
      setSubmitError('');
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [visible, agents]);

  const toggleMember = useCallback((agentId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
    setMembersError(false);
    setSubmitError('');
  }, []);

  const handleCancel = useCallback(() => {
    setVisible(false);
  }, [setVisible]);

  const handleSubmit = useCallback(async () => {
    if (creating) return;
    if (!name.trim()) {
      setNameError(true);
      nameRef.current?.focus();
      return;
    }
    if (selectedMembers.length < 2) {
      setMembersError(true);
      setSubmitError(t('channel.minMembers'));
      return;
    }

    setCreating(true);
    setSubmitError('');
    try {
      await createChannel(name.trim(), selectedMembers, intro.trim() || undefined);
      setVisible(false);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (msg.includes('409') || msg.toLowerCase().includes('already exists') || msg.includes('已存在')) {
        setNameError(true);
        setSubmitError(t('channel.nameExists'));
        nameRef.current?.focus();
      } else {
        setSubmitError(msg || t('channel.createFailed'));
      }
    } finally {
      setCreating(false);
    }
  }, [creating, name, selectedMembers, intro, setVisible, t]);

  const memberHelper = selectedMembers.length < 2 ? t('channel.minMembers') : '';
  const canSubmit = !!name.trim() && selectedMembers.length >= 2;

  return (
    <Overlay
      scope="window"
      open={visible}
      onClose={handleCancel}
      backdrop="blur"
      zIndex={110}
      className={styles.createCard}
      disableContainerAnimation
    >
      <h3 className={styles.createTitle}>{t('channel.createTitle')}</h3>
      <div className={styles.createField}>
        <label className={styles.createFieldLabel}>{t('channel.createName')}</label>
        <input
          ref={nameRef}
          className={styles.createInput}
          type="text"
          placeholder={nameError ? t('channel.nameExists') : t('channel.createNamePlaceholder')}
          autoComplete="off"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(false); setSubmitError(''); }}
          style={nameError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
          spellCheck={false}
        />
      </div>
      <div className={styles.createField}>
        <label className={styles.createFieldLabel}>{t('channel.createMembers')}</label>
        <div
          className={styles.channelCreateMembers}
          style={membersError ? { outline: '1.5px solid var(--danger, #c44)' } : undefined}
        >
          {agents.map((agent) => {
            const isSelected = selectedMembers.includes(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                className={`${styles.channelCreateMemberChip}${isSelected ? ` ${styles.channelCreateMemberChipSelected}` : ''}`}
                onClick={() => toggleMember(agent.id)}
              >
                <AgentChipAvatar agent={agent} agents={agents} />
                <span>{agent.name || agent.id}</span>
              </button>
            );
          })}
      </div>
        {memberHelper ? <div className={styles.createError}>{memberHelper}</div> : null}
      </div>
      <div className={styles.createField}>
        <label className={styles.createFieldLabel}>
          {t('channel.createIntro')}{' '}
          <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>
            {t('channel.createIntroOptional')}
          </span>
        </label>
        <textarea
          className={`${styles.createInput} ${styles.channelCreateIntro}`}
          rows={2}
          placeholder={t('channel.createIntroPlaceholder')}
          style={{ resize: 'vertical', minHeight: '2.4rem' }}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          spellCheck={false}
        />
      </div>
      {submitError && submitError !== memberHelper ? (
        <div className={styles.createError} role="alert">{submitError}</div>
      ) : null}
      <div className={styles.createActions}>
        <button className={styles.createCancel} onClick={handleCancel}>
          {t('channel.createCancel')}
        </button>
        <button className={styles.createConfirm} onClick={handleSubmit} disabled={creating || !canSubmit}>
          {t('channel.createConfirm')}
        </button>
        </div>
    </Overlay>
  );
}
