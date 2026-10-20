import fs from "fs";
import path from "path";
import {
  readDirectoryLikeDirentsSync,
  readFileLikePathsSync,
} from "../../shared/link-aware-fs.ts";
import { isSessionJsonlFilename } from "../../lib/session-jsonl.ts";
import {
  listAgentPhoneProjectionFiles,
  readAgentPhoneProjection,
  resolveAgentPhoneStoredSessionPath,
} from "../../lib/conversations/agent-phone-projection.ts";
import { normalizeSessionPermissionMode } from "../session-permission-mode.ts";
import { normalizeSessionLocatorPath, sessionLocatorKey } from "./path-normalizer.ts";

const MAX_SKIPPED_DETAILS = 20;
const LOCATOR_REQUIRED_LIFECYCLES = new Set(["active", "archived", "promoted"]);

// 迁移输入允许比运行时 1MB 索引闸门（session-coordinator.ts）胖：老版本没 compact 过的合法胖文件
// 也可能超过 1MB。超过这里的 64MB 上限的，必然是运行时隔离出的快照堆积病文件（session-meta.oversized.*.json），
// 跳过后会话行仍能从 JSONL 文件发现，只是丢失 legacy 属性候选。
export const LEGACY_META_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const LEGACY_META_SCAN_LEDGER_KEY = "legacy-meta-scan-ledger-v1";

// parse_error 死刑判决的 schema：BOM-unaware 旧账本没有此字段（或 < 2），升级后允许对
// 同 size/mtime 的 parse_error 重验一次；真正损坏的 JSON 重验失败后会带上 schema=2，
// 之后继续跳过。too_large 不走这套重验。
const PARSE_ERROR_VERDICT_SCHEMA = 2;

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function readJsonFileUtf8(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, "utf-8")));
}

function readJsonFile(filePath, fallback = {}) {
  try {
    return readJsonFileUtf8(filePath);
  } catch {
    return fallback;
  }
}

// 只校验顶层形状（必须是普通对象、不是数组）。单条记录内部字段畸形不在这里处理——
// 那种畸形会在下面的签名比较里被当成"跟已记录的不一样"，从而安全地触发重读。这是有意的
// 隐式防御：与其在这里再写一遍字段校验，不如让签名比较本身兜底,少一处判断就少一处判断错的可能。
function normalizeLedger(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
}

// 迁移路径的 stat 签名账本：按 (size, mtimeMs) 判断源文件自上次扫描以来是否变化。
// 账本持久化在 manifest store 的 state 表里（key 见 LEGACY_META_SCAN_LEDGER_KEY）。
//
// 覆盖范围：只管 session-meta.json 及其隔离备份（session-meta.oversized.*.json /
// session-meta.json.pre-v*.bak）与 session-titles.json 这几类文件。其它 legacy 索引
// （bridge-sessions.json、activities.json、subagent-runs.json 等）体积天然很小，
// 不走这个闸门，继续用普通的 readJsonFile。
//
// 跳过语义：账本只对"判了死刑"的文件（too_large / parse_error）做跳过记忆——这类文件
// 内容不会自愈，重复整读是纯粹的浪费，值得用账本省下来。例外：旧版 BOM-unaware 读者
// 留下的 parse_error（无 verdictSchema 或 schema < 2）允许重验一次——带 UTF-8 BOM 的
// 合法 JSON 会被误判，签名不变也必须再读；重验仍失败则写入 schema=2，之后照常跳过。
// too_large 不参与重验。健康文件（consumed）运行时早被 1MB compact 闸门收窄过，每次重读
// 是毫秒级开销；如果对 consumed 也做"签名不变就不读"，会导致一个真实场景失效：同一目录
// 下多个会话行共享同一份 session-meta.json，其中一行因为跟 meta 内容毫无关系的瞬时原因
// （比如 createForPath 抛错）第一轮建档失败、下一轮 rescan 才补上——这时候 meta 文件签名
// 没变，如果按"消费过就不读"处理，这一行就会永久拿不到 pinnedAt / capability / executor /
// permission 等 legacy 属性，而且完全静默、没有任何 skippedMetaSources 记录能提示这件事。
// rescan 机制存在的意义就是兜住这类迟到的行，所以 consumed 状态一律照常重读并返回数据，
// 不做跳过。
//
// 并发假设：这个 gate 假设单一顺序调用者（一次 migrateLegacySessions / auditLegacySessionManifests
// 调用内部顺序遍历），内存里的 ledger 副本只在 flush() 时整体写回一次。不支持多个调用者
// 并发读写同一个账本 key——如果未来出现并发扫描的需求，需要重新设计账本的读改写协议。
export function createMetaSourceGate(opts: any = {}) {
  const store = opts.store || null;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : LEGACY_META_SOURCE_MAX_BYTES;
  const now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();

  let ledger: any = {};
  if (store && typeof store.getState === "function") {
    let raw = null;
    try {
      raw = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
    } catch {
      raw = null;
    }
    ledger = normalizeLedger(raw);
  }

  let dirty = false;
  const skippedEntries: any[] = [];

  function recordEntry(filePath, size, mtimeMs, status) {
    const entry: any = { size, mtimeMs, status, recordedAt: now() };
    if (status === "parse_error") {
      entry.verdictSchema = PARSE_ERROR_VERDICT_SCHEMA;
    }
    ledger[filePath] = entry;
    dirty = true;
  }

  function shouldSkipCachedDeathSentence(prior, size, mtimeMs) {
    if (!prior || prior.size !== size || prior.mtimeMs !== mtimeMs || prior.status === "consumed") {
      return false;
    }
    // 旧账本把带 BOM 的合法 JSON 误判为 parse_error：无 verdictSchema（或 < 2）时重验一次。
    if (
      prior.status === "parse_error"
      && !(Number.isFinite(prior.verdictSchema) && prior.verdictSchema >= PARSE_ERROR_VERDICT_SCHEMA)
    ) {
      return false;
    }
    return true;
  }

  return {
    readGatedJsonFile(filePath) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        // stat 失败（ENOENT 等）按"文件不存在"处理：不记新账。如果账本里还留着这个路径的
        // 旧记录（文件后来被删掉或改名了），把这条尸位记录清掉，账本不留无效路径。
        if (Object.prototype.hasOwnProperty.call(ledger, filePath)) {
          delete ledger[filePath];
          dirty = true;
        }
        return { skipped: { reason: "not_found" } };
      }
      const { size, mtimeMs } = stat;
      const prior = ledger[filePath];
      if (shouldSkipCachedDeathSentence(prior, size, mtimeMs)) {
        // 签名未变且上次判了死刑：内容不会自愈，跳过。
        return { skipped: { reason: prior.status } };
      }
      if (size > maxBytes) {
        recordEntry(filePath, size, mtimeMs, "too_large");
        skippedEntries.push({ path: filePath, reason: "too_large", size });
        return { skipped: { reason: "too_large" } };
      }
      try {
        const data = readJsonFileUtf8(filePath);
        recordEntry(filePath, size, mtimeMs, "consumed");
        return { data };
      } catch {
        recordEntry(filePath, size, mtimeMs, "parse_error");
        skippedEntries.push({ path: filePath, reason: "parse_error", size });
        return { skipped: { reason: "parse_error" } };
      }
    },
    flush() {
      if (!dirty) return;
      if (store && typeof store.setState === "function") {
        store.setState(LEGACY_META_SCAN_LEDGER_KEY, ledger);
      }
      dirty = false;
    },
    skippedThisRun() {
      return [...skippedEntries];
    },
  };
}

