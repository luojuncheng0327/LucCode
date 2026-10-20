import fs from "fs";
import os from "os";
import path from "path";
import { canonicalFilesystemPathSync, filesystemIdentityKeySync } from "../../shared/link-aware-fs.ts";

export function collectBridgeMediaAllowedRoots(engine, { agentId = null, agent = null } = {}) {
  const roots = [];
  const add = (root) => {
    const normalized = normalizeBridgeMediaRoot(root);
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  };

  add(engine?.luccodeHome);

  const targetAgent = agent || resolveAgent(engine, agentId);
  addAgentHome(targetAgent, add);
  if (agentId) add(safeCall(() => engine?.getHomeCwd?.(agentId)));

  for (const entry of agentValues(safeCall(() => engine?.getAgents?.()))) {
    addAgentHome(entry, add);
    if (entry?.id) add(safeCall(() => engine?.getHomeCwd?.(entry.id)));
  }

  add(safeCall(() => os.homedir()));
  for (const tempRoot of collectSystemTempRoots()) add(tempRoot);

  return roots;
}

export function isInsideBridgeMediaRoot(candidatePath, roots) {
  if (!candidatePath) return false;
  // 包含检查是比较，两侧都走身份键：调用方传进来的 root 未必已经归一过，
  // 大小写不敏感的平台上还得把拼写差异折平。
  const candidate = filesystemIdentityKeySync(candidatePath);
  return (roots || []).some((root) => root && isInsideRoot(candidate, filesystemIdentityKeySync(root)));
}

function resolveAgent(engine, agentId) {
  if (agentId && typeof engine?.getAgent === "function") {
    return safeCall(() => engine.getAgent(agentId));
  }
  return engine?.agent || null;
}

function addAgentHome(agent, add) {
  add(agent?.config?.desk?.home_folder);
}

function agentValues(raw) {
  if (!raw) return [];
  if (raw instanceof Map) return Array.from(raw.values());
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return Object.values(raw);
  return [];
}

function normalizeBridgeMediaRoot(root) {
  if (typeof root !== "string" || !root.trim()) return null;
  // 这个值会被存进 roots 列表并当成真实路径使用，所以要 canonical、不能折大小写。
  const normalized = canonicalFilesystemPathSync(root);
  if (!path.isAbsolute(normalized)) return null;
  if (normalized === path.parse(normalized).root) return null;
  return normalized;
}

function collectSystemTempRoots() {
  const roots = [safeCall(() => os.tmpdir())];
  if (process.platform !== "win32" && fs.existsSync("/tmp")) {
    roots.push("/tmp");
  }
  return roots;
}

/** 两侧都必须是同一种归一形式（身份键或 canonical），否则比较没有意义。 */
function isInsideRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeCall(fn) {
  try { return fn(); }
  catch { return null; }
}
