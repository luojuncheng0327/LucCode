/**
 * Agent Phone Runtime
 *
 * Stores reusable phone-session runtime state outside the projection document.
 * Projection remains a human-readable view; this sidecar owns session reuse.
 */

import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { safeConversationStem } from "./agent-phone-projection.ts";

export function getAgentPhoneRuntimePath(agentDir, conversationId) {
  return path.join(agentDir, "phone", "session-runtime", `${safeConversationStem(conversationId)}.json`);
}

export function readAgentPhoneRuntime(agentDir, conversationId) {
  const filePath = getAgentPhoneRuntimePath(agentDir, conversationId);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveAgentPhoneRuntimeSessionPath(agentDir, runtime: Record<string, any> = {}) {
  const stored = runtime?.phoneSessionFile;
  if (!stored || typeof stored !== "string") return null;
  const resolved = path.resolve(agentDir, ...stored.split("/").filter(Boolean));
  const base = path.resolve(agentDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function writeRuntimeFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fsp.rename(tmp, filePath);
}

export async function updateAgentPhoneRuntime({
  agentDir,
  agentId,
  conversationId,
  conversationType,
  patch,
  timestamp = new Date().toISOString(),
}) {
  if (!agentDir) throw new Error("agentDir is required");
  if (!agentId) throw new Error("agentId is required");
  if (!conversationId) throw new Error("conversationId is required");
  if (!conversationType) throw new Error("conversationType is required");

  const filePath = getAgentPhoneRuntimePath(agentDir, conversationId);
  const existing = readAgentPhoneRuntime(agentDir, conversationId);
  const next = {
    ...existing,
    agentId,
    conversationId,
    conversationType,
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: timestamp,
  };
  delete next.toolNames;
  await writeRuntimeFile(filePath, next);
  return filePath;
}

export async function resetAgentPhoneRuntime({ agentDir, conversationId }) {
  const filePath = getAgentPhoneRuntimePath(agentDir, conversationId);
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