// 从账本里读出当前全部被判死刑（too_large / parse_error）的文件，供 UI /诊断消费全量视图。
// migrateLegacySessions 返回的 result.skippedMetaSources 只含"本轮新观察到"的跳过事件——
// 稳态下（签名没再变化）它是空数组，驱动不了"有文件待恢复"这类持续提示；这个函数读的是
// 账本里的全集，不管是不是本轮新记的。store 没有 getState 或账本损坏时返回空数组，不 throw。
export function listSkippedMetaSources(store) {
  if (!store || typeof store.getState !== "function") return [];
  let raw = null;
  try {
    raw = store.getState(LEGACY_META_SCAN_LEDGER_KEY);
  } catch {
    return [];
  }
  const ledger = normalizeLedger(raw);
  const entries: any[] = [];
  for (const [filePath, value] of Object.entries(ledger)) {
    const entry: any = value;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.status !== "too_large" && entry.status !== "parse_error") continue;
    entries.push({
      path: filePath,
      reason: entry.status,
      size: entry.size,
      recordedAt: entry.recordedAt,
    });
  }
  return entries;
}

function hydrateSessionMetaPayloads(sessionDir, metaPath, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const hydrated: any = {};
  for (const [sessionFile, entry] of Object.entries(data) as [string, any][]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      hydrated[sessionFile] = entry;
      continue;
    }
    const next = { ...entry };
    for (const field of ["promptSnapshot", "memoryReflectionSnapshot"]) {
      const ref = next[field];
      if (
        !ref
        || typeof ref !== "object"
        || Array.isArray(ref)
        || ref.kind !== "session-meta-payload"
        || ref.field !== field
        || typeof ref.path !== "string"
      ) {
        continue;
      }
      try {
        next[field] = readJsonFileUtf8(path.join(path.dirname(metaPath), ref.path));
      } catch {
        delete next[field];
      }
    }
    hydrated[sessionFile] = next;
  }
  return hydrated;
}

function isSessionMetaBackupName(name) {
  return /^session-meta\.oversized\.\d+\.json$/.test(name)
    || /^session-meta\.json\.pre-v\d+\.bak$/.test(name);
}

function readGatedJsonRecord(gate, filePath) {
  const result = gate.readGatedJsonFile(filePath);
  const data = result && Object.prototype.hasOwnProperty.call(result, "data") ? result.data : null;
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}

function readSessionMetaSources(sessionDir, gate) {
  const sources: any[] = [];
  const currentPath = path.join(sessionDir, "session-meta.json");
  const current = readGatedJsonRecord(gate, currentPath);
  if (current) {
    sources.push({
      source: "legacy_session_meta",
      sourcePath: currentPath,
      data: hydrateSessionMetaPayloads(sessionDir, currentPath, current),
    });
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionDir).filter(isSessionMetaBackupName).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const sourcePath = path.join(sessionDir, name);
    const data = readGatedJsonRecord(gate, sourcePath);
    if (!data) continue;
    sources.push({
      source: "legacy_session_meta_backup",
      sourcePath,
      data: hydrateSessionMetaPayloads(sessionDir, sourcePath, data),
    });
  }
  return sources;
}

