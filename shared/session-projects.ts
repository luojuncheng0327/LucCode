import { normalizeWorkspacePath, workspaceDisplayName } from "./workspace-history.ts";

export const SESSION_PROJECTS_VERSION = 1;
export const SESSION_PROJECTS_FILENAME = "session-projects.json";
export const UNCATEGORIZED_PROJECT_ID = "cwd:";

export interface SessionProjectRecord {
  id: string;
  name: string;
  folderId: string | null;
  order: number;
}

export interface SessionProjectFolderRecord {
  id: string;
  name: string;
  order: number;
}

export interface SessionProjectCatalogRecord {
  folders: SessionProjectFolderRecord[];
  projects: SessionProjectRecord[];
}

const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 240;

export function normalizeProjectName(value: unknown, fallback: string = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return fallback;
  return [...trimmed].slice(0, MAX_NAME_LENGTH).join("");
}

export function normalizeSessionProjectId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null;
  return trimmed;
}

export function autoProjectIdForCwd(cwd: unknown): string {
  const normalized = normalizeWorkspacePath(cwd);
  if (!normalized) return UNCATEGORIZED_PROJECT_ID;
  return `cwd:${encodeURIComponent(normalized)}`;
}

export function isAutoProjectId(projectId: unknown): boolean {
  return typeof projectId === "string" && projectId.startsWith("cwd:");
}

export function cwdFromAutoProjectId(projectId: unknown): string | null {
  if (!isAutoProjectId(projectId)) return null;
  const encoded = (projectId as string).slice(4);
  if (!encoded) return null;
  try {
    return normalizeWorkspacePath(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

export function autoProjectNameForCwd(cwd: unknown, fallback: string = "未指定项目"): string {
  return workspaceDisplayName(cwd, fallback) || fallback;
}

export function normalizeSessionProjectCatalog(input: unknown = {}): SessionProjectCatalogRecord {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawFolders = Array.isArray(source.folders) ? source.folders : [];
  const folders: SessionProjectFolderRecord[] = [];
  const folderIds = new Set<string>();
  for (const [index, raw] of rawFolders.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = normalizeSessionProjectId(entry.id);
    const name = normalizeProjectName(entry.name);
    if (!id || !name || folderIds.has(id)) continue;
    folderIds.add(id);
    folders.push({
      id,
      name,
      order: finiteOrder(entry.order, index),
    });
  }

  const rawProjects = Array.isArray(source.projects) ? source.projects : [];
  const projects: SessionProjectRecord[] = [];
  const projectIds = new Set<string>();
  for (const [index, raw] of rawProjects.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = normalizeSessionProjectId(entry.id);
    const name = normalizeProjectName(entry.name);
    if (!id || !name || projectIds.has(id)) continue;
    const folderId = normalizeSessionProjectId(entry.folderId);
    projectIds.add(id);
    projects.push({
      id,
      name,
      folderId: folderId && folderIds.has(folderId) ? folderId : null,
      order: finiteOrder(entry.order, index),
    });
  }

  folders.sort(compareOrderedByName);
  projects.sort(compareOrderedByName);
  return { folders, projects };
}

export function serializeSessionProjectCatalog(catalog: unknown): {
  version: typeof SESSION_PROJECTS_VERSION;
  folders: SessionProjectFolderRecord[];
  projects: SessionProjectRecord[];
} {
  const normalized = normalizeSessionProjectCatalog(catalog);
  return {
    version: SESSION_PROJECTS_VERSION,
    folders: normalized.folders,
    projects: normalized.projects,
  };
}

function finiteOrder(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function compareOrderedByName(a: { order?: number; name?: string; id?: string }, b: { order?: number; name?: string; id?: string }): number {
  return ((a.order ?? 0) - (b.order ?? 0))
    || String(a.name || "").localeCompare(String(b.name || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}
