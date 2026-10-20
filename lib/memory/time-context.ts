const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FACT_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function isValidHourMinute(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveMemoryTimeZone(value) {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

export function getZonedDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveMemoryTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

export function formatZonedDateTime(date, timeZone) {
  const parts = getZonedDateTimeParts(date, timeZone);
  return `${parts.date} ${parts.time}`;
}

export function formatZonedDate(date, timeZone) {
  return getZonedDateTimeParts(date, timeZone).date;
}

function collectLocalDatesBetween(start, end, timeZone) {
  const dates = new Set();
  dates.add(formatZonedDate(start, timeZone));
  dates.add(formatZonedDate(end, timeZone));

  const startMs = start.getTime();
  const endMs = end.getTime();
  let cursor = startMs;
  let guard = 0;
  while (cursor <= endMs && guard < 400) {
    dates.add(formatZonedDate(new Date(cursor), timeZone));
    cursor += SIX_HOURS_MS;
    guard += 1;
  }

  return uniqueSorted([...dates]);
}

export function buildSourceTimeRange(messages, opts: Record<string, any> = {}) {
  const timeZone = resolveMemoryTimeZone(opts.timeZone);
  const dates = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const parsed = parseDate(message?.timestamp);
    if (parsed) dates.push(parsed);
  }
  if (dates.length === 0) return null;

  dates.sort((a, b) => a.getTime() - b.getTime());
  const start = dates[0];
  const end = dates[dates.length - 1];
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: timeZone,
    localDates: collectLocalDatesBetween(start, end, timeZone),
  };
}

export function normalizeSourceTimeRange(raw, opts: Record<string, any> = {}) {
  const timeZone = resolveMemoryTimeZone(raw?.timezone || raw?.timeZone || opts.timeZone);
  const start = parseDate(raw?.start);
  const end = parseDate(raw?.end);
  const rawLocalDates = Array.isArray(raw?.localDates)
    ? raw.localDates.filter((date) => typeof date === "string" && DATE_RE.test(date))
    : [];
  const localDates = rawLocalDates.length > 0
    ? uniqueSorted(rawLocalDates)
    : start && end
      ? collectLocalDatesBetween(start, end, timeZone)
      : [];

  if (!start && !end && localDates.length === 0) {
    return {
      start: null,
      end: null,
      timezone: timeZone,
      localDates: [],
    };
  }

  return {
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    timezone: timeZone,
    localDates,
  };
}

export function extractSummaryTimeSignals(summary) {
  const text = typeof summary === "string" ? summary : "";
  const dateTimes = new Set();
  const dates = new Set();
  const times = new Set();

  const dateTimeRe = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})\b/g;
  for (const match of text.matchAll(dateTimeRe)) {
    if (!isValidHourMinute(match[2], match[3])) continue;
    const date = match[1];
    const time = `${match[2]}:${match[3]}`;
    dates.add(date);
    times.add(time);
    dateTimes.add(`${date}T${time}`);
  }

  const dateRe = /\b(\d{4}-\d{2}-\d{2})\b/g;
  for (const match of text.matchAll(dateRe)) {
    dates.add(match[1]);
  }

  const timeRe = /(^|[^\d])(\d{2}):(\d{2})(?!\d)/g;
  for (const match of text.matchAll(timeRe)) {
    if (!isValidHourMinute(match[2], match[3])) continue;
    times.add(`${match[2]}:${match[3]}`);
  }

  return {
    dateTimes: uniqueSorted([...dateTimes]),
    dates: uniqueSorted([...dates]),
    times: uniqueSorted([...times]),
  };
}

export function buildFactTimeContext(summaryRecord, opts: Record<string, any> = {}) {
  const sourceRange = normalizeSourceTimeRange(summaryRecord?.source_time_range, opts);
  const summarySignals = extractSummaryTimeSignals(summaryRecord?.summary);
  const localDates = sourceRange.localDates;

  return {
    timezone: sourceRange.timezone,
    sourceRange,
    localDates,
    singleSourceDate: localDates.length === 1 ? localDates[0] : null,
    spansMultipleSourceDates: localDates.length > 1,
    summaryDates: summarySignals.dates,
    summaryDateTimes: summarySignals.dateTimes,
    summaryTimes: summarySignals.times,
  };
}

export function normalizeFactTime(value, context: Record<string, any> = {}) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(FACT_TIME_RE);
  if (!match) return null;

  const date = match[1];
  const time = `${match[2]}:${match[3]}`;
  if (!isValidHourMinute(match[2], match[3])) return null;

  const candidate = `${date}T${time}`;
  const summaryDateTimes = new Set(context.summaryDateTimes || []);
  const summaryDates = new Set(context.summaryDates || []);
  const summaryTimes = new Set(context.summaryTimes || []);
  const localDates = Array.isArray(context.localDates) ? context.localDates : [];

  if (summaryTimes.size === 0 || !summaryTimes.has(time)) {
    return null;
  }

  if (localDates.length > 0 && !localDates.includes(date)) {
    return context.singleSourceDate ? `${context.singleSourceDate}T${time}` : null;
  }

  if (summaryDateTimes.has(candidate)) {
    return candidate;
  }
  if (summaryDates.has(date) && (localDates.length === 0 || localDates.includes(date))) {
    return candidate;
  }
  if (localDates.includes(date) && !context.spansMultipleSourceDates) {
    return candidate;
  }
  if (context.singleSourceDate) {
    return `${context.singleSourceDate}T${time}`;
  }

  return null;
}