function listDirectories(directory) {
  try {
    return readDirectoryLikeDirentsSync(directory).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function listJsonlFiles(directory) {
  try {
    return readFileLikePathsSync(directory, { extension: ".jsonl" })
      .filter((filePath) => isSessionJsonlFilename(path.basename(filePath)))
      .sort();
  } catch {
    return [];
  }
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function storedPathWithin(root, stored, containmentRoot = root) {
  const value = text(stored);
  if (!value) return null;
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root, ...value.split(/[\\/]+/).filter(Boolean));
  if (!pathIsInside(containmentRoot, candidate)) return null;
  return candidate;
}

function jsonFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function capabilityEntry(value) {
  const source = record(value) || {};
  const entry: any = {};
  if (Array.isArray(source.toolNames)) entry.toolNames = source.toolNames;
  if (record(source.promptSnapshot)) entry.promptSnapshot = source.promptSnapshot;
  if (Object.prototype.hasOwnProperty.call(source, "capabilityDriftDismissedFingerprint")) {
    entry.capabilityDriftDismissedFingerprint = source.capabilityDriftDismissedFingerprint;
  }
  return entry;
}

function ownerAgentIdForPath(agentsDir, sessionPath) {
  const relative = path.relative(path.resolve(agentsDir), path.resolve(sessionPath));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).filter(Boolean)[0] || null;
}

function isEphemeralSessionPath(sessionPath) {
  return path.resolve(sessionPath).split(path.sep).includes(".ephemeral");
}

function sourceMetaCandidate(source, sourcePath, entry) {
  return record(entry) ? { source, sourcePath, entry: { ...entry } } : null;
}

function discoverSessionRows({ lucHome, agentsDir }) {
  const rowsByKey = new Map();
  const diagnostics: any[] = [];

  const add = (input: any) => {
    const sessionPath = text(input.sessionPath);
    if (!sessionPath || !isSessionJsonlFilename(path.basename(sessionPath))) return;
    const normalizedPath = normalizeSessionLocatorPath(sessionPath);
    if (!fs.existsSync(normalizedPath)) {
      if (input.indexed === true) {
        diagnostics.push({
          type: "missing_source_locator",
          source: input.source,
          sessionPath: normalizedPath,
          sourcePath: input.sourcePath || null,
        });
      }
      return;
    }
    const key = sessionLocatorKey(normalizedPath);
    const source = text(input.source) || "legacy_layout";
    const priority = Number.isFinite(input.priority) ? input.priority : 10;
    const candidate = sourceMetaCandidate(source, input.sourcePath || normalizedPath, input.metaEntry);
    const previous = rowsByKey.get(key);
    if (!previous) {
      rowsByKey.set(key, {
        sessionPath: normalizedPath,
        ownerAgentId: text(input.ownerAgentId),
        ownerAgentIdSource: source,
        sourceAgentId: text(input.sourceAgentId) || text(input.ownerAgentId),
        domain: input.domain || "desktop",
        kind: input.kind || "chat",
        lifecycle: input.lifecycle || "active",
        provenance: { ...(record(input.provenance) || {}) },
        metaSessionDir: input.metaSessionDir || null,
        titleSessionDir: input.titleSessionDir || null,
        metaCandidates: candidate ? [candidate] : [],
        sources: [source],
        priority,
      });
      return;
    }
    previous.sources = [...new Set([...previous.sources, source])].sort();
    if (candidate && !previous.metaCandidates.some((item) => (
      item.source === candidate.source && item.sourcePath === candidate.sourcePath
    ))) {
      previous.metaCandidates.push(candidate);
    }
    previous.provenance = {
      ...previous.provenance,
      ...(record(input.provenance) || {}),
    };
    if (!previous.metaSessionDir && input.metaSessionDir) previous.metaSessionDir = input.metaSessionDir;
    if (!previous.titleSessionDir && input.titleSessionDir) previous.titleSessionDir = input.titleSessionDir;
    if (priority >= previous.priority) {
      previous.ownerAgentId = text(input.ownerAgentId) || previous.ownerAgentId;
      previous.ownerAgentIdSource = text(input.ownerAgentId) ? source : previous.ownerAgentIdSource;
      previous.sourceAgentId = text(input.sourceAgentId) || previous.sourceAgentId;
      previous.domain = input.domain || previous.domain;
      previous.kind = input.kind || previous.kind;
      previous.lifecycle = input.lifecycle || previous.lifecycle;
      previous.priority = priority;
    }
  };

  for (const sourceAgentId of listDirectories(agentsDir)) {
    const agentDir = path.join(agentsDir, sourceAgentId);
    const sessionDir = path.join(agentDir, "sessions");
    const desktopBase = {
      ownerAgentId: sourceAgentId,
      sourceAgentId,
      domain: "desktop",
      kind: "chat",
      metaSessionDir: sessionDir,
      titleSessionDir: sessionDir,
    };
    for (const sessionPath of listJsonlFiles(sessionDir)) {
      add({ ...desktopBase, sessionPath, lifecycle: "active", source: "desktop_session_layout" });
    }
    for (const sessionPath of listJsonlFiles(path.join(sessionDir, "archived"))) {
      add({ ...desktopBase, sessionPath, lifecycle: "archived", source: "desktop_archived_layout" });
    }

    const bridgeDir = path.join(sessionDir, "bridge");
    for (const role of ["owner", "guests"]) {
      for (const sessionPath of listJsonlFiles(path.join(bridgeDir, role))) {
        const bridgeRole = role === "owner" ? "owner" : "guest";
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "bridge",
          kind: bridgeRole === "owner" ? "bridge_owner" : "bridge_guest",
          lifecycle: "active",
          source: "bridge_session_layout",
          provenance: { createdBy: "bridge", bridgeRole },
        });
      }
    }
    const bridgeIndexPath = path.join(bridgeDir, "bridge-sessions.json");
    const bridgeIndex = readJsonFile(bridgeIndexPath, {});
    for (const [bridgeSessionKey, raw] of Object.entries(record(bridgeIndex) || {})) {
      const entry: any = typeof raw === "string" ? { file: raw } : record(raw);
      const sessionPath = storedPathWithin(bridgeDir, entry?.file, bridgeDir);
      if (!sessionPath) continue;
      const root = path.relative(bridgeDir, sessionPath).split(path.sep)[0];
      const bridgeRole = entry.role === "guest" || root === "guests" ? "guest" : "owner";
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "bridge",
        kind: bridgeRole === "owner" ? "bridge_owner" : "bridge_guest",
        lifecycle: "active",
        source: "legacy_bridge_index",
        sourcePath: bridgeIndexPath,
        indexed: true,
        priority: 60,
        metaEntry: capabilityEntry(entry),
        provenance: {
          createdBy: "bridge",
          bridgeSessionKey,
          bridgeRole,
          ...(text(entry.platform) ? { platform: text(entry.platform) } : {}),
          ...(text(entry.chatType) ? { chatType: text(entry.chatType) } : {}),
        },
      });
    }

    const activityDir = path.join(agentDir, "activity");
    for (const sessionPath of listJsonlFiles(activityDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "activity",
        kind: "activity",
        lifecycle: "active",
        source: "activity_session_layout",
        metaSessionDir: sessionDir,
        provenance: { createdBy: "activity" },
      });
    }
    const activitiesPath = path.join(agentDir, "desk", "activities.json");
    const activities = readJsonFile(activitiesPath, []);
    for (const entry of Array.isArray(activities) ? activities : []) {
      const sessionPath = storedPathWithin(activityDir, entry?.sessionFile, activityDir);
      if (!sessionPath) continue;
      add({
        sessionPath,
        ownerAgentId: text(entry.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "activity",
        kind: "activity",
        lifecycle: "active",
        source: "legacy_activity_index",
        sourcePath: activitiesPath,
        indexed: true,
        priority: 60,
        metaSessionDir: sessionDir,
        provenance: {
          createdBy: "activity",
          ...(text(entry.id) ? { activityId: text(entry.id) } : {}),
          ...(text(entry.type) ? { activityType: text(entry.type) } : {}),
        },
      });
    }

    const phoneSessionsDir = path.join(agentDir, "phone", "sessions");
    for (const conversationDir of listDirectories(phoneSessionsDir)) {
      for (const sessionPath of listJsonlFiles(path.join(phoneSessionsDir, conversationDir))) {
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "phone",
          kind: "phone_conversation",
          lifecycle: "active",
          source: "phone_session_layout",
          provenance: { createdBy: "agent_phone" },
        });
      }
    }
    const phoneRuntimeDir = path.join(agentDir, "phone", "session-runtime");
    for (const runtimePath of jsonFiles(phoneRuntimeDir)) {
      const runtime: any = readJsonFile(runtimePath, null);
      if (!record(runtime)) continue;
      const sessionPath = resolveAgentPhoneStoredSessionPath(agentDir, runtime.phoneSessionFile);
      if (!sessionPath || !pathIsInside(phoneSessionsDir, sessionPath)) continue;
      add({
        sessionPath,
        ownerAgentId: text(runtime.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "phone",
        kind: "phone_conversation",
        lifecycle: "active",
        source: "legacy_phone_runtime",
        sourcePath: runtimePath,
        indexed: true,
        priority: 70,
        metaEntry: capabilityEntry(runtime),
        provenance: {
          createdBy: "agent_phone",
          ...(text(runtime.conversationId) ? { conversationId: text(runtime.conversationId) } : {}),
          ...(text(runtime.conversationType) ? { conversationType: text(runtime.conversationType) } : {}),
        },
      });
    }
    for (const projectionPath of listAgentPhoneProjectionFiles(agentDir).sort()) {
      const projection = readAgentPhoneProjection(projectionPath);
      const meta: any = record(projection?.meta);
      const sessionPath = resolveAgentPhoneStoredSessionPath(agentDir, meta?.phoneSessionFile);
      if (!sessionPath || !pathIsInside(phoneSessionsDir, sessionPath)) continue;
      add({
        sessionPath,
        ownerAgentId: text(meta.agentId) || sourceAgentId,
        sourceAgentId,
        domain: "phone",
        kind: "phone_conversation",
        lifecycle: "active",
        source: "legacy_phone_projection",
        sourcePath: projectionPath,
        indexed: true,
        priority: 65,
        metaEntry: capabilityEntry(meta),
        provenance: {
          createdBy: "agent_phone",
          ...(text(meta.conversationId) ? { conversationId: text(meta.conversationId) } : {}),
          ...(text(meta.conversationType) ? { conversationType: text(meta.conversationType) } : {}),
        },
      });
    }

    const subagentDir = path.join(agentDir, "subagent-sessions");
    for (const sessionPath of listJsonlFiles(subagentDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source: "legacy_subagent_session_layout",
        metaSessionDir: subagentDir,
        provenance: { createdBy: "subagent" },
      });
    }
    const directDir = path.join(subagentDir, "direct");
    for (const sessionPath of listJsonlFiles(directDir)) {
      add({
        sessionPath,
        ownerAgentId: sourceAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source: "subagent_session_layout",
        metaSessionDir: directDir,
        provenance: { createdBy: "subagent", threadKind: "direct" },
      });
    }

    const workflowDir = path.join(agentDir, "workflow-sessions");
    for (const runId of listDirectories(workflowDir)) {
      const runDir = path.join(workflowDir, runId);
      for (const sessionPath of listJsonlFiles(runDir)) {
        add({
          sessionPath,
          ownerAgentId: sourceAgentId,
          sourceAgentId,
          domain: "subagent",
          kind: "subagent_child",
          lifecycle: "active",
          source: "workflow_session_layout",
          metaSessionDir: runDir,
          provenance: { createdBy: "subagent", parentRunId: runId, threadKind: "workflow_node" },
        });
      }
    }
  }

  const addSubagentStoreRecords = (storePath, containerKey, source) => {
    const raw = readJsonFile(storePath, {});
    const entries = record(raw?.[containerKey]) || record(raw) || {};
    for (const [recordId, value] of Object.entries(entries)) {
      const entry: any = record(value);
      if (!entry) continue;
      const sessionPath = storedPathWithin(lucHome, entry.childSessionPath || entry.sessionPath, lucHome);
      if (!sessionPath || isEphemeralSessionPath(sessionPath)) continue;
      const sourceAgentId = ownerAgentIdForPath(agentsDir, sessionPath);
      const ownerAgentId = text(entry.executorAgentId) || text(entry.agentId) || sourceAgentId;
      const threadKind = text(entry.threadKind) || text(entry.kind);
      add({
        sessionPath,
        ownerAgentId,
        sourceAgentId,
        domain: "subagent",
        kind: "subagent_child",
        lifecycle: "active",
        source,
        sourcePath: storePath,
        indexed: true,
        priority: source === "legacy_subagent_thread_store" ? 90 : 80,
        metaEntry: entry,
        provenance: {
          createdBy: "subagent",
          ...(text(entry.parentSessionId) ? { parentSessionId: text(entry.parentSessionId) } : {}),
          ...(!text(entry.parentSessionId) && text(entry.parentSessionPath)
            ? { legacyParentSessionPath: text(entry.parentSessionPath) }
            : {}),
          ...(text(entry.parentTaskId) ? { parentRunId: text(entry.parentTaskId) } : {}),
          ...(source === "legacy_subagent_run_store" ? { subagentTaskId: recordId } : {}),
          ...(source === "legacy_subagent_thread_store" ? { threadId: recordId } : {}),
          ...(threadKind ? { threadKind } : {}),
        },
      });
    }
  };
  addSubagentStoreRecords(path.join(lucHome, "subagent-runs.json"), "runs", "legacy_subagent_run_store");
  addSubagentStoreRecords(path.join(lucHome, "subagent-threads.json"), "threads", "legacy_subagent_thread_store");

  return {
    sessions: [...rowsByKey.values()],
    diagnostics,
  };
}

