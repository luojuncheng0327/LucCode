import { cronToHuman } from '../../utils/format';

export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'monthly' | 'once' | 'advanced';
export type IntervalUnit = 'minutes' | 'hours' | 'days';
export type StoredScheduleType = 'at' | 'every' | 'cron';

export interface ScheduleDraft {
  mode: ScheduleMode;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  time: string;
  weekday: string;
  monthDay: string;
  dateTime: string;
  cron: string;
}

export interface StoredSchedule {
  type: StoredScheduleType;
  schedule: string | number;
}

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

function two(value: number) {
  return String(value).padStart(2, '0');
}

function toTime(hour: string, minute: string) {
  const h = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
  const m = Math.max(0, Math.min(59, parseInt(minute, 10) || 0));
  return `${two(h)}:${two(m)}`;
}

function localDateTimeFromSchedule(schedule: unknown) {
  const date = new Date(String(schedule || ''));
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

function chooseInterval(ms: number): Pick<ScheduleDraft, 'intervalValue' | 'intervalUnit'> {
  if (Number.isFinite(ms) && ms > 0) {
    if (ms % UNIT_MS.days === 0) return { intervalValue: String(ms / UNIT_MS.days), intervalUnit: 'days' };
    if (ms % UNIT_MS.hours === 0) return { intervalValue: String(ms / UNIT_MS.hours), intervalUnit: 'hours' };
    return { intervalValue: String(Math.max(1, Math.round(ms / UNIT_MS.minutes))), intervalUnit: 'minutes' };
  }
  return { intervalValue: '60', intervalUnit: 'minutes' };
}

export function defaultScheduleDraft(): ScheduleDraft {
  return {
    mode: 'daily',
    intervalValue: '60',
    intervalUnit: 'minutes',
    time: '09:00',
    weekday: '1',
    monthDay: '1',
    dateTime: '',
    cron: '0 9 * * *',
  };
}

export function scheduleDraftFromStored(type: unknown, schedule: unknown): ScheduleDraft {
  const base = defaultScheduleDraft();
  if (type === 'every') {
    const ms = typeof schedule === 'number' ? schedule : parseInt(String(schedule), 10);
    return { ...base, mode: 'interval', ...chooseInterval(ms) };
  }
  if (type === 'at') {
    return { ...base, mode: 'once', dateTime: localDateTimeFromSchedule(schedule) };
  }

  const cron = String(schedule || '').trim();
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return { ...base, mode: 'advanced', cron };

  const [minute, hour, dayOfMonth, month, weekday] = parts;
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && weekday === '*') {
    return { ...base, mode: 'interval', intervalValue: minute.slice(2), intervalUnit: 'minutes', cron };
  }
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && weekday === '*') {
    return { ...base, mode: 'interval', intervalValue: hour.slice(2), intervalUnit: 'hours', cron };
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && month === '*') {
    const time = toTime(hour, minute);
    if (dayOfMonth === '*' && weekday === '*') return { ...base, mode: 'daily', time, cron };
    if (dayOfMonth === '*' && /^[0-7]$/.test(weekday)) return { ...base, mode: 'weekly', time, weekday: weekday === '7' ? '0' : weekday, cron };
    if (/^\d+$/.test(dayOfMonth) && weekday === '*') return { ...base, mode: 'monthly', time, monthDay: dayOfMonth, cron };
  }
  return { ...base, mode: 'advanced', cron };
}

function timeParts(time: string) {
  const [hour = '9', minute = '0'] = time.split(':');
  return {
    hour: String(Math.max(0, Math.min(23, parseInt(hour, 10) || 0))),
    minute: String(Math.max(0, Math.min(59, parseInt(minute, 10) || 0))),
  };
}

export function storedScheduleFromDraft(draft: ScheduleDraft): StoredSchedule {
  if (draft.mode === 'interval') {
    const value = Math.max(1, parseInt(draft.intervalValue, 10) || 1);
    return { type: 'every', schedule: value * UNIT_MS[draft.intervalUnit] };
  }
  if (draft.mode === 'once') {
    const date = new Date(draft.dateTime);
    return { type: 'at', schedule: Number.isNaN(date.getTime()) ? draft.dateTime : date.toISOString() };
  }
  if (draft.mode === 'advanced') {
    return { type: 'cron', schedule: draft.cron.trim() };
  }

  const { hour, minute } = timeParts(draft.time);
  if (draft.mode === 'weekly') {
    const weekday = Math.max(0, Math.min(6, parseInt(draft.weekday, 10) || 0));
    return { type: 'cron', schedule: `${minute} ${hour} * * ${weekday}` };
  }
  if (draft.mode === 'monthly') {
    const day = Math.max(1, Math.min(31, parseInt(draft.monthDay, 10) || 1));
    return { type: 'cron', schedule: `${minute} ${hour} ${day} * *` };
  }
  return { type: 'cron', schedule: `${minute} ${hour} * * *` };
}

export function intervalMinutesForApi(draft: ScheduleDraft): string | null {
  if (draft.mode !== 'interval') return null;
  const stored = storedScheduleFromDraft(draft);
  const ms = typeof stored.schedule === 'number' ? stored.schedule : parseInt(String(stored.schedule), 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return String(Math.max(1, Math.round(ms / UNIT_MS.minutes)));
}

function t(key: string, params?: Record<string, string | number>) {
  const translate = window.t ?? ((p: string) => p);
  return params ? translate(key, params) : translate(key);
}

export function schedulePreviewFromDraft(draft: ScheduleDraft): string {
  if (draft.mode === 'once') {
    const date = new Date(draft.dateTime);
    const text = Number.isNaN(date.getTime())
      ? draft.dateTime
      : date.toLocaleString(undefined, { hour12: false });
    return t('automation.schedule.onceAt', { date: text });
  }
  if (draft.mode === 'advanced') {
    return t('automation.schedule.advancedCron', { cron: draft.cron || '' });
  }
  const stored = storedScheduleFromDraft(draft);
  return cronToHuman(stored.schedule);
}
