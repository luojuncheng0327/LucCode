import crypto from "crypto";
import fs from "fs";
import path from "path";
import { atomicWriteSync } from "../../../shared/safe-fs.ts";
import {
  assemble,
  assembleWeekFromDaily,
  listWeekDayEntries,
  readCompiledMemorySections,
  writeDailyEntryBody,
} from "../compile.ts";
import { dreamDir, type DreamRunTrigger } from "./state-store.ts";

export type DreamWeekDay = { date: string; body: string };
export type DreamSections = {
  facts: string;
  today: string;
  weekDays: DreamWeekDay[];
  longterm: string;
};

export type DreamRevisionKind = "dream" | "pre_restore";

export type DreamRevision = {
  schemaVersion: 1;
  revisionId: string;
  runId: string;
  trigger: DreamRunTrigger;
  createdAt: string;
  kind: DreamRevisionKind;
  restoresRevisionId: string | null;
  before: DreamSections;
};

export type DreamRevisionSummary = Omit<DreamRevision, "before"> & {
  bodyChars: number;
  sectionChars: {
    facts: number;
    today: number;
    week: number;
    longterm: number;
  };
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REVISIONS = 10;

function revisionsDir(memoryDir: string) {
  return path.join(dreamDir(memoryDir), "revisions");
}

function pendingPath(memoryDir: string) {
  return path.join(dreamDir(memoryDir), "pending-apply.json");
}

function revisionPath(memoryDir: string, revisionId: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(revisionId)) throw new Error("Invalid Dream revision id");
  return path.join(revisionsDir(memoryDir), `${revisionId}.json`);
}

function dreamSectionsHash(sections: DreamSections) {
  return crypto.createHash("sha256").update(JSON.stringify(sections)).digest("hex");
}

function sectionCharSummary(sections: DreamSections) {
  const sectionChars = {
    facts: sections.facts.length,
    today: sections.today.length,
    week: sections.weekDays.reduce((sum, entry) => sum + entry.body.length, 0),
    longterm: sections.longterm.length,
  };
  return {
    bodyChars: Object.values(sectionChars).reduce((sum, value) => sum + value, 0),
    sectionChars,
  };
}

export function snapshotDreamSections(memoryDir: string): DreamSections {
  const sections = readCompiledMemorySections(memoryDir);
  return {
    facts: sections.facts,
    today: sections.today,
    weekDays: listWeekDayEntries(memoryDir),
    longterm: sections.longterm,
  };
}

export function createDreamRevision(memoryDir: string, options: {
  runId: string;
  trigger: DreamRunTrigger;
  before: DreamSections;
  kind?: DreamRevisionKind;
  restoresRevisionId?: string | null;
  retainRevisionIds?: string[];
}) {
  const revisionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const revision: DreamRevision = {
    schemaVersion: 1,
    revisionId,
    runId: options.runId,
    trigger: options.trigger,
    createdAt: new Date().toISOString(),
    kind: options.kind || "dream",
    restoresRevisionId: options.restoresRevisionId || null,
    before: options.before,
  };
  fs.mkdirSync(revisionsDir(memoryDir), { recursive: true });
  atomicWriteSync(revisionPath(memoryDir, revisionId), `${JSON.stringify(revision, null, 2)}\n`);
  pruneDreamRevisions(memoryDir, new Set([revisionId, ...(options.retainRevisionIds || [])]));
  return revision;
}

export function readDreamRevision(memoryDir: string, revisionId: string): DreamRevision {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(revisionPath(memoryDir, revisionId), "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error("Dream revision not found");
    throw new Error(`Dream revision is unreadable: ${err?.message || err}`);
  }
  if (raw?.schemaVersion !== 1 || raw?.revisionId !== revisionId || !raw?.before) {
    throw new Error("Dream revision has an invalid format");
  }
  const kind: DreamRevisionKind = raw.kind === "pre_restore" ? "pre_restore" : "dream";
  return {
    ...raw,
    kind,
    restoresRevisionId: typeof raw.restoresRevisionId === "string" ? raw.restoresRevisionId : null,
  } as DreamRevision;
}