export function discoverLegacySessions(opts: any = {}) {
  if (!opts.lucHome) throw new Error("discoverLegacySessions requires lucHome");
  const lucHome = path.resolve(opts.lucHome);
  const agentsDir = path.resolve(opts.agentsDir || path.join(lucHome, "agents"));
  return discoverSessionRows({ lucHome, agentsDir });
}

function hasLegacyPermissionFields(metaEntry) {
  return typeof metaEntry?.permissionMode === "string"
    || typeof metaEntry?.accessMode === "string"
    || typeof metaEntry?.planMode === "boolean";
}

function hasCapabilityFields(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    || (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object")
    || typeof metaEntry?.capabilityDriftDismissedFingerprint === "string"
    || metaEntry?.capabilityDriftDismissedFingerprint === null;
}

function hasExecutorFields(metaEntry) {
  return typeof metaEntry?.executorAgentId === "string"
    || typeof metaEntry?.agentId === "string"
    || typeof metaEntry?.executorAgentNameSnapshot === "string"
    || typeof metaEntry?.executorAgentName === "string"
    || typeof metaEntry?.agentNameSnapshot === "string"
    || typeof metaEntry?.agentName === "string";
}

function normalizeExecutorMetadata(metaEntry: any = {}) {
  const executorAgentId =
    typeof metaEntry.executorAgentId === "string" && metaEntry.executorAgentId.trim()
      ? metaEntry.executorAgentId.trim()
      : typeof metaEntry.agentId === "string" && metaEntry.agentId.trim()
        ? metaEntry.agentId.trim()
        : null;
  const executorAgentNameSnapshot =
    typeof metaEntry.executorAgentNameSnapshot === "string" && metaEntry.executorAgentNameSnapshot.trim()
      ? metaEntry.executorAgentNameSnapshot.trim()
      : typeof metaEntry.executorAgentName === "string" && metaEntry.executorAgentName.trim()
        ? metaEntry.executorAgentName.trim()
        : typeof metaEntry.agentNameSnapshot === "string" && metaEntry.agentNameSnapshot.trim()
          ? metaEntry.agentNameSnapshot.trim()
          : typeof metaEntry.agentName === "string" && metaEntry.agentName.trim()
            ? metaEntry.agentName.trim()
            : null;
  if (!executorAgentId && !executorAgentNameSnapshot) return null;
  return {
    executorAgentId,
    executorAgentNameSnapshot,
    executorMetaVersion: Number.isFinite(metaEntry.executorMetaVersion) ? metaEntry.executorMetaVersion : 1,
  };
}

function toolNameCount(metaEntry) {
  return Array.isArray(metaEntry?.toolNames)
    ? metaEntry.toolNames.filter((item) => typeof item === "string" && item).length
    : 0;
}

function capabilityScore(metaEntry) {
  if (!hasCapabilityFields(metaEntry)) return 0;
  return toolNameCount(metaEntry) * 1000
    + (metaEntry?.promptSnapshot && typeof metaEntry.promptSnapshot === "object" ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(metaEntry || {}, "capabilityDriftDismissedFingerprint") ? 10 : 0);
}

function sessionMetaCandidates(metaSources, sessionPath) {
  const sessionFile = path.basename(sessionPath);
  return (metaSources || [])
    .map((source) => {
      const entry = source?.data?.[sessionFile];
      return entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...source, entry }
        : null;
    })
    .filter(Boolean);
}

