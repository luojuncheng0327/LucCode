import { normalizeWorkspacePath } from "./workspace-history.ts";
import { normalizePreviewReadingPosition } from "./preview-reading-position.ts";

const MAX_WORKSPACES = 50;
const MAX_PATHS = 256;
const MAX_TABS = 32;
const MAX_STRING = 1024;
const WORKSPACE_UI_STATE_VERSION = 2;

export const WORKSPACE_UI_SURFACES = Object.freeze(["electron", "pwa"]);
export const DEFAULT_WORKSPACE_UI_SURFACE = "electron";

const WORKSPACE_UI_SURFACE_SET = new Set(WORKSPACE_UI_SURFACES);

function cleanString(value, max = MAX_STRING) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function normalizeRelativePath(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  const slashed = raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!slashed || slashed === "." || slashed === "..") return "";
  const parts = slashed.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) return "";
  return parts.join("/");
}

function normalizePreviewSourceRootPath(value) {
  const root = normalizeWorkspacePath(value) || "";
  if (!root) return "";
  if (root.startsWith("/") || root.startsWith("//") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("studio:")) {
    return root;
  }
  return "";
}

function uniqueRelativePaths(values, limit = MAX_PATHS) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRelativePath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePreviewTab(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  if (!id) return null;
  const filePath = normalizeWorkspacePath(raw.filePath) || "";
  const relativePath = normalizeRelativePath(raw.relativePath);
  const sourceRootPath = normalizePreviewSourceRootPath(raw.sourceRootPath);
  const readingPosition = normalizePreviewReadingPosition(raw.readingPosition);
  if (!filePath && !relativePath) return null;
  return {
    id,
    ...(filePath ? { filePath } : {}),
    ...(relativePath ? { relativePath } : {}),
    title: cleanString(raw.title, 256),
    type: cleanString(raw.type, 64) || "file-info",
    ext: cleanString(raw.ext, 32).toLowerCase(),
    language: cleanString(raw.language, 64) || null,
    ...(sourceRootPath ? { sourceRootPath } : {}),
    ...(readingPosition ? { readingPosition } : {}),
  };
}

export function normalizeWorkspaceUiSurface(value, fallback = DEFAULT_WORKSPACE_UI_SURFACE) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return fallback;
  return WORKSPACE_UI_SURFACE_SET.has(raw) ? raw : null;
}

function normalizeRightWorkspaceTab(value) {
  const raw = cleanString(value, 128);
  if (raw === "session-files" || raw === "workspace") return raw;
  if (raw.startsWith("plugin-widget:")) return raw;
  return "workspace";
}

