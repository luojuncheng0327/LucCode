import { loadSessions } from '../stores/session-actions';

const SESSION_REFRESH_DELAY_MS = 250;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<void> | null = null;
let pendingReason: string | null = null;

export function scheduleSessionsRefresh(reason = 'unknown'): void {
  pendingReason = reason;
  if (refreshTimer) return;
  if (refreshInFlight) return;

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void runScheduledRefresh();
  }, SESSION_REFRESH_DELAY_MS);
}

async function runScheduledRefresh(): Promise<void> {
  if (refreshInFlight) return;
  const reason = pendingReason;
  pendingReason = null;
  refreshInFlight = Promise.resolve(loadSessions())
    .catch((err) => console.warn(`[sessions] scheduled refresh failed (${reason || 'unknown'}):`, err))
    .then(() => undefined)
    .finally(() => {
      refreshInFlight = null;
      if (pendingReason) scheduleSessionsRefresh(pendingReason);
    });
  await refreshInFlight;
}

export function resetSessionRefreshSchedulerForTest(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshInFlight = null;
  pendingReason = null;
}
