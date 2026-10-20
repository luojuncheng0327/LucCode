import { useEffect, useMemo, useRef, useState } from 'react';
import { SelectWidget, type SelectOption } from '@/ui';
import type { ScheduleDraft, ScheduleMode, IntervalUnit } from './schedule-draft';
import styles from './AutomationPanel.module.css';

const SCHEDULE_MODES: ScheduleMode[] = ['interval', 'daily', 'weekly', 'monthly', 'once', 'advanced'];
const INTERVAL_UNITS: IntervalUnit[] = ['minutes', 'hours', 'days'];

function t(key: string) {
  return (window.t ?? ((p: string) => p))(key);
}

function dayNames() {
  const value = (window.t as (...args: unknown[]) => unknown)?.('cron.dayNames');
  return Array.isArray(value) ? value.map(String) : ['日', '一', '二', '三', '四', '五', '六'];
}

function two(value: number) {
  return String(value).padStart(2, '0');
}

function parseTime(value: string) {
  const [hour = '9', minute = '0'] = String(value || '').split(':');
  return {
    hour: Math.max(0, Math.min(23, parseInt(hour, 10) || 0)),
    minute: Math.max(0, Math.min(59, parseInt(minute, 10) || 0)),
  };
}

function formatTime(hour: number, minute: number) {
  return `${two(hour)}:${two(minute)}`;
}

function TimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const { hour, minute } = parseTime(value);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, index) => index), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, index) => index), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const defer = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame
      : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
    defer(() => {
      popoverRef.current
        ?.querySelectorAll('[data-selected="true"]')
        .forEach((node) => {
          if (node instanceof HTMLElement && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'center' });
          }
        });
    });
  }, [hour, minute, open]);

  const selectHour = (nextHour: number) => {
    onChange(formatTime(nextHour, minute));
  };

  const selectMinute = (nextMinute: number) => {
    onChange(formatTime(hour, nextMinute));
  };

  return (
    <div className={styles.timePicker} ref={rootRef}>
      <button
        className={styles.timePickerButton}
        type="button"
        aria-label={t('automation.schedule.time')}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span>{formatTime(hour, minute)}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {open ? (
        <div className={styles.timePickerPopover} ref={popoverRef}>
          <div className={styles.timePickerColumn} role="listbox" aria-label={t('automation.schedule.hour')}>
            {hours.map(option => (
              <button
                key={option}
                className={styles.timePickerOption}
                type="button"
                aria-label={`${two(option)} ${t('automation.schedule.hour')}`}
                data-selected={option === hour}
                onClick={() => selectHour(option)}
              >
                {two(option)}
              </button>
            ))}
          </div>
          <div className={styles.timePickerDivider} aria-hidden="true" />
          <div className={styles.timePickerColumn} role="listbox" aria-label={t('automation.schedule.minute')}>
            {minutes.map(option => (
              <button
                key={option}
                className={styles.timePickerOption}
                type="button"
                aria-label={`${two(option)} ${t('automation.schedule.minute')}`}
                data-selected={option === minute}
                onClick={() => selectMinute(option)}
              >
                {two(option)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ScheduleEditor({
  draft,
  onChange,
  className = '',
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  className?: string;
}) {
  const update = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });
  const days = dayNames();

  return (
    <div className={`${styles.scheduleEditor}${className ? ` ${className}` : ''}`}>
      <label className={styles.field}>
        <span>{t('automation.field.schedule')}</span>
        <SelectWidget
          className={styles.scheduleSelect}
          triggerClassName={styles.scheduleSelectTrigger}
          options={SCHEDULE_MODES.map((mode): SelectOption => ({ value: mode, label: t(`automation.schedule.mode.${mode}`) }))}
          value={draft.mode}
          onChange={v => update({ mode: v as ScheduleMode })}
        />
      </label>

      {draft.mode === 'interval' ? (
        <div className={styles.scheduleInline}>
          <label className={styles.field}>
            <span>{t('automation.schedule.every')}</span>
            <input
              type="number"
              min="1"
              step="1"
              value={draft.intervalValue}
              onChange={e => update({ intervalValue: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>{t('automation.schedule.unit')}</span>
            <SelectWidget
              className={styles.scheduleSelect}
              triggerClassName={styles.scheduleSelectTrigger}
              options={INTERVAL_UNITS.map((unit): SelectOption => ({ value: unit, label: t(`automation.schedule.unitLabel.${unit}`) }))}
              value={draft.intervalUnit}
              onChange={v => update({ intervalUnit: v as IntervalUnit })}
            />
          </label>
        </div>
      ) : null}

      {draft.mode === 'daily' ? (
        <label className={styles.field}>
          <span>{t('automation.schedule.time')}</span>
          <TimePicker value={draft.time} onChange={time => update({ time })} />
        </label>
      ) : null}

      {draft.mode === 'weekly' ? (
        <div className={styles.scheduleInline}>
          <label className={styles.field}>
            <span>{t('automation.schedule.weekday')}</span>
            <SelectWidget
              className={styles.scheduleSelect}
              triggerClassName={styles.scheduleSelectTrigger}
              options={days.map((name, index): SelectOption => ({ value: String(index), label: `${t('cron.weekPrefix')}${name}` }))}
              value={draft.weekday}
              onChange={v => update({ weekday: v })}
            />
          </label>
          <label className={styles.field}>
            <span>{t('automation.schedule.time')}</span>
            <TimePicker value={draft.time} onChange={time => update({ time })} />
          </label>
        </div>
      ) : null}

      {draft.mode === 'monthly' ? (
        <div className={styles.scheduleInline}>
          <label className={styles.field}>
            <span>{t('automation.schedule.monthDay')}</span>
            <input
              type="number"
              min="1"
              max="31"
              step="1"
              value={draft.monthDay}
              onChange={e => update({ monthDay: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>{t('automation.schedule.time')}</span>
            <TimePicker value={draft.time} onChange={time => update({ time })} />
          </label>
        </div>
      ) : null}

      {draft.mode === 'once' ? (
        <label className={styles.field}>
          <span>{t('automation.schedule.dateTime')}</span>
          <input type="datetime-local" value={draft.dateTime} onChange={e => update({ dateTime: e.target.value })} />
        </label>
      ) : null}

      {draft.mode === 'advanced' ? (
        <label className={styles.field}>
          <span>{t('automation.schedule.cronExpression')}</span>
          <input value={draft.cron} onChange={e => update({ cron: e.target.value })} />
        </label>
      ) : null}
    </div>
  );
}
