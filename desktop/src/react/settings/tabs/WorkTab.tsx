import React, { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store';
import { t, autoSaveConfig, refreshSettingsConfigSnapshot } from '../helpers';
import { lucFetch } from '../api';
import { Toggle } from '@/ui';
import { AgentSelect } from './bridge/AgentSelect';
import { BridgePermissionModeSelect, type BridgePermissionMode } from './bridge/BridgeWidgets';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { NumberInput } from '../components/NumberInput';
import { readConfigBoolean } from '../resource-state';
import styles from '../Settings.module.css';
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from '../../../../../shared/default-workspace-constants.ts';

type AgentDeskConfig = {
  home_folder: string;
  heartbeat_enabled: boolean;
  heartbeat_interval: number;
  workspace_context: {
    inject_agents_md: boolean;
    inject_claude_md: boolean;
    discover_project_skills: boolean;
    discover_compatible_project_skills: boolean;
  };
};

function normalizeAutomationPermissionMode(value: unknown): BridgePermissionMode {
  return value === 'operate' || value === 'read_only' ? value : 'auto';
}

function deskFromConfig(data: Record<string, any>): AgentDeskConfig {
  return {
    home_folder: data.desk?.home_folder || '',
    heartbeat_enabled: data.desk?.heartbeat_enabled === true,
    heartbeat_interval: data.desk?.heartbeat_interval ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    workspace_context: {
      inject_agents_md: data.workspace_context?.inject_agents_md === true,
      inject_claude_md: data.workspace_context?.inject_claude_md === true,
      discover_project_skills: data.workspace_context?.discover_project_skills !== false,
      discover_compatible_project_skills: data.workspace_context?.discover_compatible_project_skills === true,
    },
  };
}

function agentDeskFromStoreForAgent(agentId: string | null): AgentDeskConfig | null {
  if (!agentId) return null;
  const state = useSettingsStore.getState();
  const configOwnerId = state.settingsSnapshot?.data?.agentId
    || state.settingsAgentId
    || (state.settingsConfigStatus === 'ready' ? state.currentAgentId : null);
  if (!state.settingsConfig || configOwnerId !== agentId) return null;
  return deskFromConfig(state.settingsConfig);
}

export function WorkTab() {
  const { settingsConfig, settingsConfigStatus, currentAgentId, settingsAgentId, settingsSnapshotAgentId } = useSettingsStore(
    useShallow(s => ({
      settingsConfig: s.settingsConfig,
      settingsConfigStatus: s.settingsConfigStatus,
      currentAgentId: s.currentAgentId,
      settingsAgentId: s.settingsAgentId,
      settingsSnapshotAgentId: s.settingsSnapshot?.data?.agentId || null,
    }))
  );
  const showToast = useSettingsStore(s => s.showToast);

  // ── Global toggles：直接从 store 派生，单一数据源，避免挂载时 flicker ──
  const heartbeatMaster = readConfigBoolean(settingsConfig, cfg => cfg.desk?.heartbeat_master, true);
  const automationPermissionMode = settingsConfig
    ? normalizeAutomationPermissionMode(settingsConfig.automation?.permissionMode)
    : undefined;

  // ── Agent selector (作为 section context，表达"当前配置哪个 agent") ──
  const initialAgentId = settingsAgentId || currentAgentId;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  useEffect(() => {
    if (selectedAgentId) return;
    const agentId = settingsAgentId || currentAgentId;
    if (agentId) setSelectedAgentId(agentId);
  }, [currentAgentId, selectedAgentId, settingsAgentId]);

  // ── Per-agent 远程快照：null = 未加载。切 agent 时重置，避免残留上一个 agent 的值 ──
  const [agentDesk, setAgentDesk] = useState<AgentDeskConfig | null>(() => agentDeskFromStoreForAgent(initialAgentId));
  // hbInterval 是 draft：用户编辑后点"保存"才落盘，必须独立于 agentDesk
  const [hbIntervalDraft, setHbIntervalDraft] = useState<number | null>(() => agentDeskFromStoreForAgent(initialAgentId)?.heartbeat_interval ?? null);

  useEffect(() => {
    if (!selectedAgentId) return;
    const configOwnerId = settingsSnapshotAgentId
      || settingsAgentId
      || (settingsConfigStatus === 'ready' ? currentAgentId : null);
    if (settingsConfig && configOwnerId === selectedAgentId) {
      const desk = deskFromConfig(settingsConfig);
      setAgentDesk(desk);
      setHbIntervalDraft(desk.heartbeat_interval);
      return;
    }
    setAgentDesk(null);
    setHbIntervalDraft(null);
    const ac = new AbortController();
    lucFetch(`/api/agents/${selectedAgentId}/config`, { signal: ac.signal })
      .then(r => r.json())
      .then(data => {
        if (ac.signal.aborted) return;
        const desk = deskFromConfig(data);
        setAgentDesk(desk);
        setHbIntervalDraft(desk.heartbeat_interval);
      })
      .catch(err => {
        if (err?.name !== 'AbortError') console.warn('[work] fetch agent config failed:', err);
      });
    return () => ac.abort();
  }, [currentAgentId, selectedAgentId, settingsAgentId, settingsConfig, settingsConfigStatus, settingsSnapshotAgentId]);

  const toggleHeartbeatMaster = async (on: boolean) => {
    await autoSaveConfig({ desk: { heartbeat_master: on } });
  };

  const saveAutomationPermissionMode = async (mode: BridgePermissionMode) => {
    await autoSaveConfig({ automation: { permissionMode: mode } });
  };

  const saveAgentConfig = async (agentId: string, patch: Record<string, any>): Promise<boolean> => {
    if (!agentId) return false;
    try {
      const res = await lucFetch(`/api/agents/${agentId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (agentId === useSettingsStore.getState().getSettingsAgentId()) {
        try {
          await refreshSettingsConfigSnapshot();
        } catch (err) {
          console.warn('[work] refresh settings snapshot failed:', err);
        }
      }
      if (selectedAgentIdRef.current === agentId) {
        showToast(t('settings.autoSaved'), 'success');
      }
      return true;
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
      return false;
    }
  };

  const togglePerAgentHeartbeat = async (on: boolean) => {
    if (!agentDesk) return;
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    const previous = agentDesk;
    setAgentDesk({ ...agentDesk, heartbeat_enabled: on });
    const saved = await saveAgentConfig(agentId, { desk: { heartbeat_enabled: on } });
    if (!saved && selectedAgentIdRef.current === agentId) {
      setAgentDesk(previous);
    }
  };

  const toggleWorkspaceContext = async (
    key: keyof AgentDeskConfig['workspace_context'],
    on: boolean,
  ) => {
    if (!agentDesk) return;
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    const previous = agentDesk;
    setAgentDesk({
      ...agentDesk,
      workspace_context: {
        ...agentDesk.workspace_context,
        [key]: on,
      },
    });
    const saved = await saveAgentConfig(agentId, { workspace_context: { [key]: on } });
    if (!saved && selectedAgentIdRef.current === agentId) {
      setAgentDesk(previous);
    }
  };

  const pickHomeFolder = async () => {
    if (!agentDesk) return;
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    const previous = agentDesk;
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    if (selectedAgentIdRef.current === agentId) {
      setAgentDesk({ ...agentDesk, home_folder: folder });
    }
    const saved = await saveAgentConfig(agentId, { desk: { home_folder: folder } });
    if (!saved && selectedAgentIdRef.current === agentId) {
      setAgentDesk(previous);
    }
  };

  const clearHomeFolder = async () => {
    if (!agentDesk) return;
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    const previous = agentDesk;
    setAgentDesk({ ...agentDesk, home_folder: '' });
    const saved = await saveAgentConfig(agentId, { desk: { home_folder: '' } });
    if (!saved && selectedAgentIdRef.current === agentId) {
      setAgentDesk(previous);
    }
  };

  const saveInterval = async () => {
    if (hbIntervalDraft == null || !agentDesk) return;
    const agentId = selectedAgentIdRef.current;
    if (!agentId) return;
    const previous = agentDesk;
    const previousDraft = hbIntervalDraft;
    const interval = Math.max(1, Math.min(120, hbIntervalDraft));
    setAgentDesk({ ...agentDesk, heartbeat_interval: interval });
    setHbIntervalDraft(interval);
    const saved = await saveAgentConfig(agentId, { desk: { heartbeat_interval: interval } });
    if (!saved && selectedAgentIdRef.current === agentId) {
      setAgentDesk(previous);
      setHbIntervalDraft(previousDraft);
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="work">
      {/* ── Global section（对所有 agent 生效的总开关） ── */}
      <SettingsSection title={t('settings.work.title')}>
        <SettingsRow
          label={t('settings.work.heartbeatMaster')}
          hint={t('settings.work.heartbeatMasterDesc')}
          control={<Toggle on={heartbeatMaster} onChange={toggleHeartbeatMaster} />}
        />
        <SettingsRow
          label={t('settings.work.automationPermissionMode')}
          hint={t('settings.work.automationPermissionModeDesc')}
          control={
            <BridgePermissionModeSelect
              value={automationPermissionMode}
              onChange={saveAutomationPermissionMode}
            />
          }
        />
      </SettingsSection>

      {/* ── Per-agent section（AgentSelect 作为 context，section 内所有配置针对该 agent） ── */}
      <SettingsSection
        title={t('settings.work.agentDeskSection')}
        context={<AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />}
      >
        {agentDesk && (
          <>
            <SettingsRow
              label={t('settings.work.heartbeatEnabled')}
              hint={t('settings.work.heartbeatOperationalNotice')}
              control={<Toggle on={agentDesk.heartbeat_enabled} onChange={togglePerAgentHeartbeat} />}
            />
            <SettingsRow
              label={t('settings.work.homeFolder')}
              hint={t('settings.work.homeFolderDesc')}
              layout="stacked"
              control={
                <div className={styles['settings-folder-picker']}>
                  <input
                    type="text"
                    className={`${styles['settings-input']} ${styles['settings-folder-input']}`}
                    readOnly
                    value={agentDesk.home_folder}
                    placeholder={t('settings.work.homeFolderPlaceholder')}
                    onClick={pickHomeFolder}
                  />
                  <button className={styles['settings-folder-browse']} onClick={pickHomeFolder}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  {agentDesk.home_folder && (
                    <button
                      className={styles['settings-folder-clear']}
                      onClick={clearHomeFolder}
                      title={t('settings.work.homeFolderClear')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </div>
              }
            />
            <SettingsRow
              label={t('settings.work.heartbeatInterval')}
              control={
                <>
                  <NumberInput
                    value={hbIntervalDraft ?? agentDesk.heartbeat_interval}
                    onChange={setHbIntervalDraft}
                    unit={t('settings.work.heartbeatUnit')}
                    min={1}
                    max={120}
                    disabled={!agentDesk.heartbeat_enabled}
                  />
                  <button className={styles['settings-save-btn-ghost']} onClick={saveInterval}>
                    {t('settings.save')}
                  </button>
                </>
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.work.contextFilesTitle')}
        description={t('settings.work.contextFilesDesc')}
        context={<AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />}
      >
        {agentDesk && (
          <>
            <SettingsRow
              label={t('settings.work.injectAgentsMd')}
              hint={t('settings.work.injectAgentsMdDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.inject_agents_md}
                  onChange={(on) => toggleWorkspaceContext('inject_agents_md', on)}
                  ariaLabel={t('settings.work.injectAgentsMd')}
                />
              }
            />
            <SettingsRow
              label={t('settings.work.injectClaudeMd')}
              hint={t('settings.work.injectClaudeMdDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.inject_claude_md}
                  onChange={(on) => toggleWorkspaceContext('inject_claude_md', on)}
                  ariaLabel={t('settings.work.injectClaudeMd')}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.work.projectSkillsTitle')}
        description={t('settings.work.projectSkillsDesc')}
        context={<AgentSelect value={selectedAgentId} onChange={setSelectedAgentId} />}
      >
        {agentDesk && (
          <>
            <SettingsRow
              label={t('settings.work.discoverProjectSkills')}
              hint={t('settings.work.discoverProjectSkillsDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.discover_project_skills}
                  onChange={(on) => toggleWorkspaceContext('discover_project_skills', on)}
                  ariaLabel={t('settings.work.discoverProjectSkills')}
                />
              }
            />
            <SettingsRow
              label={t('settings.work.discoverCompatibleProjectSkills')}
              hint={t('settings.work.discoverCompatibleProjectSkillsDesc')}
              control={
                <Toggle
                  on={agentDesk.workspace_context.discover_compatible_project_skills}
                  onChange={(on) => toggleWorkspaceContext('discover_compatible_project_skills', on)}
                  ariaLabel={t('settings.work.discoverCompatibleProjectSkills')}
                />
              }
            />
          </>
        )}
      </SettingsSection>
    </div>
  );
}
