import { lucFetch } from '../hooks/use-luc-fetch';

export type ResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string };

type WatchEntry = {
  ref: ResourceRef;
  refCount: number;
  subscriptionId: string | null;
  disposed: boolean;
  released: boolean;
  ready: Promise<void>;
};

const watches = new Map<string, WatchEntry>();

type ResourceEvent = {
  type?: string;
  sequence?: number;
  [key: string]: unknown;
};

type ResourceEventFetch = (
  path: string,
  opts?: RequestInit & { timeout?: number; throwOnHttpError?: boolean },
) => Promise<{ json: () => Promise<any> }>;

type ResourceEventClientOptions = {
  fetchImpl?: ResourceEventFetch;
  applyEvent?: (event: ResourceEvent) => void;
  resubscribeWatches?: () => Promise<void> | void;
};

type ForegroundCatchUpOptions = {
  windowObj?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  documentObj?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null;
  catchUp?: () => Promise<unknown> | unknown;
  minIntervalMs?: number;
  now?: () => number;
};

export function createResourceEventClient({
  fetchImpl = lucFetch,
  applyEvent,
  resubscribeWatches,
}: ResourceEventClientOptions = {}) {
  let lastSeenSequence = 0;

  const handleEvent = (event: ResourceEvent | null | undefined): void => {
    if (!isResourceEvent(event)) return;
    if (Number.isFinite(event.sequence) && Number(event.sequence) > lastSeenSequence) {
      lastSeenSequence = Math.floor(Number(event.sequence));
    }
  };

  const catchUpAfterReconnect = async (options: { applyEvent?: (event: ResourceEvent) => void } = {}) => {
    const res = await fetchImpl(`/api/resource-io/events?since=${lastSeenSequence}`, {
      method: 'GET',
      throwOnHttpError: false,
    });
    const data = await res.json();
    if (data?.stale) {
      await resubscribeWatches?.();
      if (Number.isFinite(data.latestSequence) && Number(data.latestSequence) > lastSeenSequence) {
        lastSeenSequence = Math.floor(Number(data.latestSequence));
      }
      return data;
    }

    const handler = options.applyEvent || applyEvent;
    for (const event of Array.isArray(data?.events) ? data.events : []) {
      handleEvent(event);
      handler?.(event);
    }
    if (Number.isFinite(data?.latestSequence) && Number(data.latestSequence) > lastSeenSequence) {
      lastSeenSequence = Math.floor(Number(data.latestSequence));
    }
    return data;
  };

  return {
    handleEvent,
    catchUpAfterReconnect,
    lastSeenSequence: () => lastSeenSequence,
  };
}

const resourceEventClient = createResourceEventClient({
  fetchImpl: lucFetch,
  resubscribeWatches: resubscribeActiveWatches,
});

function normalizeResourceRef(ref: ResourceRef): ResourceRef {
  if (ref.kind === 'local-file') {
    return { kind: 'local-file', path: ref.path };
  }
  return {
    kind: 'mount',
    mountId: ref.mountId,
    path: String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  };
}

export function resourceWatchKey(ref: ResourceRef): string {
  const normalized = normalizeResourceRef(ref);
  if (normalized.kind === 'local-file') {
    const slashed = normalized.path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return `local-file:${/^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed}`;
  }
  return `mount:${normalized.mountId}:${normalized.path}`;
}

export function retainResourceWatch(ref: ResourceRef): () => void {
  const normalizedRef = normalizeResourceRef(ref);
  const key = resourceWatchKey(normalizedRef);
  const existing = watches.get(key);
  if (existing) {
    existing.refCount += 1;
    return () => releaseResourceWatch(key);
  }

  const entry: WatchEntry = {
    ref: normalizedRef,
    refCount: 1,
    subscriptionId: null,
    disposed: false,
    released: false,
    ready: Promise.resolve(),
  };
  entry.ready = subscribeEntry(entry);
  watches.set(key, entry);
  return () => releaseResourceWatch(key);
}