export function normalizeWorkspaceUiEntry(raw: Record<string, any> = {}, { now = () => Date.now() }: Record<string, any> = {}) {
  const previewTabs = [];
  const seenTabs = new Set();
  for (const item of Array.isArray(raw.previewTabs) ? raw.previewTabs : []) {
    const tab = normalizePreviewTab(item);
    if (!tab || seenTabs.has(tab.id)) continue;
    seenTabs.add(tab.id);
    previewTabs.push(tab);
    if (previewTabs.length >= MAX_TABS) break;
  }

  const tabIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = [];
  for (const rawId of Array.isArray(raw.openTabs) ? raw.openTabs : []) {
    const id = cleanString(rawId);
    if (!id || !tabIds.has(id) || openTabs.includes(id)) continue;
    openTabs.push(id);
    if (openTabs.length >= MAX_TABS) break;
  }
  if (openTabs.length === 0 && previewTabs.length > 0) {
    openTabs.push(previewTabs[0].id);
  }

  const requestedActive = cleanString(raw.activeTabId);
  const activeTabId = openTabs.includes(requestedActive)
    ? requestedActive
    : (openTabs[0] || null);

  return {
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now(),
    deskCurrentPath: normalizeRelativePath(raw.deskCurrentPath),
    deskExpandedPaths: uniqueRelativePaths(raw.deskExpandedPaths),
    deskSelectedPath: normalizeRelativePath(raw.deskSelectedPath),
    rightWorkspaceTab: normalizeRightWorkspaceTab(raw.rightWorkspaceTab),
    jianView: cleanString(raw.jianView, 128) || "desk",
    jianDrawerOpen: raw.jianDrawerOpen === true,
    previewOpen: raw.previewOpen === true,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

function normalizeWorkspaceUiRecord(rawEntry: Record<string, any> = {}, opts: Record<string, any> = {}) {
  const source: Record<string, any> = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  const surfaces: Record<string, any> = {};

  if (source.surfaces && typeof source.surfaces === "object") {
    for (const surface of WORKSPACE_UI_SURFACES) {
      if (!source.surfaces[surface]) continue;
      surfaces[surface] = normalizeWorkspaceUiEntry(source.surfaces[surface], opts);
    }
  } else {
    const entry = normalizeWorkspaceUiEntry(source, opts);
    const hasLegacyState = entry.deskCurrentPath
      || entry.deskExpandedPaths.length > 0
      || entry.deskSelectedPath
      || entry.previewTabs.length > 0
      || entry.previewOpen
      || entry.jianDrawerOpen
      || entry.rightWorkspaceTab !== "workspace"
      || entry.jianView !== "desk"
      || Number.isFinite(source.updatedAt);
    if (hasLegacyState) {
      surfaces[DEFAULT_WORKSPACE_UI_SURFACE] = entry;
    }
  }

  const surfaceEntries: any[] = Object.values(surfaces);
  const updatedAt = surfaceEntries.reduce((max: number, entry: any) => Math.max(max, entry.updatedAt || 0), 0);
  return {
    updatedAt: updatedAt || (Number.isFinite(source.updatedAt) ? source.updatedAt : opts.now?.() || Date.now()),
    surfaces,
  };
}

export function normalizeWorkspaceUiState(raw: Record<string, any> = {}, opts: Record<string, any> = {}) {
  const source: Record<string, any> = raw && typeof raw === "object" ? raw : {};
  const entries = Object.entries(source.workspaces || {})
    .map(([workspace, entry]) => [normalizeWorkspacePath(workspace), entry])
    .filter(([workspace]) => !!workspace)
    .map(([workspace, entry]) => [workspace, normalizeWorkspaceUiRecord(entry, opts)])
    .sort((a: any, b: any) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, MAX_WORKSPACES);
  return {
    version: WORKSPACE_UI_STATE_VERSION,
    workspaces: Object.fromEntries(entries),
  };
}

export function getWorkspaceUiStateEntry(raw, workspaceRoot, opts: Record<string, any> = {}) {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  const surface = normalizeWorkspaceUiSurface(opts.surface);
  if (!workspace || !surface) return null;
  const state = normalizeWorkspaceUiState(raw, opts);
  const entry = state.workspaces[workspace]?.surfaces?.[surface] || null;
  return entry ? structuredClone(entry) : null;
}

export function upsertWorkspaceUiState(raw, workspaceRoot, entry, opts: Record<string, any> = {}) {
  const workspace = normalizeWorkspacePath(workspaceRoot);
  if (!workspace) return normalizeWorkspaceUiState(raw, opts);
  const surface = normalizeWorkspaceUiSurface(opts.surface);
  if (!surface) return normalizeWorkspaceUiState(raw, opts);
  const state = normalizeWorkspaceUiState(raw, opts);
  const record = state.workspaces[workspace] || { updatedAt: 0, surfaces: {} };
  const normalizedEntry = normalizeWorkspaceUiEntry(entry, opts);
  record.surfaces = { ...(record.surfaces || {}), [surface]: normalizedEntry };
  record.updatedAt = Math.max(
    normalizedEntry.updatedAt || 0,
    ...Object.values(record.surfaces).map((item: any) => item?.updatedAt || 0),
  );
  state.workspaces[workspace] = record;
  return normalizeWorkspaceUiState(state, opts);
}
