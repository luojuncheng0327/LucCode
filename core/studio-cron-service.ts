import fs from "fs";
import path from "path";
import { CronStore } from "../lib/desk/cron-store.ts";
import { requireAutomationExecutionContext } from "../lib/desk/automation-execution-context.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { atomicWriteSync } from "../shared/safe-fs.ts";

const log = createModuleLogger("studio-cron");
const LEGACY_CRON_MIGRATION_VERSION = 1;

function assertValidPathSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${label} contains invalid path characters`);
  }
  return value.trim();
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function legacyRefKey(ref) {
  if (!ref?.agentId || !ref?.jobId) return null;
  return `${ref.agentId}\u0000${ref.jobId}`;
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function isLegacyCronMigrationComplete(data) {
  const marker = data?.studioCronMigration;
  return marker?.version === LEGACY_CRON_MIGRATION_VERSION && marker?.status === "imported";
}

function markLegacyCronStoreMigrated(jobsPath, data, studioId) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  if (isLegacyCronMigrationComplete(data)) return;
  const jobIds = Array.isArray(data.jobs)
    ? data.jobs.map((job) => job?.id).filter((id) => typeof id === "string" && id)
    : [];
  const next = {
    ...data,
    studioCronMigration: {
      version: LEGACY_CRON_MIGRATION_VERSION,
      status: "imported",
      studioId,
      migratedAt: new Date().toISOString(),
      jobIds,
    },
  };
  atomicWriteSync(jobsPath, JSON.stringify(next, null, 2) + "\n");
}

function isSafeRunFileId(value) {
  return typeof value === "string" && value && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

class BoundStudioCronStore {
  declare _service: StudioCronService;
  declare studioId: string;

  constructor(service, studioId) {
    this._service = service;
    this.studioId = studioId;
    Object.freeze(this);
  }

  listJobs() { return this._service._listJobsForStudio(this.studioId); }
  getJob(id) { return this._service._getJobForStudio(this.studioId, id); }
  addJob(job, options = {}) { return this._service._addJobForStudio(this.studioId, job, options); }
  removeJob(id) { return this._service._removeJobForStudio(this.studioId, id); }
  updateJob(id, partial, options = {}) {
    return this._service._updateJobForStudio(this.studioId, id, partial, options);
  }
  toggleJob(id) { return this._service._toggleJobForStudio(this.studioId, id); }
  markRun(id, opts) { return this._service._markRunForStudio(this.studioId, id, opts); }
  logRun(id, run) { return this._service._logRunForStudio(this.studioId, id, run); }
  getRunHistory(id, limit) { return this._service._getRunHistoryForStudio(this.studioId, id, limit); }
}

export class StudioCronService {
  declare _lucHome: string;
  declare _agentsDir: string;
  declare _getStudioId: () => string;
  declare _handles: Map<string, BoundStudioCronStore>;
  declare _legacyImportedStudioIds: Set<string>;
  declare _stores: Map<string, CronStore>;

  /**
   * @param {object} opts
   * @param {string} opts.luccodeHome
   * @param {string} opts.agentsDir
   * @param {() => string} opts.getStudioId
   */
  constructor({ lucHome, agentsDir, getStudioId }) {
    if (!lucHome) throw new Error("StudioCronService requires lucHome");
    if (!agentsDir) throw new Error("StudioCronService requires agentsDir");
    if (typeof getStudioId !== "function") throw new Error("StudioCronService requires getStudioId");
    this._lucHome = lucHome;
    this._agentsDir = agentsDir;
    this._getStudioId = getStudioId;
    this._handles = new Map();
    this._legacyImportedStudioIds = new Set();
    this._stores = new Map();
  }

  captureCurrent() {
    return this.forStudio(this._getStudioId());
  }

  forStudio(studioId) {
    const normalizedStudioId = assertValidPathSegment(studioId, "studioId");
    let handle = this._handles.get(normalizedStudioId);
    if (!handle) {
      handle = new BoundStudioCronStore(this, normalizedStudioId);
      this._handles.set(normalizedStudioId, handle);
    }
    return handle;
  }

  listJobs() { return this.captureCurrent().listJobs(); }
  getJob(id) { return this.captureCurrent().getJob(id); }
  addJob(job, options = {}) { return this.captureCurrent().addJob(job, options); }
  removeJob(id) { return this.captureCurrent().removeJob(id); }
  updateJob(id, partial, options = {}) { return this.captureCurrent().updateJob(id, partial, options); }
  toggleJob(id) { return this.captureCurrent().toggleJob(id); }
  markRun(id, opts) { return this.captureCurrent().markRun(id, opts); }
  logRun(id, run) { return this.captureCurrent().logRun(id, run); }
  getRunHistory(id, limit) { return this.captureCurrent().getRunHistory(id, limit); }

  _listJobsForStudio(studioId) {
    return this._getStoreForStudio(studioId).listJobs();
  }

  _getJobForStudio(studioId, id) {
    return this._getStoreForStudio(studioId).getJob(id);
  }

  _addJobForStudio(studioId, job, options = {}) {
    const actorAgentId = normalizeOptionalString(job?.actorAgentId);
    if (!actorAgentId) throw new Error("cron job requires actorAgentId");
    const executionContext = requireAutomationExecutionContext(job.executionContext, actorAgentId);
    return this._getStoreForStudio(studioId).addJob({
      ...job,
      studioId,
      actorAgentId,
      executionContext,
      legacyRef: job.legacyRef || null,
    }, options);
  }

  _removeJobForStudio(studioId, id) {
    return this._getStoreForStudio(studioId).removeJob(id);
  }

  _updateJobForStudio(studioId, id, partial, options = {}) {
    const store = this._getStoreForStudio(studioId);
    const existing = store.getJob(id);
    if (!existing) return null;
    const actorAgentId = normalizeOptionalString(partial?.actorAgentId)
      || normalizeOptionalString(existing.actorAgentId);
    if (!actorAgentId) throw new Error("cron job requires actorAgentId");
    if (
      normalizeOptionalString(partial?.actorAgentId)
      && partial.actorAgentId.trim() !== existing.actorAgentId
      && !Object.prototype.hasOwnProperty.call(partial, "executionContext")
    ) {
      throw new Error("changing actorAgentId requires executionContext");
    }
    const normalizedPartial = { ...partial };
    if (Object.prototype.hasOwnProperty.call(partial, "executionContext")) {
      normalizedPartial.executionContext = requireAutomationExecutionContext(
        partial.executionContext,
        actorAgentId,
      );
    }
    return store.updateJob(id, normalizedPartial, options);
  }

  _toggleJobForStudio(studioId, id) {
    return this._getStoreForStudio(studioId).toggleJob(id);
  }

  _markRunForStudio(studioId, id, opts) {
    return this._getStoreForStudio(studioId).markRun(id, opts);
  }

  _logRunForStudio(studioId, id, run) {
    return this._getStoreForStudio(studioId).logRun(id, { ...run, studioId });
  }

  _getRunHistoryForStudio(studioId, id, limit) {
    return this._getStoreForStudio(studioId).getRunHistory(id, limit);
  }

  _getStoreForStudio(studioId) {
    const normalizedStudioId = assertValidPathSegment(studioId, "studioId");
    let store = this._stores.get(normalizedStudioId);
    if (!store) {
      const deskDir = path.join(this._lucHome, "studios", normalizedStudioId, "desk");
      store = new CronStore(
        path.join(deskDir, "cron-jobs.json"),
        path.join(deskDir, "cron-runs"),
        { idPrefix: "studio_job", studioId: normalizedStudioId },
      );
      this._stores.set(normalizedStudioId, store);
    }
    if (!this._legacyImportedStudioIds.has(normalizedStudioId)) {
      this._importLegacyJobs(store, normalizedStudioId);
      this._legacyImportedStudioIds.add(normalizedStudioId);
    }
    return store;
  }

  _importLegacyJobs(store, studioId) {
    const studioRunsDir = path.join(this._lucHome, "studios", studioId, "desk", "cron-runs");
    const existingLegacyJobs = new Map();
    for (const job of store.listJobs()) {
      const refKey = legacyRefKey(job.legacyRef);
      if (refKey) existingLegacyJobs.set(refKey, job);
    }
    let entries;
    try {
      entries = fs.readdirSync(this._agentsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentId = entry.name;
      const jobsPath = path.join(this._agentsDir, agentId, "desk", "cron-jobs.json");
      let data;
      try {
        data = readJsonIfPresent(jobsPath);
      } catch (err) {
        log.warn(`skipped invalid legacy cron store for ${agentId}: ${err.message}`);
        continue;
      }
      if (!data || !Array.isArray(data.jobs)) continue;
      if (isLegacyCronMigrationComplete(data)) continue;
      let historyMigrated = true;
      for (const legacyJob of data.jobs) {
        const ref = { agentId, jobId: legacyJob?.id };
        const refKey = legacyRefKey(ref);
        if (!refKey) continue;
        let studioJob = existingLegacyJobs.get(refKey);
        if (!studioJob) {
          const imported = this._toStudioJob(agentId, legacyJob, ref);
          if (!imported) continue;
          studioJob = store.addImportedJob(imported);
          existingLegacyJobs.set(refKey, studioJob);
        }
        historyMigrated = this._copyLegacyRunHistory(agentId, legacyJob?.id, studioJob.id, studioRunsDir) && historyMigrated;
      }
      if (historyMigrated) {
        try {
          markLegacyCronStoreMigrated(jobsPath, data, studioId);
        } catch (err) {
          log.warn(`failed to mark legacy cron store migrated for ${agentId}: ${err.message}`);
        }
      }
    }
  }

  _copyLegacyRunHistory(agentId, legacyJobId, studioJobId, studioRunsDir) {
    if (!isSafeRunFileId(legacyJobId) || !isSafeRunFileId(studioJobId)) return true;
    const source = path.join(this._agentsDir, agentId, "desk", "cron-runs", `${legacyJobId}.jsonl`);
    const target = path.join(studioRunsDir, `${studioJobId}.jsonl`);
    try {
      if (!fs.existsSync(source) || fs.existsSync(target)) return true;
      fs.mkdirSync(studioRunsDir, { recursive: true });
      fs.copyFileSync(source, target);
      return true;
    } catch (err) {
      log.warn(`failed to migrate legacy cron run history for ${agentId}/${legacyJobId}: ${err.message}`);
      return false;
    }
  }

  _toStudioJob(agentId, legacyJob, legacyRef) {
    if (!legacyJob || typeof legacyJob !== "object") return null;
    if (typeof legacyJob.prompt !== "string" || !legacyJob.prompt.trim()) return null;
    if (!["at", "every", "cron"].includes(legacyJob.type)) return null;
    if (legacyJob.schedule === undefined || legacyJob.schedule === null) return null;
    return {
      ...legacyJob,
      actorAgentId: agentId,
      executionContext: {
        kind: "legacy_agent_home",
        cwd: null,
        workspaceFolders: [],
        sourceSessionPath: null,
        createdByAgentId: agentId,
      },
      legacyRef,
    };
  }
}