function subscribeEntry(entry: WatchEntry): Promise<void> {
  entry.released = false;
  return lucFetch('/api/resource-io/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'resource-watch', resources: [entry.ref] }),
    throwOnHttpError: false,
  })
    .then(res => res.json())
    .then((data) => {
      if (typeof data?.subscriptionId === 'string') entry.subscriptionId = data.subscriptionId;
      else console.warn('[resource-events] watch failed:', data?.error || entry.ref);
      if (entry.disposed) releaseEntry(entry);
    })
    .catch((err) => {
      if (!entry.disposed) console.warn('[resource-events] watch failed:', err);
    });
}

export function retainLocalFileResourceWatch(filePath: string): () => void {
  return retainResourceWatch({ kind: 'local-file', path: filePath });
}

function releaseResourceWatch(key: string): void {
  const entry = watches.get(key);
  if (!entry) return;
  if (entry.refCount > 1) {
    entry.refCount -= 1;
    return;
  }
  watches.delete(key);
  entry.disposed = true;
  void entry.ready.then(() => releaseEntry(entry));
}

function releaseEntry(entry: WatchEntry): void {
  if (entry.released || !entry.subscriptionId) return;
  entry.released = true;
  void lucFetch(`/api/resource-io/subscriptions/${encodeURIComponent(entry.subscriptionId)}`, {
    method: 'DELETE',
    throwOnHttpError: false,
  }).catch((err) => {
    console.warn('[resource-events] unwatch failed:', err);
  });
}

async function resubscribeActiveWatches(): Promise<void> {
  const entries = [...watches.values()].filter(entry => !entry.disposed);
  await Promise.all(entries.map(async (entry) => {
    const previousSubscriptionId = entry.subscriptionId;
    entry.subscriptionId = null;
    if (previousSubscriptionId) {
      await lucFetch(`/api/resource-io/subscriptions/${encodeURIComponent(previousSubscriptionId)}`, {
        method: 'DELETE',
        throwOnHttpError: false,
      }).catch((err) => {
        console.warn('[resource-events] stale unwatch failed:', err);
      });
    }
    if (!entry.disposed) entry.ready = subscribeEntry(entry);
    await entry.ready;
  }));
}

function isResourceEvent(event: ResourceEvent | null | undefined): event is ResourceEvent {
  return event?.type === 'resource.changed' || event?.type === 'resource.deleted' || event?.type === 'resource.renamed';
}

export function recordResourceEventCursor(event: ResourceEvent | null | undefined): void {
  resourceEventClient.handleEvent(event);
}

export function catchUpResourceEventsAfterReconnect(applyEvent?: (event: ResourceEvent) => void): Promise<unknown> {
  return resourceEventClient.catchUpAfterReconnect({ applyEvent });
}

export function bindResourceEventForegroundCatchUp(
  applyEvent?: (event: ResourceEvent) => void,
  options: ForegroundCatchUpOptions = {},
): () => void {
  const windowObj = options.windowObj ?? (typeof window !== 'undefined' ? window : null);
  const documentObj = options.documentObj ?? (typeof document !== 'undefined' ? document : null);
  if (!windowObj || !documentObj) return () => {};

  const minIntervalMs = Math.max(0, Math.floor(Number(options.minIntervalMs ?? 1000) || 0));
  const now = options.now ?? (() => Date.now());
  const catchUp = options.catchUp ?? (() => catchUpResourceEventsAfterReconnect(applyEvent));
  let inFlight = false;
  let lastStartedAt = 0;

  const run = () => {
    if (documentObj.visibilityState === 'hidden') return;
    const startedAt = now();
    if (inFlight || (lastStartedAt && startedAt - lastStartedAt < minIntervalMs)) return;
    inFlight = true;
    lastStartedAt = startedAt;
    Promise.resolve(catchUp())
      .catch((err) => {
        console.warn('[resource-events] foreground catch-up failed:', err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const onVisibilityChange = () => {
    if (documentObj.visibilityState === 'visible') run();
  };

  windowObj.addEventListener('focus', run);
  documentObj.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    windowObj.removeEventListener('focus', run);
    documentObj.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