function selectBestMetaCandidate(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDelta = capabilityScore(b.entry) - capabilityScore(a.entry);
    if (scoreDelta !== 0) return scoreDelta;
    if (a.source === "legacy_session_meta" && b.source !== "legacy_session_meta") return -1;
    if (b.source === "legacy_session_meta" && a.source !== "legacy_session_meta") return 1;
    return String(b.sourcePath || "").localeCompare(String(a.sourcePath || ""));
  })[0] || null;
}

function selectPermissionCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasLegacyPermissionFields(candidate.entry)
  )) || candidates.find((candidate) => hasLegacyPermissionFields(candidate.entry)) || null;
}

function selectCapabilityCandidate(candidates) {
  return selectBestMetaCandidate(candidates.filter((candidate) => hasCapabilityFields(candidate.entry)));
}

function selectExecutorCandidate(candidates) {
  return candidates.find((candidate) => (
    candidate.source === "legacy_session_meta"
    && hasExecutorFields(candidate.entry)
  )) || candidates.find((candidate) => hasExecutorFields(candidate.entry)) || null;
}

function legacyMemoryPolicy(metaEntry) {
  if (metaEntry?.memoryEnabled === true) {
    return { mode: "enabled", inheritedFrom: "legacy_session_meta" };
  }
  if (metaEntry?.memoryEnabled === false) {
    return { mode: "disabled", inheritedFrom: "legacy_session_meta" };
  }
  return { mode: "inherit", inheritedFrom: "agent_default" };
}

