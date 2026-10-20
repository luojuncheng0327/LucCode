import fs from "fs";
import path from "path";

const YUAN_KEY_RE = /^[A-Za-z0-9_-]+$/;

export function normalizeYuanKey(value) {
  if (value === undefined || value === null || value === "") return "luc";
  if (typeof value !== "string") {
    throw new Error(`Invalid yuan ${JSON.stringify(value)}: expected string`);
  }
  const key = value.trim();
  if (!key || !YUAN_KEY_RE.test(key)) {
    throw new Error(`Invalid yuan "${value}": expected a template key`);
  }
  return key;
}

export function listYuanKeys(productDir) {
  const yuanDir = path.join(productDir, "yuan");
  const keys = new Set();
  const readDir = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        keys.add(path.basename(entry.name, ".md"));
      }
    }
  };

  readDir(yuanDir);
  readDir(path.join(yuanDir, "en"));
  return [...keys].sort();
}

export function isKnownYuan(productDir, value) {
  let key;
  try {
    key = normalizeYuanKey(value);
  } catch {
    return false;
  }
  return listYuanKeys(productDir).includes(key);
}

export function assertKnownYuan(productDir, value) {
  const key = normalizeYuanKey(value);
  if (!isKnownYuan(productDir, key)) {
    const err = new Error(`Invalid yuan "${key}": template not found in lib/yuan`) as Error & { code: string; statusCode: number };
    err.code = "INVALID_YUAN";
    err.statusCode = 400;
    throw err;
  }
  return key;
}

export function getAgentConfigRepairState(config, productDir) {
  const value = config?.agent?.yuan || "luc";
  try {
    const key = normalizeYuanKey(value);
    if (isKnownYuan(productDir, key)) return null;
    return {
      needsRepair: true,
      reason: "invalid_yuan",
      field: "agent.yuan",
      value: key,
      message: `Invalid yuan "${key}": template not found in lib/yuan`,
    };
  } catch (err) {
    return {
      needsRepair: true,
      reason: "invalid_yuan",
      field: "agent.yuan",
      value,
      message: err.message,
    };
  }
}

export function assertAgentConfigPatchYuan(productDir, partial) {
  if (!partial?.agent || !Object.prototype.hasOwnProperty.call(partial.agent, "yuan")) {
    return null;
  }
  return assertKnownYuan(productDir, partial.agent.yuan);
}
