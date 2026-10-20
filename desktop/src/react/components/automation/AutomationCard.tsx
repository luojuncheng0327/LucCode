import { useEffect, useMemo, useState } from 'react';
import {
  Collapse,
  ProviderGroupHeader,
  SelectWidget,
  selectWidgetStyles,
  type SelectOption,
} from '@/ui';
import { useStore } from '../../stores';
import { resolveAgentDisplayInfo } from '../../utils/agent-display';
import type { CronJob, ModelOption } from './automation-types';
import {
  automationExecutorLabel,
  jobAgentId,
  modelOptionsForJob,
  modelSelectValue,
  modelValueFromSelect,
} from './automation-utils';
import { ScheduleEditor } from './ScheduleEditor';
import {
  intervalMinutesForApi,
  scheduleDraftFromStored,
  schedulePreviewFromDraft,
  storedScheduleFromDraft,
  type ScheduleDraft,
} from './schedule-draft';
import styles from './AutomationPanel.module.css';

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function jobTitle(job: CronJob) {
  return job.label || job.prompt?.slice(0, 40) || job.id;
}

export function AutomationCard({
  job,
  availableModels,
  open,
  onToggleOpen,
  onToggleEnabled,
  onRemove,
  onUpdate,
}: {
  job: CronJob;
  availableModels: ModelOption[];
  open: boolean;
  onToggleOpen: () => void;
  onToggleEnabled: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => Promise<void> | void;
}) {
  const t = window.t ?? ((p: string) => p);
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const fallbackAgentName = useStore(s => s.agentName) || 'Luc';
  const fallbackAgentYuan = useStore(s => s.agentYuan) || 'luc';
  const addToast = useStore(s => s.addToast);
  const [label, setLabel] = useState(jobTitle(job));
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => scheduleDraftFromStored(job.type, job.schedule));
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [prompt, setPrompt] = useState(job.prompt || '');
  const [model, setModel] = useState(modelSelectValue(job.model));
  const isAgentSession = !job.executor || job.executor.kind === 'agent_session';
  const executorLabel = automationExecutorLabel(job);
  const modelOptions = useMemo(() => modelOptionsForJob(job, availableModels), [availableModels, job]);
  const agentInfo = resolveAgentDisplayInfo({
    id: jobAgentId(job, currentAgentId),
    agents,
    fallbackAgentName,
    fallbackAgentYuan,
  });

  useEffect(() => {
    setLabel(jobTitle(job));
    setScheduleDraft(scheduleDraftFromStored(job.type, job.schedule));
    setScheduleDirty(false);
    setPrompt(job.prompt || '');
    setModel(modelSelectValue(job.model));
  }, [job]);

  const dirty =
    label !== jobTitle(job)
    || scheduleDirty
    || prompt !== (job.prompt || '')
    || model !== modelSelectValue(job.model);

  const updateScheduleDraft = (draft: ScheduleDraft) => {
    setScheduleDraft(draft);
    setScheduleDirty(true);
  };

  const updateFields = () => {
    const fields: Record<string, unknown> = {};
    if (label !== jobTitle(job)) fields.label = label;
    if (scheduleDirty) {
      const nextSchedule = storedScheduleFromDraft(scheduleDraft);
      fields.type = nextSchedule.type;
      fields.schedule = nextSchedule.type === 'every'
        ? intervalMinutesForApi(scheduleDraft) || nextSchedule.schedule
        : nextSchedule.schedule;
    }
    if (prompt !== (job.prompt || '')) fields.prompt = prompt;
    if (model !== modelSelectValue(job.model)) fields.model = modelValueFromSelect(model);
    return fields;
  };

  const save = async () => {
    const fields = updateFields();
    if (Object.keys(fields).length) await onUpdate(job.id, fields);
  };

  const toggleEnabled = async () => {
    if (job.enabled) {
      onToggleEnabled(job.id);
      return;
    }
    if (isAgentSession && !prompt.trim()) {
      addToast(t('automation.promptRequired'), 'error');
      return;
    }
    await onUpdate(job.id, { ...updateFields(), enabled: true });
  };

  return (
    <div className={styles.card}>
      <button type="button" className={styles.row} onClick={onToggleOpen} aria-expanded={open}>
        <span
          className={`luc-toggle${job.enabled ? ' on' : ''}`}
          title={job.enabled ? t('automation.disable') : t('automation.enable')}
          onClick={(e) => {
            e.stopPropagation();
            void toggleEnabled();
          }}
        />
        <span className={styles.rowMain}>
          <span className={styles.title} title={jobTitle(job)}>{jobTitle(job)}</span>
          <span className={styles.subline}>
            <span className={styles.meta}>{schedulePreviewFromDraft(scheduleDraftFromStored(job.type, job.schedule))}</span>
            {job.nextRunAt ? <span className={styles.meta}>{new Date(job.nextRunAt).toLocaleString(undefined, { hour12: false })}</span> : null}
            <span className={styles.badge}>{executorLabel}</span>
          </span>
        </span>
        <span className={styles.meta}>{job.enabled ? t('common.on') : t('common.off')}</span>
        <Chevron open={open} />
      </button>
      <Collapse open={open}>
        <div className={styles.details}>
          <div className={styles.fieldGrid}>
            <label className={styles.field}>
              <span>{t('automation.field.label')}</span>
              <input value={label} onChange={e => setLabel(e.target.value)} spellCheck={false} />
            </label>
          </div>
          <ScheduleEditor draft={scheduleDraft} onChange={updateScheduleDraft} />
          {isAgentSession ? (
            <label className={styles.field}>
              <span>{t('automation.field.prompt')}</span>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={t('automation.promptPlaceholder', { agent: agentInfo.displayName })}
                spellCheck={false}
              />
            </label>
          ) : null}
          {isAgentSession && availableModels.length > 0 ? (
            <label className={styles.field}>
              <span>{t('rightWorkspace.session.model')}</span>
              <SelectWidget
                options={[
                  { value: '', label: t('automation.defaultModel') } as SelectOption,
                  ...modelOptions.map((option): SelectOption => ({
                    value: `${option.provider}/${option.id}`,
                    label: option.name || option.id,
                    group: option.provider,
                  })),
                ]}
                value={model}
                onChange={setModel}
                renderGroupHeader={provider => <ProviderGroupHeader provider={provider} />}
                popupClassName={selectWidgetStyles.providerInset}
              />
            </label>
          ) : null}
          <div className={styles.actions}>
            <button className={styles.textButton} type="button" disabled={!dirty} onClick={save}>{t('common.confirm')}</button>
            <button className={`${styles.textButton} ${styles.dangerButton}`} type="button" onClick={() => onRemove(job.id)}>{t('automation.delete')}</button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