export function listDreamRevisions(memoryDir: string): DreamRevisionSummary[] {
  const dir = revisionsDir(memoryDir);
  let files: string[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  return files
    .map((revisionId) => readDreamRevision(memoryDir, revisionId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || right.revisionId.localeCompare(left.revisionId, "en"))
    .map(({ before, ...revision }) => ({
      ...revision,
      ...sectionCharSummary(before),
    }));
}

function normalizeSections(sections: DreamSections) {
  const dates = new Set<string>();
  const weekDays = sections.weekDays.map((entry) => {
    if (!DATE_RE.test(entry?.date || "") || dates.has(entry.date)) {
      throw new Error("Dream output contains an invalid or duplicate week date");
    }
    dates.add(entry.date);
    return { date: entry.date, body: String(entry.body || "").trim() };
  });
  return {
    facts: String(sections.facts || "").trim(),
    today: String(sections.today || "").trim(),
    weekDays,
    longterm: String(sections.longterm || "").trim(),
  };
}

function writeSectionFile(filePath: string, body: string) {
  atomicWriteSync(filePath, body ? `${body}\n` : "");
}

function assembleMemory(memoryDir: string, memoryMdPath: string) {
  assemble(
    path.join(memoryDir, "facts.md"),
    path.join(memoryDir, "today.md"),
    path.join(memoryDir, "week.md"),
    path.join(memoryDir, "longterm.md"),
    memoryMdPath,
  );
}

function applyAllFiles(memoryDir: string, sections: DreamSections, memoryMdPath: string) {
  const normalized = normalizeSections(sections);
  const dailyDir = path.join(memoryDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });

  writeSectionFile(path.join(memoryDir, "facts.md"), normalized.facts);
  writeSectionFile(path.join(memoryDir, "today.md"), normalized.today);
  writeSectionFile(path.join(memoryDir, "longterm.md"), normalized.longterm);
  for (const entry of normalized.weekDays) {
    writeDailyEntryBody(dailyDir, entry.date, entry.body);
  }
  assembleWeekFromDaily(dailyDir, path.join(memoryDir, "week.md"));
  assembleMemory(memoryDir, memoryMdPath);
  return normalized;
}

function applyDreamFiles(memoryDir: string, sections: DreamSections, memoryMdPath: string) {
  const normalized = normalizeSections(sections);
  writeSectionFile(path.join(memoryDir, "facts.md"), normalized.facts);
  writeSectionFile(path.join(memoryDir, "longterm.md"), normalized.longterm);
  assembleMemory(memoryDir, memoryMdPath);
  return snapshotDreamSections(memoryDir);
}

export function applyDreamSections(memoryDir: string, options: {
  revision: DreamRevision;
  next: DreamSections;
  memoryMdPath?: string;
}) {
  const memoryMdPath = options.memoryMdPath || path.join(memoryDir, "memory.md");
  if (options.next.today !== options.revision.before.today
    || JSON.stringify(options.next.weekDays) !== JSON.stringify(options.revision.before.weekDays)) {
    throw new Error("Dream may not rewrite Today or Week");
  }

  fs.mkdirSync(dreamDir(memoryDir), { recursive: true });
  atomicWriteSync(pendingPath(memoryDir), `${JSON.stringify({
    schemaVersion: 1,
    revisionId: options.revision.revisionId,
    startedAt: new Date().toISOString(),
    operation: "dream",
  }, null, 2)}\n`);

  try {
    const normalized = applyDreamFiles(memoryDir, options.next, memoryMdPath);
    fs.rmSync(pendingPath(memoryDir), { force: true });
    return normalized;
  } catch (err) {
    try {
      applyDreamFiles(memoryDir, options.revision.before, memoryMdPath);
      fs.rmSync(pendingPath(memoryDir), { force: true });
    } catch (rollbackErr: any) {
      throw new Error(`Dream apply failed and rollback also failed: ${rollbackErr?.message || rollbackErr}`, { cause: err });
    }
    throw err;
  }
}

export function restoreDreamRevision(memoryDir: string, revisionId: string, memoryMdPath?: string) {
  const revision = readDreamRevision(memoryDir, revisionId);
  const current = snapshotDreamSections(memoryDir);
  if (dreamSectionsHash(current) === dreamSectionsHash(revision.before)) return current;

  const safetyRevision = createDreamRevision(memoryDir, {
    runId: `restore-${crypto.randomUUID()}`,
    trigger: "manual",
    before: current,
    kind: "pre_restore",
    restoresRevisionId: revision.revisionId,
    retainRevisionIds: [revision.revisionId],
  });
  const resolvedMemoryMdPath = memoryMdPath || path.join(memoryDir, "memory.md");
  fs.mkdirSync(dreamDir(memoryDir), { recursive: true });
  atomicWriteSync(pendingPath(memoryDir), `${JSON.stringify({
    schemaVersion: 1,
    revisionId: safetyRevision.revisionId,
    targetRevisionId: revision.revisionId,
    startedAt: new Date().toISOString(),
    operation: "restore",
  }, null, 2)}\n`);

  try {
    const restored = applyAllFiles(memoryDir, revision.before, resolvedMemoryMdPath);
    fs.rmSync(pendingPath(memoryDir), { force: true });
    return restored;
  } catch (err) {
    try {
      applyAllFiles(memoryDir, current, resolvedMemoryMdPath);
      fs.rmSync(pendingPath(memoryDir), { force: true });
    } catch (rollbackErr: any) {
      throw new Error(`Dream restore failed and rollback also failed: ${rollbackErr?.message || rollbackErr}`, { cause: err });
    }
    throw err;
  }
}

export function recoverPendingDreamApply(memoryDir: string, memoryMdPath?: string) {
  let pending: any;
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath(memoryDir), "utf-8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw new Error(`Dream pending journal is unreadable: ${err?.message || err}`);
  }
  const revision = readDreamRevision(memoryDir, pending?.revisionId);
  const resolvedMemoryMdPath = memoryMdPath || path.join(memoryDir, "memory.md");
  if (pending?.operation === "dream") {
    applyDreamFiles(memoryDir, revision.before, resolvedMemoryMdPath);
  } else {
    // Older journals had no operation field and could have partially rewritten
    // any section, so their recovery must restore the complete snapshot.
    applyAllFiles(memoryDir, revision.before, resolvedMemoryMdPath);
  }
  fs.rmSync(pendingPath(memoryDir), { force: true });
  return true;
}

function pruneDreamRevisions(memoryDir: string, retainedRevisionIds = new Set<string>()) {
  const dir = revisionsDir(memoryDir);
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ name: entry.name, stat: fs.statSync(path.join(dir, entry.name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let remaining = files.length;
  for (const file of [...files].reverse()) {
    if (remaining <= MAX_REVISIONS) break;
    const revisionId = file.name.slice(0, -".json".length);
    if (retainedRevisionIds.has(revisionId)) continue;
    fs.rmSync(path.join(dir, file.name), { force: true });
    remaining -= 1;
  }
}
