import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { lucFetch } from '../../hooks/use-luc-fetch';
import { useI18n } from '../../hooks/use-i18n';
import type { Model } from '../../types';
import type { SessionModel } from '../../stores/chat-types';
import { SelectWidget, ProviderIcon, ProviderGroupHeader, selectWidgetStyles, type SelectOption } from '@/ui';
import styles from './InputArea.module.css';

export function ModelSelector({ models, sessionModel, isStreaming = false }: {
  models: Model[];
  sessionModel?: SessionModel;
  isStreaming?: boolean;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);

  const matchedSessionModel = sessionModel
    ? models.find(m => m.id === sessionModel.id && m.provider === sessionModel.provider)
    : undefined;
  const current = sessionModel
    ? (matchedSessionModel ? { ...matchedSessionModel, ...sessionModel } : sessionModel)
    : models.find(m => m.isCurrent);
  const inferredUnavailable = !!(
    sessionModel?.id
    && sessionModel.provider
    && models.length > 0
    && !matchedSessionModel
  );
  const sessionModelUnavailable = sessionModel?.available === false || inferredUnavailable;
  const label = (() => {
    if (loading) return '...';
    if (sessionModelUnavailable) {
      if (sessionModel?.unavailableReason === 'model_removed') return t('model.removed') || '...';
      if (sessionModel?.unavailableReason === 'provider_not_configured') {
        return t('model.providerNotConfigured') || '...';
      }
      return t('model.unavailable') || '...';
    }
    if (current?.name) return current.name;
    if (models.length > 0) return t('model.notSelected') || t('model.unknown') || '...';
    return t('model.noneConfigured') || t('model.unknown') || '...';
  })();

  const switchModel = useCallback(async (modelId: string, provider?: string) => {
    try {
      const state = useStore.getState();
      const { currentSessionPath, pendingNewSession, chatSessions, sessionModelsByPath } = state;
      const sessionHasMessages = !!(currentSessionPath && sessionScopedValue(state, chatSessions, currentSessionPath)?.items?.length);

      if (sessionHasMessages && currentSessionPath) {
        // Same-model guard：严格复合键比较。sm 缺 provider 时视为不可比，走 global 当前。
        const sm = sessionScopedValue(state, sessionModelsByPath, currentSessionPath);
        const useSession = !!(sm?.id && sm?.provider);
        const cur = useSession ? sm : models.find(m => m.isCurrent);
        // A blocked historical model must be explicitly re-selected after its
        // provider/model becomes usable again. Do not let the same-model guard
        // turn that recovery action into a no-op.
        if (cur && modelId === cur.id && provider === cur.provider && sm?.available !== false) return;

        // Per-session switch
        setLoading(true);
        useStore.getState().setModelSwitching(true);
        const res = await lucFetch('/api/models/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionPath: currentSessionPath, modelId, provider }),
          throwOnHttpError: false,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'switch failed');

        if (data.model) {
          useStore.getState().updateSessionModel(currentSessionPath, {
            ...data.model,
            available: true,
            unavailableReason: null,
          });
        }
        if (data.thinkingLevel) {
          useStore.getState().setThinkingLevel(data.thinkingLevel);
        }

        if (data.adaptations?.length) {
          const msgs: Record<string, string> = {
            compacted: t('model.adaptation.compacted'),
            truncated: t('model.adaptation.truncated'),
          };
          const text = data.adaptations.map((a: string) => msgs[a] || a).join('；');
          useStore.getState().addToast(text, 'info');
        }

        setLoading(false);
        useStore.getState().setModelSwitching(false);
      } else {
        // New session path: persist the model selection and mirror its thinking default into the draft.
        const setRes = await lucFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, provider }),
        });
        const setData = await setRes.json().catch(() => ({}));
        if (setData.thinkingLevel) {
          useStore.getState().setThinkingLevel(setData.thinkingLevel);
          useStore.getState().setPendingNewSessionThinkingLevel(setData.thinkingLevel);
        }
        if (currentSessionPath && !pendingNewSession) {
          const { createNewSession } = await import('../../stores/session-actions');
          await createNewSession();
        }
        const res = await lucFetch('/api/models');
        const data = await res.json();
        useStore.setState({ models: data.models || [] });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('cannot switch model while streaming')) {
        useStore.getState().addToast(t('model.switchWhileStreaming'), 'warning', 4000, {
          dedupeKey: 'model-switch-streaming',
        });
      } else {
        console.error('[model] switch failed:', err);
        useStore.getState().addToast(message || t('model.switchFailed'), 'error');
      }
      setLoading(false);
      useStore.getState().setModelSwitching(false);
    }
  }, [models, t]);

  // 按 provider 分组
  const grouped = useMemo(() => {
    const groups: Record<string, typeof models> = {};
    for (const m of models) {
      const key = m.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    // 只补入仍可用的当前模型；失效模型只作为状态展示，不塞回可选列表。
    const currentCanBeSelected = !sessionModel || !!matchedSessionModel;
    if (current && currentCanBeSelected && !sessionModelUnavailable && !models.find(m => m.id === current.id && m.provider === current.provider)) {
      const key = current.provider || '';
      if (!groups[key]) groups[key] = [];
      groups[key].unshift(current as typeof models[0]);
    }
    return groups;
  }, [models, current, sessionModel, matchedSessionModel, sessionModelUnavailable]);

  const groupKeys = Object.keys(grouped);
  const hasMultipleProviders = groupKeys.length > 1 || (groupKeys.length === 1 && groupKeys[0] !== '');

  const valueOf = (m: { id: string; provider?: string }) => `${m.provider || ''}/${m.id}`;

  const options: SelectOption[] = useMemo(() => {
    return groupKeys.flatMap(provider =>
      grouped[provider].map(m => ({
        value: valueOf(m),
        label: m.name,
        group: hasMultipleProviders ? (provider || '—') : undefined,
      })),
    );
  }, [grouped, groupKeys, hasMultipleProviders]);

  // Keep the unavailable historical identity visible in the trigger, but leave
  // the select value empty so choosing the same provider/id is a real action.
  const currentValue = current && !sessionModelUnavailable ? valueOf(current) : '';

  const handleSelect = useCallback((val: string) => {
    const all = groupKeys.flatMap(p => grouped[p]);
    const m = all.find(mm => valueOf(mm) === val);
    if (m) switchModel(m.id, m.provider);
  }, [grouped, groupKeys, switchModel]);

  return (
    <SelectWidget
      className={styles['model-selector']}
      options={options}
      value={currentValue}
      onChange={handleSelect}
      disabled={loading}
      placement="top"
      align="end"
      offset={4}
      popupMinWidth={180}
      popupClassName={selectWidgetStyles.providerInset}
      triggerBare
      onAttemptOpen={() => {
        if (isStreaming) {
          useStore.getState().addToast(t('model.switchWhileStreaming'), 'warning', 4000, {
            dedupeKey: 'model-switch-streaming',
          });
          return false;
        }
        return true;
      }}
      triggerClassName={`${styles['model-pill']}${loading ? ` ${styles['model-pill-disabled']}` : ''}`}
      renderTrigger={() => (
        <>
          {current?.provider && (
            <ProviderIcon provider={current.provider} className={styles['model-provider-icon']} />
          )}
          <span className={styles['model-pill-label']}>{label}</span>
        </>
      )}
      renderGroupHeader={(g) => <ProviderGroupHeader provider={g} />}
    />
  );
}
