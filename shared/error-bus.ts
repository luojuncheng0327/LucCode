// shared/error-bus.ts
import { AppError } from './errors.ts';
import { redactLogText, redactLogValue } from './log-redactor.ts';


interface ErrorBusEntry {
  error: AppError;
  timestamp: number;
  breadcrumbs: Array<Record<string, unknown>>;
}

type ErrorBusRoute = 'statusbar' | 'boundary' | 'toast' | string;
type ErrorBusListener = (entry: ErrorBusEntry, route: ErrorBusRoute) => void;

interface ReportExtra {
  context?: Record<string, unknown>;
  dedupeKey?: string;
  route?: ErrorBusRoute;
}

export class ErrorBus {
  _listeners: ErrorBusListener[];
  _breadcrumbs: Array<Record<string, unknown>>;
  _maxBreadcrumbs: number;
  _recentFingerprints: Map<string, number>;
  _dedupeWindowMs: number;

  constructor() {
    this._listeners = [];
    this._breadcrumbs = [];
    this._maxBreadcrumbs = 50;
    this._recentFingerprints = new Map();
    this._dedupeWindowMs = 5000;
  }

  addBreadcrumb(crumb: Record<string, unknown>): void {
    if (this._breadcrumbs.length >= this._maxBreadcrumbs) this._breadcrumbs.shift();
    this._breadcrumbs.push({ ...crumb, timestamp: Date.now() });
  }

  report(error: unknown, extra?: ReportExtra): void {
    const appErr = AppError.wrap(error);
    if (extra?.context) Object.assign(appErr.context, extra.context);

    const fingerprint = extra?.dedupeKey || appErr.code;
    const lastSeen = this._recentFingerprints.get(fingerprint);
    if (lastSeen && Date.now() - lastSeen < this._dedupeWindowMs) return;
    this._recentFingerprints.set(fingerprint, Date.now());

    if (this._recentFingerprints.size > 200) {
      const now = Date.now();
      for (const [k, v] of this._recentFingerprints) {
        if (now - v > this._dedupeWindowMs) this._recentFingerprints.delete(k);
      }
    }

    const route = extra?.route || this._autoRoute(appErr);
    const entry: ErrorBusEntry = {
      error: appErr,
      timestamp: Date.now(),
      breadcrumbs: [...this._breadcrumbs],
    };

    this._log(entry);

    for (const listener of this._listeners) {
      try { listener(entry, route); } catch { /* listener errors must not crash the bus */ }
    }
  }

  subscribe(listener: ErrorBusListener): () => void {
    this._listeners.push(listener);
    return () => { this._listeners = this._listeners.filter(l => l !== listener); };
  }

  _autoRoute(err: AppError): ErrorBusRoute {
    if (err.code === 'WS_DISCONNECTED') return 'statusbar';
    if (err.severity === 'critical') return 'boundary';
    return 'toast';
  }

  _log(entry: ErrorBusEntry): void {
    const { error } = entry;
    console.error(
      `[ErrorBus][${error.code}][${error.traceId}] ${redactLogText(error.message)}`,
      redactLogValue(error.context),
    );
  }
}

// Global singleton per process
export const errorBus = new ErrorBus();
