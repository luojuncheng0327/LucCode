
import fs from "fs";
import { mergeWorkspaceHistory, normalizeWorkspacePath } from "./workspace-history.ts";
import { normalizeWorkspaceUiState } from "./workspace-ui-state.ts";

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

export function classifyWorkspacePathForGc(value, { statSync = fs.statSync } = {}) {
  const workspace = normalizeWorkspacePath(value);
  if (!workspace) return { path: null, status: "invalid", errorCode: null };
  try {
    statSync(workspace);
    return { path: workspace, status: "present", errorCode: null };
  } catch (err) {
    const errorCode = typeof err?.code === "string" ? err.code : null;
    return {
      path: workspace,
      status: MISSING_PATH_CODES.has(errorCode) ? "missing" : "unknown",
      errorCode,
    };
  }
}

export function pruneMissingWorkspaceConfig(config: Record<string, any> = {}, options: Record<string, any> = {}) {
  const patch: Record<string, any> = {};

  if (Array.isArray(config.cwd_history)) {
    const current = mergeWorkspaceHistory(config.cwd_history, []);
    const cwdHistory = current.filter((item) => classifyWorkspacePathForGc(item, options).status !== "missing");
    if (!sameArray(current, cwdHistory)) {
      patch.cwd_history = cwdHistory;
    }
  }

  const lastCwd = normalizeWorkspacePath(config.last_cwd);
  if (lastCwd && classifyWorkspacePathForGc(lastCwd, options).status === "missing") {
    patch.last_cwd = null;
  }

  const homeFolder = normalizeWorkspacePath(config.desk?.home_folder);
  if (homeFolder && classifyWorkspacePathForGc(homeFolder, options).status === "missing") {
    patch.desk = { ...(patch.desk || {}), home_folder: null };
  }

  return {
    changed: Object.keys(patch).length > 0,
    patch,
  };
}

export function pruneMissingWorkspaceUiState(raw = {}, options = {}) {
  const state = normalizeWorkspaceUiState(raw, options);
  const workspaces = {};
  for (const [workspace, record] of Object.entries(state.workspaces || {})) {
    if (classifyWorkspacePathForGc(workspace, options).status === "missing") continue;
    workspaces[workspace] = record;
  }
  const next = normalizeWorkspaceUiState({ ...state, workspaces }, options);
  return {
    changed: JSON.stringify(next) !== JSON.stringify(state),
    state: next,
  };
}

function sameArray(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