function legacyWorkspaceScope(metaEntry) {
  const workspaceScope: any = {};
  if (Array.isArray(metaEntry?.workspaceFolders)) {
    workspaceScope.workspaceFolders = metaEntry.workspaceFolders.filter((item) => typeof item === "string");
  }
  if (Array.isArray(metaEntry?.authorizedFolders)) {
    workspaceScope.authorizedFolders = metaEntry.authorizedFolders.filter((item) => typeof item === "string");
  }
  if (typeof metaEntry?.primaryCwd === "string") {
    workspaceScope.primaryCwd = metaEntry.primaryCwd;
  }
  const mountId = typeof metaEntry?.workspaceMountId === "string"
    ? metaEntry.workspaceMountId
    : (typeof metaEntry?.mountId === "string" ? metaEntry.mountId : null);
  if (mountId) {
    workspaceScope.workspaceMount = {
      mountId,
      ...(typeof metaEntry?.workspaceLabel === "string" ? { label: metaEntry.workspaceLabel } : {}),
    };
  }
  return workspaceScope;
}

function legacyPlugin(metaEntry) {
  const plugin = metaEntry?.plugin && typeof metaEntry.plugin === "object" ? metaEntry.plugin : null;
  if (!plugin) return null;
  return {
    ownerPluginId: typeof plugin.ownerPluginId === "string" ? plugin.ownerPluginId : null,
    kind: typeof plugin.kind === "string" ? plugin.kind : null,
    visibility: typeof plugin.visibility === "string" ? plugin.visibility : "public",
  };
}

function legacyTitleFor(titles, sessionDir, sessionPath) {
  const activePath = path.join(sessionDir, path.basename(sessionPath));
  return titles[sessionPath] || titles[activePath] || titles[path.basename(sessionPath)] || null;
}

function backfillLegacyTitleSessionIdKey(titlesPath, titles, sessionDir, sessionPath, manifest) {
  if (!manifest?.sessionId || !titles || typeof titles !== "object" || Array.isArray(titles)) return;
  if (titles[manifest.sessionId]) return;
  const title = manifest.provenance?.legacyTitle || legacyTitleFor(titles, sessionDir, sessionPath);
  if (typeof title !== "string" || !title.trim()) return;
  titles[manifest.sessionId] = title;
  try {
    fs.writeFileSync(titlesPath, JSON.stringify(titles, null, 2));
  } catch {
    delete titles[manifest.sessionId];
  }
}

function buildLegacyManifestInput({ row, candidates, titles, migratedAt }) {
  const sessionPath = row.sessionPath;
  const sessionDir = row.titleSessionDir || row.metaSessionDir || path.dirname(sessionPath);
  const bestCandidate = selectBestMetaCandidate(candidates);
  const permissionCandidate = selectPermissionCandidate(candidates);
  const metaEntry = bestCandidate?.entry || {};
  const permissionEntry = permissionCandidate?.entry || metaEntry;
  const plugin = legacyPlugin(metaEntry);
  const permissionHasLegacySource = hasLegacyPermissionFields(permissionEntry);
  return {
    sessionPath,
    ownerAgentId: row.ownerAgentId,
    domain: row.domain,
    kind: row.domain === "desktop" ? (plugin?.kind || row.kind || "chat") : row.kind,
    lifecycle: row.lifecycle,
    memoryPolicy: legacyMemoryPolicy(metaEntry),
    permissionModeSnapshot: {
      mode: normalizeSessionPermissionMode(permissionEntry),
      source: permissionHasLegacySource ? permissionCandidate.source : "migration_default",
      capturedAt: migratedAt,
    },
    thinkingLevel: typeof metaEntry?.thinkingLevel === "string" ? metaEntry.thinkingLevel : null,
    pinnedAt: typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null,
    workspaceScope: legacyWorkspaceScope(metaEntry),
    plugin,
    provenance: {
      legacyAgentId: row.sourceAgentId || row.ownerAgentId,
      legacyLifecycle: row.lifecycle,
      legacyTitle: legacyTitleFor(titles, sessionDir, sessionPath),
      ...(record(row.provenance) || {}),
    },
    migration: {
      legacySessionPath: sessionPath,
      legacySessionFileName: path.basename(sessionPath),
      source: "legacy_scan",
      migratedAt,
      legacySources: [...(row.sources || [])].sort(),
    },
    locatorReason: "legacy_scan",
  };
}

