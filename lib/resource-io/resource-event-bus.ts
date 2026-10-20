import type {
  ResourceChangedEvent,
  ResourceDeletedEvent,
  ResourceEvent,
  ResourceEventCatchUpResult,
  ResourceRenamedEvent,
} from "./types.ts";

type EventEmit = (event: ResourceEvent, sessionPath?: string | null) => void;

type ResourceEventBusOptions = {
  emit: EventEmit;
  now?: () => Date;
  dedupeSize?: number;
  retentionSize?: number;
};

type ChangedInput = Omit<ResourceChangedEvent, "type" | "sequence" | "occurredAt">;
type DeletedInput = Omit<ResourceDeletedEvent, "type" | "sequence" | "occurredAt">;
type RenamedInput = Omit<ResourceRenamedEvent, "type" | "sequence" | "occurredAt">;

export class ResourceEventBus {
  declare _emit: EventEmit;
  declare _now: () => Date;
  declare _sequence: number;
  declare _dedupeSize: number;
  declare _retentionSize: number;
  declare _recentChangedKeys: Set<string>;
  declare _recentEvents: ResourceEvent[];

  constructor({ emit, now = () => new Date(), dedupeSize = 512, retentionSize = 1000 }: ResourceEventBusOptions) {
    if (typeof emit !== "function") throw new Error("ResourceEventBus requires emit");
    this._emit = emit;
    this._now = now;
    this._sequence = 0;
    this._dedupeSize = dedupeSize;
    this._retentionSize = Math.max(0, Math.floor(Number(retentionSize) || 0));
    this._recentChangedKeys = new Set();
    this._recentEvents = [];
  }

  changed(input: ChangedInput): ResourceChangedEvent | null {
    const dedupeKey = changedDedupeKey(input);
    if (dedupeKey && this._recentChangedKeys.has(dedupeKey)) return null;
    if (dedupeKey) this._rememberChangedKey(dedupeKey);

    const event: ResourceChangedEvent = {
      ...input,
      type: "resource.changed",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._rememberEvent(event);
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  deleted(input: DeletedInput): ResourceDeletedEvent {
    const event: ResourceDeletedEvent = {
      ...input,
      type: "resource.deleted",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._rememberEvent(event);
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  renamed(input: RenamedInput): ResourceRenamedEvent {
    const event: ResourceRenamedEvent = {
      ...input,
      type: "resource.renamed",
      sequence: this._nextSequence(),
      occurredAt: this._now().toISOString(),
    };
    this._rememberEvent(event);
    this._emit(event, input.sessionPath ?? null);
    return event;
  }

  since(sequence: number): ResourceEventCatchUpResult {
    const cursor = Number.isFinite(Number(sequence)) ? Math.max(0, Math.floor(Number(sequence))) : 0;
    const latestSequence = this._sequence;
    if (!this._recentEvents.length) {
      return { stale: false, latestSequence, events: [] };
    }

    const oldestSequence = this._recentEvents[0]?.sequence || latestSequence;
    if (cursor < oldestSequence - 1) {
      return { stale: true, latestSequence, events: [] };
    }

    return {
      stale: false,
      latestSequence,
      events: this._recentEvents.filter((event) => event.sequence > cursor),
    };
  }

  _nextSequence(): number {
    this._sequence += 1;
    return this._sequence;
  }

  _rememberChangedKey(key: string): void {
    this._recentChangedKeys.add(key);
    while (this._recentChangedKeys.size > this._dedupeSize) {
      const first = this._recentChangedKeys.values().next().value;
      if (!first) break;
      this._recentChangedKeys.delete(first);
    }
  }

  _rememberEvent(event: ResourceEvent): void {
    if (this._retentionSize <= 0) return;
    this._recentEvents.push(event);
    while (this._recentEvents.length > this._retentionSize) {
      this._recentEvents.shift();
    }
  }
}

function changedDedupeKey(input: ChangedInput): string | null {
  const version = input.version;
  if (!version) return null;
  return JSON.stringify({
    resourceKey: input.resourceKey,
    changeType: input.changeType,
    mtimeMs: version.mtimeMs,
    size: version.size,
    sha256: version.sha256,
    etag: version.etag,
    sequence: version.sequence,
  });
}
