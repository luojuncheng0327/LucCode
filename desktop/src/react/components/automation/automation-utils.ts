import type { CronJob, ModelOption, ModelRef } from './automation-types';

export function parseCronJobModel(model?: CronJob['model']): { id: string; provider?: string } | null {
  if (!model) return null;
  if (typeof model === 'object') {
    const id = String((model as { id?: string }).id || '').trim();
    const provider = String((model as { provider?: string }).provider || '').trim();
    if (!id) return null;
    return provider ? { id, provider } : { id };
  }
  const value = model.trim();
  if (!value) return null;
  const slashIdx = value.indexOf('/');
  if (slashIdx > 0 && slashIdx < value.length - 1) {
    return { provider: value.slice(0, slashIdx), id: value.slice(slashIdx + 1) };
  }
  return { id: value };
}

export function modelSelectValue(model?: CronJob['model']): string {
  const ref = parseCronJobModel(model);
  if (!ref?.id) return '';
  return ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
}

export function modelValueFromSelect(value: string): '' | ModelRef {
  if (!value) return '';
  const slashIdx = value.indexOf('/');
  if (slashIdx > 0 && slashIdx < value.length - 1) {
    return { provider: value.slice(0, slashIdx), id: value.slice(slashIdx + 1) };
  }
  return { id: value };
}

export function modelOptionsForJob(job: CronJob, availableModels: ModelOption[]): ModelOption[] {
  const ref = parseCronJobModel(job.model);
  const opts: ModelOption[] = [];
  const seen = new Set(availableModels.map(m => `${m.provider}/${m.id}`));
  if (ref?.provider && !seen.has(`${ref.provider}/${ref.id}`)) {
    opts.push({ id: ref.id, provider: ref.provider });
  }
  opts.push(...availableModels);
  return opts;
}

export function scheduleInputFromJob(job: CronJob): string {
  if (job.type === 'every') {
    const ms = typeof job.schedule === 'number' ? job.schedule : parseInt(String(job.schedule), 10);
    if (Number.isFinite(ms) && ms > 0) return String(Math.max(1, Math.round(ms / 60_000)));
  }
  return String(job.schedule || '');
}

export function scheduleValueForJob(job: CronJob, input: string): string | number {
  if (job.type === 'every') {
    const minutes = parseInt(input, 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : input;
  }
  return input;
}

export function automationExecutorLabel(job: CronJob): string {
  const t = window.t ?? ((p: string) => p);
  if (job.executor?.kind === 'plugin_action') return t('automation.executor.pluginAction');
  if (job.executor?.kind === 'direct_action') return t('automation.executor.directAction');
  return t('automation.executor.agentSession');
}

export function jobAgentId(job: CronJob, fallbackAgentId: string | null): string | null {
  if (typeof job.actorAgentId === 'string' && job.actorAgentId.trim()) return job.actorAgentId;
  if (typeof job.executor?.agentId === 'string' && job.executor.agentId.trim()) return job.executor.agentId;
  return fallbackAgentId;
}