function capabilitySnapshotFromCandidate(candidate) {
  const entry = candidate?.entry;
  if (!entry || !hasCapabilityFields(entry)) return null;
  const snapshot: any = {};
  if (Array.isArray(entry.toolNames)) {
    const seen = new Set();
    snapshot.toolNames = entry.toolNames.filter((item) => {
      if (typeof item !== "string" || !item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }
  if (entry.promptSnapshot && typeof entry.promptSnapshot === "object" && !Array.isArray(entry.promptSnapshot)) {
    snapshot.promptSnapshot = entry.promptSnapshot;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "capabilityDriftDismissedFingerprint")) {
    snapshot.capabilityDriftDismissedFingerprint =
      typeof entry.capabilityDriftDismissedFingerprint === "string"
        ? entry.capabilityDriftDismissedFingerprint
        : null;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function shouldReplaceCapabilitySnapshot(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  if (!existingSource.startsWith("legacy_session_meta")) return false;
  const existingScore = (Array.isArray(existing.toolNames) ? existing.toolNames.length : 0) * 1000
    + (existing.promptSnapshot ? 100 : 0)
    + (Object.prototype.hasOwnProperty.call(existing, "capabilityDriftDismissedFingerprint") ? 10 : 0);
  return capabilityScore(candidate.entry) > existingScore;
}

function importLegacyCapabilitySnapshot(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getCapabilitySnapshot !== "function" || typeof store.setCapabilitySnapshot !== "function") {
    return;
  }
  const candidate = selectCapabilityCandidate(candidates);
  if (!candidate) return;
  const existing = store.getCapabilitySnapshot(manifest.sessionId);
  if (!shouldReplaceCapabilitySnapshot(existing, candidate)) return;
  const snapshot = capabilitySnapshotFromCandidate(candidate);
  if (!snapshot) return;
  store.setCapabilitySnapshot(manifest.sessionId, snapshot, { source: candidate.source });
}

function shouldReplaceExecutorMetadata(existing, candidate) {
  if (!candidate) return false;
  if (!existing) return true;
  const existingSource = existing.source || "";
  return existingSource.startsWith("legacy_session_meta");
}

function importLegacyExecutorMetadata(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.getExecutorMetadata !== "function" || typeof store.setExecutorMetadata !== "function") {
    return;
  }
  const candidate = selectExecutorCandidate(candidates);
  if (!candidate) return;
  const existing = store.getExecutorMetadata(manifest.sessionId);
  if (!shouldReplaceExecutorMetadata(existing, candidate)) return;
  const metadata = normalizeExecutorMetadata(candidate.entry);
  if (!metadata) return;
  store.setExecutorMetadata(manifest.sessionId, metadata, { source: candidate.source });
}

function repairPermissionSnapshotFromLegacyMeta(store, manifest, candidates) {
  if (!manifest?.sessionId || typeof store.setPermissionModeSnapshot !== "function") return manifest;
  if (manifest.permissionModeSnapshot?.source !== "migration_default") return manifest;
  const candidate = selectPermissionCandidate(candidates);
  if (!candidate) return manifest;
  return store.setPermissionModeSnapshot(manifest.sessionId, {
    mode: normalizeSessionPermissionMode(candidate.entry),
    source: candidate.source,
  });
}

function repairExistingLocatorIfNeeded(store, existing, sessionPath) {
  if (!existing?.sessionId) return existing;
  const expectedPath = normalizeSessionLocatorPath(sessionPath);
  if (existing.currentLocator?.path === expectedPath) return existing;
  return store.updateLocator(existing.sessionId, sessionPath, "legacy_scan_repair");
}

function createLegacyRowReader(gate) {
  const metaSourcesByDir = new Map();
  const titlesByDir = new Map();
  return {
    candidates(row) {
      let candidates: any[] = [];
      if (row.metaSessionDir) {
        if (!metaSourcesByDir.has(row.metaSessionDir)) {
          metaSourcesByDir.set(row.metaSessionDir, readSessionMetaSources(row.metaSessionDir, gate));
        }
        candidates = sessionMetaCandidates(metaSourcesByDir.get(row.metaSessionDir), row.sessionPath);
      }
      return [...candidates, ...(row.metaCandidates || [])];
    },
    titleState(row) {
      if (!row.titleSessionDir) return { titlesPath: null, titles: {} };
      if (!titlesByDir.has(row.titleSessionDir)) {
        const titlesPath = path.join(row.titleSessionDir, "session-titles.json");
        titlesByDir.set(row.titleSessionDir, {
          titlesPath,
          titles: readGatedJsonRecord(gate, titlesPath) || {},
        });
      }
      return titlesByDir.get(row.titleSessionDir);
    },
  };
}

function expectedManifestInput(row, reader, migratedAt) {
  const candidates = reader.candidates(row);
  const { titles } = reader.titleState(row);
  return {
    candidates,
    input: buildLegacyManifestInput({ row, candidates, titles, migratedAt }),
  };
}

export function auditLegacySessionManifests(opts: any = {}) {
  if (!opts.lucHome) throw new Error("auditLegacySessionManifests requires lucHome");
  if (!opts.store) throw new Error("auditLegacySessionManifests requires store");

  const discovery = discoverLegacySessions(opts);
  const auditGate = createMetaSourceGate({
    store: opts.store,
    maxBytes: Number.isFinite(opts.metaSourceMaxBytes) ? opts.metaSourceMaxBytes : undefined,
  });
  const reader = createLegacyRowReader(auditGate);
  const details: any = {
    missing: [],
    missingLocators: [],
    domainMismatches: [],
    ownerMismatches: [],
    lifecycleMismatches: [],
    discoveryWarnings: [...discovery.diagnostics],
  };
  let manifested = 0;

  for (const row of discovery.sessions) {
    let manifest = null;
    try {
      manifest = opts.store.resolveByLocatorPath(row.sessionPath);
    } catch (error) {
      details.missing.push({
        sessionPath: row.sessionPath,
        expectedDomain: row.domain,
        expectedKind: row.kind,
        error: error?.message || String(error),
      });
      continue;
    }
    const { input } = expectedManifestInput(row, reader, opts.scannedAt || new Date().toISOString());
    if (!manifest) {
      details.missing.push({
        sessionPath: row.sessionPath,
        expectedDomain: input.domain,
        expectedKind: input.kind,
        ownerAgentId: input.ownerAgentId || null,
        sources: [...(row.sources || [])],
      });
      continue;
    }
    manifested += 1;
    if (manifest.domain !== input.domain || manifest.kind !== input.kind) {
      details.domainMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualDomain: manifest.domain,
        actualKind: manifest.kind,
        expectedDomain: input.domain,
        expectedKind: input.kind,
        sources: [...(row.sources || [])],
      });
    }
    if (input.ownerAgentId && manifest.ownerAgentId !== input.ownerAgentId) {
      details.ownerMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualOwnerAgentId: manifest.ownerAgentId || null,
        expectedOwnerAgentId: input.ownerAgentId,
        sources: [...(row.sources || [])],
      });
    }
    if (manifest.lifecycle !== input.lifecycle) {
      details.lifecycleMismatches.push({
        sessionId: manifest.sessionId,
        sessionPath: row.sessionPath,
        actualLifecycle: manifest.lifecycle,
        expectedLifecycle: input.lifecycle,
        sources: [...(row.sources || [])],
      });
    }
  }

  const missingLocatorKeys = new Set();
  for (const manifest of opts.store.list?.() || []) {
    const sessionPath = manifest?.currentLocator?.path || null;
    if (!LOCATOR_REQUIRED_LIFECYCLES.has(manifest?.lifecycle)) continue;
    if (!sessionPath || fs.existsSync(sessionPath)) continue;
    const key = sessionLocatorKey(sessionPath);
    if (missingLocatorKeys.has(key)) continue;
    missingLocatorKeys.add(key);
    details.missingLocators.push({
      sessionId: manifest.sessionId || null,
      sessionPath,
      domain: manifest.domain || null,
      kind: manifest.kind || null,
      source: "manifest_current_locator",
    });
  }
  for (const warning of discovery.diagnostics) {
    if (warning.type !== "missing_source_locator") continue;
    const key = sessionLocatorKey(warning.sessionPath);
    if (missingLocatorKeys.has(key)) continue;
    missingLocatorKeys.add(key);
    details.missingLocators.push({
      sessionId: null,
      sessionPath: warning.sessionPath,
      source: warning.source,
      sourcePath: warning.sourcePath || null,
    });
  }

  auditGate.flush();

  return {
    discovered: discovery.sessions.length,
    manifested,
    missing: details.missing.length,
    missingLocator: details.missingLocators.length,
    domainMismatch: details.domainMismatches.length,
    ownerMismatch: details.ownerMismatches.length,
    lifecycleMismatch: details.lifecycleMismatches.length,
    details,
  };
}

