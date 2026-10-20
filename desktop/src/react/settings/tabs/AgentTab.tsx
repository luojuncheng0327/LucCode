import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '../store';
import { lucFetch } from '../api';
import { t, autoSaveConfig } from '../helpers';
import { SelectWidget, Toggle, ProviderIcon, ProviderGroupHeader, selectWidgetStyles } from '@/ui';
import { browseAgent, setPrimaryAgent, loadSettingsConfig, loadAgents } from '../actions';
import { AgentCardStack } from './agent/AgentCardStack';
import { YuanSelector } from './agent/YuanSelector';
import { MemorySection } from './agent/AgentMemory';
import { AgentToolsSection } from './agent/AgentToolsSection';
import { CharacterCardPreviewOverlay, type CharacterCardPlan } from '../overlays/CharacterCardPreviewOverlay';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { readConfigBoolean } from '../resource-state';
import styles from '../Settings.module.css';
import {
  type ExpCategory, parseExperience,
  ExperienceBlock, putExperience,
} from './agent/AgentExperience';

export function AgentTab() {
  const {
    agents, currentAgentId, settingsAgentId, settingsConfig, currentPins,
    globalModelsConfig,
  } = useSettingsStore(
    useShallow(s => ({
      agents: s.agents,
      currentAgentId: s.currentAgentId,
      settingsAgentId: s.settingsAgentId,
      settingsConfig: s.settingsConfig,
      currentPins: s.currentPins,
      globalModelsConfig: s.globalModelsConfig,
    }))
  );
  const showToast = useSettingsStore(s => s.showToast);
  const set = useSettingsStore(s => s.set);
  const getSettingsAgentId = useSettingsStore(s => s.getSettingsAgentId);

  const hasUtilityModel = globalModelsConfig
    ? !!(globalModelsConfig.models?.utility && globalModelsConfig.models?.utility_large)
    : undefined;
  const selectedSettingsAgentId = settingsAgentId || currentAgentId;

  const [agentName, setAgentName] = useState('');
  const [identity, setIdentity] = useState('');
  const [agentsMd, setAgentsMd] = useState('');
  const [expCategories, setExpCategories] = useState<ExpCategory[]>([]);
  const [exportPlanningAgentId, setExportPlanningAgentId] = useState<string | null>(null);
  const [exportingCharacterCard, setExportingCharacterCard] = useState(false);
  const [exportPlan, setExportPlan] = useState<CharacterCardPlan | null>(null);
  const [exportMemory, setExportMemory] = useState(false);

  useEffect(() => {
    if (settingsConfig) {
      setAgentName(settingsConfig.agent?.name || '');
      setIdentity(settingsConfig._identity || '');
      setAgentsMd(settingsConfig._agents || '');
      setExpCategories(parseExperience(settingsConfig._experience || ''));
    }
  }, [settingsConfig]);

  const currentYuan = settingsConfig?.agent?.yuan || 'luc';

  // 用 "provider/id" 复合键作为 SelectWidget 的 value，区分多 provider 下同名模型。
  // 展示层可仍用 id/name；value/onChange payload 必须带 provider。
  const chatRaw = settingsConfig?.models?.chat;
  const currentModel = (() => {
    if (!chatRaw) return '';
    if (typeof chatRaw === 'object' && chatRaw?.id && chatRaw?.provider) {
      return `${chatRaw.provider}/${chatRaw.id}`;
    }
    // 半成品对象或裸字符串：migration #5 之后不应出现，这里仅作渡期兜底展示
    if (typeof chatRaw === 'object' && chatRaw?.id) return chatRaw.id;
    if (typeof chatRaw === 'string') return chatRaw;
    return '';
  })();

  // 从唯一信源 /api/models 获取模型列表（和聊天页一致）
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; provider: string }>>([]);
  useEffect(() => {
    lucFetch('/api/models').then(r => r.json()).then(data => {
      setAvailableModels(data.models || []);
    }).catch(() => {});
  }, [settingsConfig]); // settingsConfig 变化时刷新

  const modelOptions = useMemo(() => {
    const opts = availableModels.map(m => ({
      value: `${m.provider}/${m.id}`,
      label: m.name || m.id,
      group: m.provider,
    }));
    if (currentModel && !opts.some(o => o.value === currentModel)) {
      opts.unshift({ value: currentModel, label: t('settings.agent.modelUnavailable', { model: currentModel }), group: '' });
    }
    return opts;
  }, [availableModels, currentModel]);
  const currentModelUnavailable = !!currentModel && !availableModels.some(m => `${m.provider}/${m.id}` === currentModel);

  const memoryEnabled = readConfigBoolean(settingsConfig, cfg => cfg.memory?.enabled, true);
  const autoDreamEnabled = readConfigBoolean(settingsConfig, cfg => cfg.memory?.dream?.auto_enabled, false);
  const experienceEnabled = readConfigBoolean(settingsConfig, cfg => cfg.experience?.enabled, false);
  const hasAvailableToolsField = !!settingsConfig && Object.prototype.hasOwnProperty.call(settingsConfig, 'availableTools');
  const availableTools = hasAvailableToolsField ? settingsConfig?.availableTools : undefined;

  const saveAgentName = async () => {
    try {
      const agentId = getSettingsAgentId()!;
      const currentName = settingsConfig?.agent?.name || '';

      if (!agentName || agentName === currentName) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const res = await lucFetch(`/api/agents/${agentId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: { name: agentName } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      showToast(t('settings.saved'), 'success');
      if (agentId === currentAgentId) {
        set({ agentName });
      }
      await loadSettingsConfig();
      await loadAgents();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const saveAgent = async () => {
    try {
      const agentId = getSettingsAgentId()!;
      const identityChanged = identity !== (settingsConfig?._identity || '');
      const agentsMdChanged = agentsMd !== (settingsConfig?._agents || '');

      if (!identityChanged && !agentsMdChanged) {
        showToast(t('settings.noChanges'), 'success');
        return;
      }

      const agentBase = `/api/agents/${agentId}`;
      const requests: Promise<Response>[] = [];
      if (identityChanged) {
        requests.push(lucFetch(`${agentBase}/identity`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: identity }),
        }));
      }
      if (agentsMdChanged) {
        requests.push(lucFetch(`${agentBase}/agents-md`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: agentsMd }),
        }));
      }

      const results = await Promise.all(requests);
      for (const res of results) {
        const data = await res.json();
        if (data.error) throw new Error(data.error);
      }

      showToast(t('settings.saved'), 'success');
      await loadSettingsConfig();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  const openAgentExportPreview = async (agentId: string) => {
    if (exportPlanningAgentId || exportingCharacterCard) return;
    setExportPlanningAgentId(agentId);
    try {
      const res = await lucFetch('/api/character-cards/export/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
        timeout: 90_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExportPlan(data.plan);
      setExportMemory(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      setExportPlanningAgentId(null);
    }
  };

  const confirmAgentExport = async () => {
    if (!exportPlan?.agentId || exportingCharacterCard) return;
    setExportingCharacterCard(true);
    try {
      const res = await lucFetch('/api/character-cards/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: exportPlan.agentId,
          exportMemory: exportMemory && exportPlan.memory.available,
        }),
        timeout: 90_000,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExportPlan(null);
      setExportMemory(false);
      if (typeof data.filePath === 'string' && data.filePath) {
        window.platform?.showInFinder?.(data.filePath);
      }
      showToast(t('settings.agent.exportedTo', { path: data.filePath }), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      setExportingCharacterCard(false);
    }
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="agent">
      {/* Agent 卡片堆叠 */}
      <SettingsSection title={t('settings.agent.title')} surface="plain">
        <AgentCardStack
          agents={agents}
          selectedId={selectedSettingsAgentId}
          currentAgentId={currentAgentId}
          onSelect={(id) => browseAgent(id)}
          onAvatarClick={() => {
            // eslint-disable-next-line no-restricted-syntax -- ephemeral file picker, not part of React tree
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp';
            input.addEventListener('change', () => {
              if (input.files?.[0]) {
                window.dispatchEvent(new CustomEvent('luc-open-cropper', {
                  detail: { role: 'agent', file: input.files[0] },
                }));
              }
            });
            input.click();
          }}
          onSetPrimary={(id) => setPrimaryAgent(id)}
          onDelete={(id) => window.dispatchEvent(new CustomEvent('luc-show-agent-delete', {
            detail: { agentId: id },
          }))}
          onExport={openAgentExportPreview}
          onAdd={() => window.dispatchEvent(new Event('luc-show-agent-create'))}
          exportingAgentId={exportPlanningAgentId}
        />

        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-center']}`}>
          <input
            className={styles['agent-name-input']}
            type="text"
            value={agentName}
            placeholder={t('settings.agent.agentNameHint')}
            onChange={(e) => setAgentName(e.target.value)}
            onKeyDown={(e) => {
              // 回车保存名称（等同下方「保存」按钮）；排除中文输入法组合态，
              // 否则用拼音输入时按回车确认候选词会误触发保存（#1306）。
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void saveAgentName();
              }
            }}
          />
        </div>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-center']}`}>
          <div className={styles['model-capsule']}>
            <span className={styles['model-capsule-label']}>{t('settings.agent.chatModel')}</span>
            <SelectWidget
              className={styles['model-capsule-select']}
              triggerBare
              triggerClassName={styles['model-capsule-trigger']}
              options={modelOptions}
              value={currentModel}
              onChange={async (refKey) => {
                // refKey 是 SelectWidget 传回的 value，格式 "provider/id"
                const slashIdx = refKey.indexOf('/');
                if (slashIdx <= 0 || slashIdx === refKey.length - 1) {
                  // 兜底：没有 / 的字符串是残留的老数据，此路径不应触发
                  console.warn('[AgentTab] 模型 value 缺少 provider 前缀，已忽略', refKey);
                  return;
                }
                const provider = refKey.slice(0, slashIdx);
                const id = refKey.slice(slashIdx + 1);
                await autoSaveConfig({ models: { chat: { id, provider } } });
              }}
              placeholder={t('settings.api.selectModel')}
              renderTrigger={(option) => {
                const slashIdx = currentModel.indexOf('/');
                const provider = option?.group || (slashIdx > 0 ? currentModel.slice(0, slashIdx) : '');
                return (
                  <>
                    {provider && (
                      <ProviderIcon provider={provider} className={styles['model-capsule-provider-icon']} />
                    )}
                    <span className={styles['model-capsule-value']}>
                      {option?.label || t('settings.api.selectModel')}
                    </span>
                    <svg
                      className={styles['model-capsule-arrow']}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </>
                );
              }}
              renderGroupHeader={(g) => <ProviderGroupHeader provider={g} />}
              popupClassName={selectWidgetStyles.providerInset}
            />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.agent.chatModelHint')}</span>
          {currentModelUnavailable && (
            <span className={styles['settings-form-hint']}>{t('settings.agent.modelUnavailableHint')}</span>
          )}
          <button className={styles['agent-name-save-btn']} onClick={saveAgentName}>
            {t('settings.save')}
          </button>
        </div>
        {/* 图片模型选择器暂时隐藏，后续重新设计 */}
      </SettingsSection>

      {/* 关于 Ta 的内容保持原样，外层归入标准 Section。 */}
      <SettingsSection title={t('settings.about.title')} surface="plain">
        <div className={`${styles['settings-form-field']} ${styles['settings-form-field-center']}`}>
          <span className={styles['settings-form-hint']}>{t('settings.agent.yuanHint')}</span>
          <YuanSelector
            currentYuan={currentYuan}
            onChange={async (key) => {
              const agentId = getSettingsAgentId()!;
              try {
                await lucFetch(`/api/agents/${agentId}/config`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ agent: { yuan: key } }),
                });
                if (agentId === currentAgentId) set({ agentYuan: key });
                await loadSettingsConfig();
                await loadAgents();
              } catch (err) {
                console.error('[yuan] switch failed:', err);
              }
            }}
          />
        </div>
        <div className={styles['settings-form-field']}>
          <label className={styles['settings-form-label']}>{t('settings.agent.identity')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={3}
            spellCheck={false}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
          />
          <span className={styles['settings-form-hint']}>{t('settings.agent.identityHint')}</span>
        </div>
        <div className={styles['settings-form-field']}>
          <label className={styles['settings-form-label']}>{t('settings.agent.agentsMd')}</label>
          <textarea
            className={styles['settings-textarea']}
            rows={10}
            spellCheck={false}
            value={agentsMd}
            onChange={(e) => setAgentsMd(e.target.value)}
          />
          <span className={styles['settings-form-hint']}>{t('settings.agent.agentsMdHint')}</span>
        </div>
        <div className={`${styles['settings-form-field']} ${styles['settings-form-actions-center']}`}>
          <button className={styles['settings-save-btn-sm']} onClick={saveAgent}>
            {t('settings.save')}
          </button>
        </div>
      </SettingsSection>

      {/* 以下是本 phase 需要改造的部分：Memory / Experience / Tools */}

      <MemorySection
        agentId={selectedSettingsAgentId}
        hasUtilityModel={hasUtilityModel}
        memoryEnabled={memoryEnabled}
        autoDreamEnabled={autoDreamEnabled === true}
        currentPins={currentPins}
      />

      {/* 经验 */}
      <SettingsSection title={t('settings.experience.title')}>
        <SettingsRow
          label={t('settings.experience.toggleLabel')}
          hint={t('settings.experience.toggleHint')}
          control={<Toggle
            on={experienceEnabled}
            onChange={async (on) => {
              const saved = await autoSaveConfig({ experience: { enabled: on } }, { silent: true });
              if (saved) await loadSettingsConfig();
            }}
          />}
        />
        <div className={styles['settings-section-inset']}>
          {experienceEnabled === undefined ? null : experienceEnabled === false ? (
            <div className={styles['exp-empty']}>{t('settings.experience.paused')}</div>
          ) : expCategories.length === 0 ? (
            <div className={styles['exp-empty']}>{t('settings.experience.empty')}</div>
          ) : (
            <div className={styles['exp-list']}>
              {expCategories.map((cat) => (
                <ExperienceBlock
                  key={cat.name}
                  category={cat}
                  onSave={(updated) => {
                    const next = expCategories.map(c => c.name === cat.name ? updated : c);
                    setExpCategories(next);
                    putExperience({ getSettingsAgentId, showToast }, next);
                  }}
                  onDelete={() => {
                    const next = expCategories.filter(c => c.name !== cat.name);
                    setExpCategories(next);
                    putExperience({ getSettingsAgentId, showToast }, next);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* 默认关闭 dm / workflow，与后端 DEFAULT_DISABLED_TOOL_NAMES 保持同步 */}
      <AgentToolsSection
        availableTools={availableTools}
        disabled={settingsConfig ? settingsConfig.tools?.disabled ?? ["workflow"] : undefined}
      />

      {exportPlanningAgentId && createPortal((
        <div className={styles['character-card-preview-overlay']} role="dialog" aria-modal="true">
          <div className={styles['character-card-loading-card']}>{t('settings.agent.generatingCardPreview')}</div>
        </div>
      ), document.body)}
      {exportPlan && (
        <CharacterCardPreviewOverlay
          plan={exportPlan}
          mode="export"
          memoryChecked={exportMemory}
          processing={exportingCharacterCard}
          onMemoryChange={(checked) => {
            if (exportPlan.memory.available) setExportMemory(checked);
          }}
          onConfirm={confirmAgentExport}
          onCancel={() => {
            setExportPlan(null);
            setExportMemory(false);
          }}
        />
      )}

    </div>
  );
}
