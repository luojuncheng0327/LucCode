import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { SettingsSection } from '../../components/SettingsSection';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { loadLlmUsageEntries, type UsageLedgerEntry } from './usage-ledger-actions';
import { DailyBars, ModelOrbit, RequestLedger, SplitRing, UsageLegend } from './UsageLedgerCharts';
import {
  USAGE_VIEW_ORDER,
  aggregateEntries,
  categoryKey,
  categoryLabel,
  formatCompactNumber,
  formatPercent,
  groupDateWindowEntries,
  groupEntries,
  modelKey,
  modelLabel,
  usagePeriodDateRange,
  type UsagePeriod,
  type UsageAggregate,
  type UsageView,
} from './usage-ledger-model';

type CssVars = CSSProperties & Record<string, string | number>;

export function UsageLedgerSection() {
  const [entries, setEntries] = useState<UsageLedgerEntry[]>([]);
  const [dateWindowEntries, setDateWindowEntries] = useState<UsageLedgerEntry[]>([]);
  const [view, setView] = useState<UsageView>('overall');
  const [period, setPeriod] = useState<UsagePeriod>('week');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [recent, dateWindow] = await Promise.all([
        loadLlmUsageEntries(500),
        loadLlmUsageEntries(usagePeriodDateRange(period)),
      ]);
      setEntries(recent);
      setDateWindowEntries(dateWindow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void refresh(); }, [refresh]);

  const totals = useMemo(() => aggregateEntries('total', t('settings.usage.total'), entries), [entries]);
  const modelGroups = useMemo(() => groupEntries(entries, modelKey, modelLabel), [entries]);
  const categoryGroups = useMemo(() => groupEntries(entries, categoryKey, entry => categoryLabel(entry, t)), [entries]);
  const dateWindowGroups = useMemo(() => groupDateWindowEntries(dateWindowEntries, period), [dateWindowEntries, period]);
  const latestEntries = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <SettingsSection title={t('settings.usage.title')} context={<RefreshButton loading={loading} onRefresh={refresh} />}>
      <div className={styles['usage-ledger']}>
        <div className={styles['usage-note']}>{t('settings.usage.note')}</div>
        <UsageTabs view={view} onChange={setView} />
        <div className={styles['usage-view-frame']}>
          {error && <div className={styles['usage-error']}>{error}</div>}
          {!error && loading && entries.length === 0 && <div className={styles['usage-empty']}>{t('settings.usage.loading')}</div>}
          {!error && !loading && entries.length === 0 && <div className={styles['usage-empty']}>{t('settings.usage.empty')}</div>}
          {!error && entries.length > 0 && (
            <>
              {view === 'overall' && <OverallView totals={totals} models={modelGroups} requests={latestEntries} />}
              {view === 'daily' && <DailyView groups={dateWindowGroups} period={period} onPeriodChange={setPeriod} />}
              {view === 'category' && <GroupView groups={categoryGroups} totals={totals} />}
              {view === 'model' && <GroupView groups={modelGroups} totals={totals} />}
            </>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function RefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => Promise<void> }) {
  return (
    <button
      type="button"
      className={styles['usage-refresh-btn']}
      onClick={() => { void onRefresh(); }}
      title={t('settings.usage.refresh')}
      aria-label={t('settings.usage.refresh')}
      disabled={loading}
    >
      <RefreshIcon />
    </button>
  );
}

function UsageTabs({ view, onChange }: { view: UsageView; onChange: (view: UsageView) => void }) {
  const tabStyle = { '--usage-tab-index': USAGE_VIEW_ORDER.indexOf(view) } as CssVars;
  return (
    <div className={styles['usage-tabs']} role="tablist" aria-label={t('settings.usage.title')} style={tabStyle}>
      <span className={styles['usage-tab-slider']} aria-hidden="true" />
      {USAGE_VIEW_ORDER.map(item => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={view === item}
          className={`${styles['usage-tab']}${view === item ? ` ${styles.active}` : ''}`}
          onClick={() => onChange(item)}
        >
          {t(`settings.usage.view.${item}`)}
        </button>
      ))}
    </div>
  );
}

