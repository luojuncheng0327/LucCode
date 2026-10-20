import crypto from "crypto";
import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.ts";

function leaseOwnerKey(sessionId: any, sessionPath: any) {
  return sessionId || sessionPath || null;
}

function leaseKey(sessionId: any, sessionPath: any, agentId: any, leaseId: any) {
  return `${leaseOwnerKey(sessionId, sessionPath) || ""}\0${agentId || ""}\0${leaseId}`;
}

function normalizeSessionRef(ctx: any = {}) {
  if (typeof ctx === "string") {
    return { sessionId: null, sessionPath: ctx || null, agentId: null };
  }
  return {
    sessionId: ctx?.sessionId || null,
    sessionPath: ctx?.sessionPath || null,
    agentId: ctx?.agentId || null,
  };
}

function sameSessionIdentity(lease: any, ctx: any = {}) {
  const ref = normalizeSessionRef(ctx);
  if (ref.sessionId && lease?.sessionId) return lease.sessionId === ref.sessionId;
  if (ref.sessionId && !lease?.sessionId && ref.sessionPath) return lease?.sessionPath === ref.sessionPath;
  if (ref.sessionPath) return lease?.sessionPath === ref.sessionPath;
  return false;
}

function sameLeaseOwner(lease: any, ctx: any) {
  return sameSessionIdentity(lease, ctx)
    && lease.agentId === (normalizeSessionRef(ctx).agentId || null);
}

function sameSessionOwner(lease: any, ctx: any) {
  return sameSessionIdentity(lease, ctx);
}

export class ComputerLeaseRegistry {
  declare _now: () => number;
  declare _idFactory: () => string;
  declare _snapshotIdFactory: () => string;
  declare _leases: Map<string, any>;
  declare _snapshots: Map<string, any>;

  constructor({
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    snapshotIdFactory = () => crypto.randomUUID(),
  } = {}) {
    this._now = now;
    this._idFactory = idFactory;
    this._snapshotIdFactory = snapshotIdFactory;
    this._leases = new Map();
    this._snapshots = new Map();
  }

  createLease(ctx, target) {
    const leaseId = target?.leaseId || this._idFactory();
    const lease = {
      leaseId,
      sessionId: ctx?.sessionId || null,
      sessionPath: ctx?.sessionPath || null,
      agentId: ctx?.agentId || null,
      providerId: target.providerId,
      appId: target.appId,
      windowId: target.windowId || null,
      createdAt: new Date(this._now()).toISOString(),
      expiresAt: target.expiresAt || null,
      status: "active",
      allowedActions: Array.isArray(target.allowedActions) ? [...target.allowedActions] : [],
      providerState: target.providerState && typeof target.providerState === "object"
        ? structuredClone(target.providerState)
        : {},
    };
    this._leases.set(leaseKey(lease.sessionId, lease.sessionPath, lease.agentId, lease.leaseId), lease);
    return lease;
  }

  getActiveLease() {
    for (const lease of this._leases.values()) {
      if (lease.status === "active") return lease;
    }
    return null;
  }

  getActiveLeaseFor(ctx) {
    for (const lease of this._leases.values()) {
      if (
        lease.status === "active"
        && sameLeaseOwner(lease, ctx)
      ) {
        return lease;
      }
    }
    return null;
  }

  getLastLeaseFor(ctx) {
    let found = null;
    for (const lease of this._leases.values()) {
      if (
        sameLeaseOwner(lease, ctx)
      ) {
        found = lease;
      }
    }
    return found;
  }

  getLease(ctx, leaseId) {
    const ref = normalizeSessionRef(ctx);
    const direct = this._leases.get(leaseKey(ref.sessionId, ref.sessionPath, ref.agentId, leaseId));
    if (direct && sameLeaseOwner(direct, ref)) return direct;
    for (const lease of this._leases.values()) {
      if (lease.leaseId === leaseId && sameLeaseOwner(lease, ref)) return lease;
    }
    return null;
  }

  requireActiveLease(ctx, leaseId) {
    const lease = this.getLease(ctx, leaseId);
    if (!lease) {
      throw computerUseError(COMPUTER_USE_ERRORS.LEASE_NOT_FOUND, `Computer lease not found: ${leaseId}`);
    }
    if (lease.status !== "active") {
      throw computerUseError(COMPUTER_USE_ERRORS.LEASE_RELEASED, `Computer lease is not active: ${leaseId}`, { status: lease.status });
    }
    return lease;
  }

  releaseLease(ctx, leaseId) {
    const lease = this.getLease(ctx, leaseId);
    if (!lease) return false;
    lease.status = "released";
    return true;
  }

  releaseLeaseRecord(lease) {
    if (!lease) return false;
    lease.status = "released";
    return true;
  }

  markStopping(ctx, leaseId) {
    const lease = this.requireActiveLease(ctx, leaseId);
    lease.status = "stopping";
    return lease;
  }

  recordSnapshot(ctx, leaseId, snapshot) {
    const lease = this.requireActiveLease(ctx, leaseId);
    const snapshotId = snapshot?.snapshotId || this._snapshotIdFactory();
    const record = {
      ...snapshot,
      snapshotId,
      leaseId,
      sessionId: lease.sessionId,
      sessionPath: lease.sessionPath,
      agentId: lease.agentId,
      capturedAt: snapshot?.capturedAt || new Date(this._now()).toISOString(),
    };
    this._snapshots.set(leaseKey(lease.sessionId, lease.sessionPath, lease.agentId, snapshotId), record);
    lease.lastSnapshotId = snapshotId;
    return record;
  }

  validateSnapshot(ctx, leaseId, snapshotId) {
    const lease = this.requireActiveLease(ctx, leaseId);
    const snapshot = this._snapshots.get(leaseKey(lease.sessionId, lease.sessionPath, lease.agentId, snapshotId));
    if (!snapshot || snapshot.leaseId !== leaseId) {
      throw computerUseError(COMPUTER_USE_ERRORS.STALE_SNAPSHOT, `Snapshot is stale or unknown: ${snapshotId}`, { leaseId, snapshotId });
    }
    if (lease.lastSnapshotId && lease.lastSnapshotId !== snapshotId) {
      throw computerUseError(COMPUTER_USE_ERRORS.STALE_SNAPSHOT, `Snapshot is not the latest snapshot for lease: ${leaseId}`, {
        leaseId,
        snapshotId,
        latestSnapshotId: lease.lastSnapshotId,
      });
    }
    return snapshot;
  }

  releaseBySession(sessionRef) {
    for (const lease of this._leases.values()) {
      if (sameSessionOwner(lease, sessionRef) && lease.status === "active") {
        lease.status = "released";
      }
    }
  }
}
