import type { UsageLedgerEntry } from './usage-ledger-actions';

export type UsageView = 'overall' | 'daily' | 'category' | 'model';
export type UsagePeriod = 'week' | 'month';

export interface UsageAggregate {
  key: string;
  label: string;
  entries: UsageLedgerEntry[];
  requests: number;
  ok: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  nonCachedTokens: number;
  totalTokens: number;
  costTotal: number;
  cacheHitCount: number;
  cacheObservedCount: number;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const USAGE_VIEW_ORDER: UsageView[] = ['overall', 'daily', 'category', 'model'];
export const USAGE_PERIOD_ORDER: UsagePeriod[] = ['week', 'month'];

const USAGE_PERIOD_DAYS: Record<UsagePeriod, number> = {
  week: 7,
  month: 30,
};

export function aggregateEntries(key: string, label: string, entries: UsageLedgerEntry[]): UsageAggregate {
  const aggregate = entries.reduce<UsageAggregate>((acc, entry) => {
    const usage = entry.usage;
    acc.requests += 1;
    if (entry.status === 'ok') acc.ok += 1;
    if (entry.status === 'error' || entry.status === 'aborted') acc.errors += 1;
    acc.inputTokens += num(usage?.input?.totalTokens);
    acc.outputTokens += num(usage?.output?.totalTokens);
    acc.cacheReadTokens += num(usage?.cache?.readTokens);
    acc.cacheWriteTokens += num(usage?.cache?.writeTokens);
    acc.totalTokens += num(usage?.totalTokens);
    acc.costTotal += num(usage?.costTotal);
    if (usage?.cache?.hit !== null && usage?.cache?.hit !== undefined) {
      acc.cacheObservedCount += 1;
      if (usage.cache.hit) acc.cacheHitCount += 1;
    }
    return acc;
  }, emptyAggregate(key, label, entries));

  aggregate.nonCachedTokens = Math.max(0, aggregate.totalTokens - aggregate.cacheReadTokens);
  return aggregate;
}

export function groupEntries(
  entries: UsageLedgerEntry[],
  keyFn: (entry: UsageLedgerEntry) => string,
  labelFn: (entry: UsageLedgerEntry) => string,
): UsageAggregate[] {
  const groups = new Map<string, UsageLedgerEntry[]>();
  for (const entry of entries) {
    const key = keyFn(entry);
    const list = groups.get(key) || [];
    list.push(entry);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => aggregateEntries(key, labelFn(list[0]), list))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
}

export function groupDailyEntries(entries: UsageLedgerEntry[]): UsageAggregate[] {
  return groupEntries(entries, dateKey, (entry) => formatDateLabel(entry.endedAt || entry.startedAt))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function groupDateWindowEntries(entries: UsageLedgerEntry[], period: UsagePeriod): UsageAggregate[] {
  const latestTime = latestEntryTime(entries);
  if (latestTime === null) return groupDailyEntries(entries);

  const dayCount = USAGE_PERIOD_DAYS[period];
  const end = startOfLocalDay(new Date(latestTime));
  const start = addLocalDays(end, 1 - dayCount);
  const existingByKey = new Map(groupDailyEntries(entries).map(group => [group.key, group]));
  const groups: UsageAggregate[] = [];

  for (let index = 0; index < dayCount; index += 1) {
    const date = addLocalDays(start, index);
    const key = localDateKey(date);
    groups.push(existingByKey.get(key) ?? aggregateEntries(key, formatDateLabelFromDate(date), []));
  }

  return groups;
}

export function usagePeriodDateRange(period: UsagePeriod, now = new Date()) {
  const dayCount = USAGE_PERIOD_DAYS[period];
  const end = startOfLocalDay(now);
  const start = addLocalDays(end, 1 - dayCount);
  const until = addLocalDays(end, 1);
  return {
    since: start.toISOString(),
    until: until.toISOString(),
  };
}

export function categoryKey(entry: UsageLedgerEntry) {
  return entry.source?.subsystem || 'unknown';
}

export function categoryLabel(entry: UsageLedgerEntry, translate: Translate) {
  const key = categoryKey(entry);
  const label = translate(`settings.usage.category.${key}`);
  return typeof label === 'string' && label !== `settings.usage.category.${key}` ? label : key;
}

export function modelKey(entry: UsageLedgerEntry) {
  return `${entry.model?.provider || 'custom'}:${entry.model?.modelId || 'unknown'}`;
}

export function modelLabel(entry: UsageLedgerEntry) {
  const provider = entry.model?.provider || 'custom';
  const model = entry.model?.modelId || 'unknown';
  return `${provider} / ${model}`;
}

export function requestSourceLabel(entry: UsageLedgerEntry, translate: Translate) {
  const operation = entry.source?.operation || 'unknown';
  const actor = entry.source?.actor?.agentId;
  const category = categoryLabel(entry, translate);
  return actor ? `${category} · ${String(actor)} · ${operation}` : `${category} · ${operation}`;
}

export function hitRate(group: UsageAggregate) {
  return group.cacheObservedCount > 0 ? group.cacheHitCount / group.cacheObservedCount : null;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.round(value));
}

export function formatCompactNumber(value: number) {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded);
  if (abs >= 1_000_000) return `${trimUnitNumber(rounded / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimUnitNumber(rounded / 1_000)}K`;
  return formatNumber(rounded);
}

export function formatPercent(value: number | null) {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

export function formatCost(value: number) {
  return value > 0 ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : '-';
}

export function formatTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time));
}

export function num(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptyAggregate(key: string, label: string, entries: UsageLedgerEntry[]): UsageAggregate {
  return {
    key,
    label,
    entries,
    requests: 0,
    ok: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    nonCachedTokens: 0,
    totalTokens: 0,
    costTotal: 0,
    cacheHitCount: 0,
    cacheObservedCount: 0,
  };
}

function dateKey(entry: UsageLedgerEntry) {
  const value = entry.endedAt || entry.startedAt;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'unknown';
  return localDateKey(new Date(time));
}

function latestEntryTime(entries: UsageLedgerEntry[]) {
  let latest: number | null = null;
  for (const entry of entries) {
    const time = Date.parse(entry.endedAt || entry.startedAt);
    if (!Number.isFinite(time)) continue;
    latest = latest === null ? time : Math.max(latest, time);
  }
  return latest;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '-';
  return formatDateLabelFromDate(new Date(time));
}

function formatDateLabelFromDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(date);
}

function trimUnitNumber(value: number) {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 1;
  return value.toFixed(digits).replace(/\.0$/, '');
}
