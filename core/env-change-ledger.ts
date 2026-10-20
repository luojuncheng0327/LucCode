/**
 * Process-local append-only ledger for environment changes that an existing
 * session cannot infer from its frozen prompt and tool snapshot.
 *
 * The Engine owns the only instance. Producers and reminder consumers receive
 * it through dependency injection; this module intentionally has no singleton.
 */

export type EnvChangeEntryType = "memory_facts";

export interface MemoryFactsPayload {
  addedLines: string[];
}

export type EnvChangeScope =
  { readonly kind: "agent"; readonly agentId: string };

export interface EnvChangeEntry {
  readonly seq: number;
  readonly type: EnvChangeEntryType;
  readonly scope: EnvChangeScope;
  readonly payload: Readonly<MemoryFactsPayload>;
  readonly at: string;
}

type EnvChangeInput = {
    type: "memory_facts";
    scope: { kind: "agent"; agentId: string };
    payload: MemoryFactsPayload;
  };

function freezeScope(entry: EnvChangeInput): EnvChangeScope {
  const agentId = entry.scope?.kind === "agent" && typeof entry.scope.agentId === "string"
    ? entry.scope.agentId.trim()
    : "";
  if (!agentId) {
    throw new TypeError("memory_facts environment changes require a non-empty agent scope");
  }
  return Object.freeze({ kind: "agent", agentId });
}

function freezePayload(entry: EnvChangeInput): EnvChangeEntry["payload"] {
  const payload = entry.payload as MemoryFactsPayload;
  return Object.freeze({ addedLines: Object.freeze([...(payload.addedLines || [])]) }) as Readonly<MemoryFactsPayload>;
}

export class EnvChangeLedger {
  private _entries: EnvChangeEntry[] = [];
  private _seq = 0;

  append(entry: EnvChangeInput): EnvChangeEntry {
    const scope = freezeScope(entry);
    const payload = freezePayload(entry);
    this._seq += 1;
    const recorded = Object.freeze({
      seq: this._seq,
      type: entry.type,
      scope,
      payload,
      at: new Date().toISOString(),
    }) as EnvChangeEntry;
    this._entries.push(recorded);
    return recorded;
  }

  /** Entries in (afterSeq, throughSeq], in append order. */
  entriesAfter(afterSeq: number, throughSeq = Number.POSITIVE_INFINITY): EnvChangeEntry[] {
    const cursor = Number.isFinite(afterSeq) ? afterSeq : 0;
    const upperBound = Number.isFinite(throughSeq) ? throughSeq : Number.POSITIVE_INFINITY;
    return this._entries.filter((entry) => entry.seq > cursor && entry.seq <= upperBound);
  }

  maxSeq(): number {
    return this._seq;
  }
}