function OverallView({ totals, models, requests }: { totals: UsageAggregate; models: UsageAggregate[]; requests: UsageLedgerEntry[] }) {
  const topModels = models.slice(0, 4);
  return (
    <div className={styles['usage-overall']}>
      <div className={styles['usage-hero']}>
        <ModelOrbit groups={topModels} totalTokens={totals.totalTokens} />
        <div className={styles['usage-hero-copy']}>
          <span className={styles['usage-eyebrow']}>{t('settings.usage.modelMix')}</span>
          <span className={styles['usage-hero-value']}>{formatCompactNumber(totals.totalTokens)}</span>
          <span className={styles['usage-hero-meta']}>
            {t('settings.usage.cacheSummary', {
              cache: formatCompactNumber(totals.cacheReadTokens),
              uncached: formatCompactNumber(totals.nonCachedTokens),
            })}
          </span>
          <div className={styles['usage-hero-stats']}>
            <UsageHeroStat label={t('settings.usage.requests')} value={formatCompactNumber(totals.requests)} />
            <UsageHeroStat label={t('settings.usage.cacheRead')} value={formatCompactNumber(totals.cacheReadTokens)} />
          </div>
          <UsageLegend />
        </div>
      </div>
      <div className={styles['usage-overall-grid']}>
        <UsageRankList title={t('settings.usage.modelMix')} groups={models.slice(0, 6)} totalTokens={totals.totalTokens} />
        <RequestLedger entries={requests} />
      </div>
    </div>
  );
}

function UsageHeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles['usage-hero-stat']}>
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

function DailyView({
  groups,
  period,
  onPeriodChange,
}: {
  groups: UsageAggregate[];
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
}) {
  const activeGroups = groups.filter(group => group.requests > 0 || group.totalTokens > 0);
  const title = t(`settings.usage.window.${period}`);
  const periodTotals = aggregateEntries(`date-window-${period}`, title, groups.flatMap(group => group.entries));
  return (
    <div className={styles['usage-daily']}>
      <DailyBars
        groups={groups}
        title={title}
        period={period}
        onPeriodChange={onPeriodChange}
      />
      <UsageRankList title={title} groups={[...activeGroups].reverse()} totalTokens={periodTotals.totalTokens} />
    </div>
  );
}

function GroupView({ groups, totals }: { groups: UsageAggregate[]; totals: UsageAggregate }) {
  return (
    <div className={styles['usage-ring-grid']}>
      {groups.map(group => (
        <UsageGroupRow key={group.key} group={group} totalTokens={totals.totalTokens} />
      ))}
    </div>
  );
}

function UsageRankList({ title, groups, totalTokens }: { title: string; groups: UsageAggregate[]; totalTokens: number }) {
  return (
    <div className={styles['usage-panel']}>
      <div className={styles['usage-panel-title']}>{title}</div>
      <div className={styles['usage-rank-list']}>
        {groups.map(group => (
          <UsageGroupRow key={group.key} group={group} totalTokens={totalTokens} compact />
        ))}
      </div>
    </div>
  );
}

function UsageGroupRow({ group, totalTokens, compact = false }: { group: UsageAggregate; totalTokens: number; compact?: boolean }) {
  const share = totalTokens > 0 ? group.totalTokens / totalTokens : 0;
  return (
    <div className={`${styles['usage-group-row']}${compact ? ` ${styles.compact}` : ''}`}>
      <SplitRing group={group} totalTokens={compact ? group.totalTokens : totalTokens} size={compact ? 42 : 54} />
      <div className={styles['usage-group-main']}>
        <span className={styles['usage-group-title']} title={group.label}>{group.label}</span>
        <span className={styles['usage-group-meta']}>
          {t('settings.usage.groupMeta', { requests: group.requests, errors: group.errors })}
        </span>
      </div>
      <div className={styles['usage-group-numbers']}>
        <span>{formatCompactNumber(group.totalTokens)}</span>
        <span>{formatPercent(share)}</span>
      </div>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <path d="M18 2v4h4" />
      <path d="M6 22v-4H2" />
    </svg>
  );
}
