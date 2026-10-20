import { lucFetch } from '../../api';

export interface NormalizedUsage {
  input?: {
    totalTokens?: number | null;
    uncachedTokens?: number | null;
  };
  output?: {
    totalTokens?: number | null;
    reasoningTokens?: number | null;
  };
  cache?: {
    readTokens?: number | null;
    writeTokens?: number | null;
    missTokens?: number | null;
    hit?: boolean | null;
    created?: boolean | null;
    hitRatio?: number | null;
    support?: string | null;
  };
  totalTokens?: number | null;
  costTotal?: number | null;
}

export interface UsageLedgerEntry {
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: {
    subsystem?: string;
    operation?: string;
    surface?: string;
    trigger?: string;
    actor?: Record<string, unknown>;
    parent?: Record<string, unknown>;
  };
  attribution: {
    kind?: string;
    agentId?: string | null;
    sessionPath?: string | null;
    conversationId?: string | null;
    conversationType?: string | null;
    childAgentId?: string | null;
    childSessionPath?: string | null;
    taskId?: string | null;
  };
  model: {
    provider?: string | null;
    modelId?: string | null;
    api?: string | null;
  };
  usage: NormalizedUsage | null;
  error: {
    name?: string | null;
    message?: string | null;
  } | null;
}

export interface LoadLlmUsageEntriesOptions {
  limit?: number | null;
  since?: string | null;
  until?: string | null;
}

export async function loadLlmUsageEntries(options: number | LoadLlmUsageEntriesOptions = 500): Promise<UsageLedgerEntry[]> {
  const params = usageQueryParams(options);
  const query = params.toString();
  const res = await lucFetch(`/api/usage/llm${query ? `?${query}` : ''}`);
  const data: unknown = await res.json();
  if (!isUsageResponse(data)) return [];
  return data.entries;
}

function usageQueryParams(options: number | LoadLlmUsageEntriesOptions) {
  const params = new URLSearchParams();
  if (typeof options === 'number') {
    params.set('limit', String(normalizeLimit(options)));
    return params;
  }

  const since = cleanDateParam(options?.since);
  const until = cleanDateParam(options?.until);
  if (since) params.set('since', since);
  if (until) params.set('until', until);

  if (options?.limit !== undefined && options.limit !== null) {
    params.set('limit', String(normalizeLimit(options.limit)));
  } else if (!since && !until) {
    params.set('limit', '500');
  }

  return params;
}

function normalizeLimit(limit: number) {
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 2000) : 500;
}

function cleanDateParam(value: string | null | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isUsageResponse(value: unknown): value is { entries: UsageLedgerEntry[] } {
  if (!value || typeof value !== 'object') return false;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries);
}