export function migrateLegacySessions(opts: any = {}) {
  if (!opts.lucHome) throw new Error("migrateLegacySessions requires lucHome");
  if (!opts.store) throw new Error("migrateLegacySessions requires store");

  const lucHome = path.resolve(opts.lucHome);
  const migratedAt = opts.migratedAt || new Date().toISOString();
  const result: any = { scanned: 0, created: 0, existing: 0, skipped: 0, skippedDetails: [] };
  const discovery = discoverLegacySessions({
    lucHome,
    ...(opts.agentsDir ? { agentsDir: opts.agentsDir } : {}),
  });
  const gate = createMetaSourceGate({
    store: opts.store,
    maxBytes: Number.isFinite(opts.metaSourceMaxBytes) ? opts.metaSourceMaxBytes : undefined,
  });
  const reader = createLegacyRowReader(gate);

  for (const row of discovery.sessions) {
    result.scanned += 1;
    try {
      const { candidates, input } = expectedManifestInput(row, reader, migratedAt);
      const titleState = reader.titleState(row);
      let existing = opts.store.resolveByLocatorPath(row.sessionPath);
      if (existing) {
        existing = repairExistingLocatorIfNeeded(opts.store, existing, row.sessionPath);
        if (!existing.ownerAgentId && typeof opts.store.backfillOwnerAgentId === "function") {
          existing = opts.store.backfillOwnerAgentId(existing.sessionId, input.ownerAgentId);
        }
        if (typeof opts.store.repairLegacyScanMetadata === "function") {
          existing = opts.store.repairLegacyScanMetadata(existing.sessionId, {
            ownerAgentId: input.ownerAgentId,
            ownerAgentIdSource: row.ownerAgentIdSource,
            domain: input.domain,
            kind: input.kind,
            provenance: input.provenance,
            migration: input.migration,
          });
        }
        if (
          existing?.migration?.source === "legacy_scan"
          && existing.lifecycle !== input.lifecycle
          && typeof opts.store.updateLocatorLifecycle === "function"
        ) {
          existing = opts.store.updateLocatorLifecycle(
            existing.sessionId,
            row.sessionPath,
            input.lifecycle,
            "legacy_scan_lifecycle_repair",
            { domain: existing.domain, kind: existing.kind },
          );
        }
        const permissionRepaired = repairPermissionSnapshotFromLegacyMeta(opts.store, existing, candidates);
        const settled = permissionRepaired || existing;
        importLegacyCapabilitySnapshot(opts.store, settled, candidates);
        importLegacyExecutorMetadata(opts.store, settled, candidates);
        if (titleState.titlesPath) {
          backfillLegacyTitleSessionIdKey(
            titleState.titlesPath,
            titleState.titles,
            row.titleSessionDir,
            row.sessionPath,
            settled,
          );
        }
        result.existing += 1;
        continue;
      }

      const manifest = opts.store.createForPath(input);
      importLegacyCapabilitySnapshot(opts.store, manifest, candidates);
      importLegacyExecutorMetadata(opts.store, manifest, candidates);
      if (titleState.titlesPath) {
        backfillLegacyTitleSessionIdKey(
          titleState.titlesPath,
          titleState.titles,
          row.titleSessionDir,
          row.sessionPath,
          manifest,
        );
      }
      result.created += 1;
    } catch (error) {
      if (opts.stopOnError === true) throw error;
      result.skipped += 1;
      if (result.skippedDetails.length < MAX_SKIPPED_DETAILS) {
        result.skippedDetails.push({
          sessionPath: row.sessionPath,
          error: error?.message || String(error),
        });
      }
    }
  }

  gate.flush();
  // 本字段只含本轮新观察到的跳过事件（too_large / parse_error）；稳态下（签名没再变化）
  // 它是空数组，不能拿来驱动"有文件待恢复"之类的持续提示。要读账本里的全集用 listSkippedMetaSources。
  const skippedMetaSources = gate.skippedThisRun();
  result.skippedMetaSources = skippedMetaSources;
  for (const item of skippedMetaSources) {
    result.skippedDetails.push({
      type: "meta_source_skipped",
      sourcePath: item.path,
      reason: item.reason,
    });
  }

  return result;
}
