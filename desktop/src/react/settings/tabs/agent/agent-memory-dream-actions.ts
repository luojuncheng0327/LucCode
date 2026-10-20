import { lucFetch } from '../../api';
import { refreshSettingsConfigSnapshot } from '../../helpers';
import { errorWithCode } from '../../../errors/error-presenter';
import { normalizeSessionRouteError } from '../../../../../../shared/error-user-messages.ts';

export type DreamRunReport = {
  runId: string;
  status: 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string;
  beforeChars: number;
  afterChars: number;
  mergedCount: number;
  forgottenCount: number;
  reviewedCount: number;
  model: string;
  revisionId: string | null;
  changed?: boolean;
  changedSections?: Array<'facts' | 'longterm'>;
  appliedOperationCount?: number;
  error?: string;
  errorCode?: string;
};

export type DreamStatus = {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  runId: string | null;
  startedAt: string | null;
  lastRun: DreamRunReport | null;
};

export type DreamRevisionSummary = {
  schemaVersion: 1;
  revisionId: string;
  runId: string;
  trigger: 'manual' | 'automatic';
  createdAt: string;
  kind: 'dream' | 'pre_restore';
  restoresRevisionId: string | null;
  bodyChars: number;
  sectionChars: {
    facts: number;
    today: number;
    week: number;
    longterm: number;
  };
};

export type DreamRevisionDetail = Omit<DreamRevisionSummary, 'bodyChars' | 'sectionChars'> & {
  before: {
    facts: string;
    today: string;
    weekDays: Array<{ date: string; body: string }>;
    longterm: string;
  };
};

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data?.error) {
    const routeError = normalizeSessionRouteError(data);
    throw errorWithCode(routeError.message || `HTTP ${response.status}`, routeError.code);
  }
  return data as T;
}

export async function loadDreamStatus(agentId: string, signal?: AbortSignal) {
  const response = await lucFetch(
    `/api/memories/dream/status?agentId=${encodeURIComponent(agentId)}`,
    { signal, timeout: 10_000 },
  );
  return responseJson<DreamStatus>(response);
}

export async function startDream(agentId: string) {
  const response = await lucFetch(
    `/api/memories/dream/runs?agentId=${encodeURIComponent(agentId)}`,
    { method: 'POST', timeout: 10_000 },
  );
  return responseJson<DreamStatus>(response);
}

export async function loadDreamRevisions(agentId: string, signal?: AbortSignal) {
  const response = await lucFetch(
    `/api/memories/dream/revisions?agentId=${encodeURIComponent(agentId)}`,
    { signal, timeout: 10_000 },
  );
  const data = await responseJson<{ revisions: DreamRevisionSummary[] }>(response);
  return data.revisions;
}

export async function loadDreamRevision(agentId: string, revisionId: string, signal?: AbortSignal) {
  const response = await lucFetch(
    `/api/memories/dream/revisions/${encodeURIComponent(revisionId)}?agentId=${encodeURIComponent(agentId)}`,
    { signal, timeout: 10_000 },
  );
  const data = await responseJson<{ revision: DreamRevisionDetail }>(response);
  return data.revision;
}

export async function restoreDream(agentId: string, revisionId: string) {
  const response = await lucFetch(
    `/api/memories/dream/revisions/${encodeURIComponent(revisionId)}/restore?agentId=${encodeURIComponent(agentId)}`,
    { method: 'POST', timeout: 30_000 },
  );
  return responseJson<{ ok: true }>(response);
}

export async function saveDreamAutoEnabled(agentId: string, enabled: boolean) {
  const response = await lucFetch(`/api/agents/${encodeURIComponent(agentId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memory: { dream: { auto_enabled: enabled } } }),
  });
  await responseJson<{ ok: true }>(response);
  await refreshSettingsConfigSnapshot();
}
