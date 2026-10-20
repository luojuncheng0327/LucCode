import React, { type CSSProperties } from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import type { UsageLedgerEntry } from './usage-ledger-actions';
import {
  USAGE_PERIOD_ORDER,
  aggregateEntries,
  formatCompactNumber,
  formatNumber,
  formatPercent,
  formatTime,
  hitRate,
  modelLabel,
  num,
  requestSourceLabel,
  type UsageAggregate,
  type UsagePeriod,
} from './usage-ledger-model';

type CssVars = CSSProperties & Record<string, string | number>;

export function ModelOrbit({ groups, totalTokens }: { groups: UsageAggregate[]; totalTokens: number }) {
  const radii = [82, 64, 46, 28];
  return (
    <div className={styles['usage-orbit-wrap']}>
      <svg className={styles['usage-orbit']} viewBox="0 0 200 200" aria-hidden="true">
        <g transform="rotate(-90 100 100)">
          {groups.map((group, index) => (
            <RingCircles key={group.key} group={group} totalTokens={totalTokens} radius={radii[index] || 28} cx={100} cy={100} />
          ))}
        </g>
      </svg>
      <div className={styles['usage-orbit-center']}>
        <span>{formatPercent(hitRate(aggregateEntries('visible', '', groups.flatMap(group => group.entries))))}</span>
        <small>{t('settings.usage.cacheHitRate')}</small>
      </div>
    </div>
  );
}

export function SplitRing({ group, totalTokens, size }: { group: UsageAggregate; totalTokens: number; size: number }) {
  return (
    <svg className={styles['usage-split-ring']} style={{ width: size, height: size }} viewBox="0 0 44 44" aria-hidden="true">
      <g transform="rotate(-90 22 22)">
        <RingCircles group={group} totalTokens={totalTokens} radius={17} cx={22} cy={22} />
      </g>
    </svg>
  );
}

export function DailyBars({
  groups,
  title,
  period,
  onPeriodChange,
}: {
  groups: UsageAggregate[];
  title: string;
  period: UsagePeriod;
  onPeriodChange: (period: UsagePeriod) => void;
}) {
  const maxTotal = Math.max(1, ...groups.map(group => group.totalTokens));
  return (
    <div className={styles['usage-panel']}>
      <div className={styles['usage-panel-head']}>
        <div className={styles['usage-panel-title-cluster']}>
          <span className={styles['usage-panel-title']}>{title}</span>
          <UsagePeriodToggle period={period} onChange={onPeriodChange} />
        </div>
        <UsageLegend />
      </div>
      <div className={styles['usage-daily-bars']}>
        {groups.map((group, index) => {
          const style = {
            '--usage-cache-height': `${(group.cacheReadTokens / maxTotal) * 100}%`,
            '--usage-uncached-height': `${(group.nonCachedTokens / maxTotal) * 100}%`,
          } as CssVars;
          const edgeLabel = index === 0 || index === groups.length - 1 ? group.label : '';
          return (
            <div key={group.key} className={styles['usage-day']} title={`${group.label} · ${formatNumber(group.totalTokens)}`}>
              <div className={styles['usage-day-bar']} style={style}>
                <span className={styles['usage-day-cache']} />
                <span className={styles['usage-day-uncached']} />
              </div>
              <span className={styles['usage-day-label']}>{edgeLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UsagePeriodToggle({ period, onChange }: { period: UsagePeriod; onChange: (period: UsagePeriod) => void }) {
  return (
    <div className={styles['usage-period-toggle']} role="group" aria-label={t('settings.usage.dailyUsage')}>
      {USAGE_PERIOD_ORDER.map(item => (
        <button
          key={item}
          type="button"
          className={`${styles['usage-period-btn']}${period === item ? ` ${styles.active}` : ''}`}
          aria-pressed={period === item}
          onClick={() => onChange(item)}
        >
          {t(`settings.usage.period.${item}`)}
        </button>
      ))}
    </div>
  );
}

export function RequestLedger({ entries }: { entries: UsageLedgerEntry[] }) {
  return (
    <div className={styles['usage-panel']}>
      <div className={styles['usage-panel-title']}>{t('settings.usage.requestLedger')}</div>
      <div className={styles['usage-request-list']}>
        {entries.map(entry => (
          <div className={styles['usage-request-row']} key={entry.requestId}>
            <div className={styles['usage-request-main']}>
              <span className={styles['usage-request-source']}>{requestSourceLabel(entry, t)}</span>
              <span className={`${styles['usage-status']} ${styles[`usage-status-${entry.status}`]}`}>{t(`settings.usage.status.${entry.status}`)}</span>
            </div>
            <div className={styles['usage-request-detail']}>
              <span>{formatTime(entry.endedAt || entry.startedAt)}</span>
              <span>{modelLabel(entry)}</span>
              <span>{t('settings.usage.tokensShort', { tokens: formatCompactNumber(num(entry.usage?.totalTokens)) })}</span>
              <span>{t('settings.usage.cacheShort', { tokens: formatCompactNumber(num(entry.usage?.cache?.readTokens)) })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UsageLegend() {
  return (
    <div className={styles['usage-legend']}>
      <span><i className={styles['usage-legend-ink']} />{t('settings.usage.uncached')}</span>
      <span><i className={styles['usage-legend-cache']} />{t('settings.usage.cacheRead')}</span>
    </div>
  );
}

function RingCircles({ group, totalTokens, radius, cx, cy }: { group: UsageAggregate; totalTokens: number; radius: number; cx: number; cy: number }) {
  const basis = totalTokens > 0 ? totalTokens : 1;
  const cached = clampPercent((group.cacheReadTokens / basis) * 100);
  const nonCached = clampPercent((group.nonCachedTokens / basis) * 100);
  return (
    <>
      <circle className={styles['usage-ring-track']} cx={cx} cy={cy} r={radius} pathLength="100" />
      <circle className={styles['usage-ring-cache']} cx={cx} cy={cy} r={radius} pathLength="100" strokeDasharray={`${cached} ${100 - cached}`} />
      <circle className={styles['usage-ring-ink']} cx={cx} cy={cy} r={radius} pathLength="100" strokeDasharray={`${nonCached} ${100 - nonCached}`} strokeDashoffset={-cached} />
    </>
  );
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
