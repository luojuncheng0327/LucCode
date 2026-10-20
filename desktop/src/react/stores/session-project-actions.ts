import { lucFetch } from '../hooks/use-luc-fetch';
import { useStore } from './index';
import type { SessionProject, SessionProjectCatalog, SessionProjectFolder } from '../types/session-projects';
import { EMPTY_SESSION_PROJECT_CATALOG } from './session-project-slice';
import { UNCATEGORIZED_PROJECT_ID } from '../../../../shared/session-projects.ts';

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeProject(raw: unknown, index: number): SessionProject | null {
  const item = asObject(raw);
  if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  return {
    id: item.id,
    name: item.name,
    folderId: typeof item.folderId === 'string' && item.folderId.trim() ? item.folderId.trim() : null,
    order: Number.isFinite(item.order) ? item.order as number : index,
  };
}

function normalizeFolder(raw: unknown, index: number): SessionProjectFolder | null {
  const item = asObject(raw);
  if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  return {
    id: item.id,
    name: item.name,
    order: Number.isFinite(item.order) ? item.order as number : index,
  };
}

export function normalizeSessionProjectCatalogResponse(data: unknown): SessionProjectCatalog {
  const root = asObject(data);
  const rawCatalog = asObject(root?.catalog) || root;
  if (!rawCatalog) return EMPTY_SESSION_PROJECT_CATALOG;
  const folders = Array.isArray(rawCatalog.folders)
    ? rawCatalog.folders.map(normalizeFolder).filter((item): item is SessionProjectFolder => !!item)
    : [];
  const projects = Array.isArray(rawCatalog.projects)
    ? rawCatalog.projects.map(normalizeProject).filter((item): item is SessionProject => !!item)
    : [];
  return { folders, projects };
}

export async function loadSessionProjectCatalog(): Promise<SessionProjectCatalog> {
  const res = await lucFetch('/api/session-projects');
  const data = await res.json().catch(() => ({}));
  const catalog = normalizeSessionProjectCatalogResponse(data);
  useStore.getState().setSessionProjectCatalog(catalog);
  return catalog;
}

/**
 * Reliable initial load for app startup. Retries a few times so a single transient
 * failure (e.g. the server not being ready for the very first request) does not leave
 * the catalog empty for the whole session. Until the catalog loads, the project
 * sidebar holds back custom-project sessions instead of demoting them to cwd groups.
 */
export async function initSessionProjectCatalog(attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await loadSessionProjectCatalog();
      return;
    } catch (err) {
      if (attempt >= attempts) {
        console.warn('[init] session project catalog load failed after retries:', err);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    }
  }
}

export async function createSessionProjectInCatalog(input: { name: string; folderId?: string | null }): Promise<SessionProject | null> {
  const res = await lucFetch('/api/session-projects/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, folderId: input.folderId ?? null }),
  });
  const data = await res.json().catch(() => ({}));
  const project = normalizeProject(asObject(data)?.project, 0);
  if (!project) return null;
  useStore.setState(state => ({
    sessionProjectCatalog: {
      ...state.sessionProjectCatalog,
      projects: [...state.sessionProjectCatalog.projects, project],
    },
    sessionProjectCatalogLoaded: true,
  }));
  return project;
}

export async function patchSessionProjectInCatalog(
  projectId: string,
  patch: { folderId?: string | null; name?: string },
): Promise<SessionProject | null> {
  const res = await lucFetch(`/api/session-projects/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  const project = normalizeProject(asObject(data)?.project, 0);
  if (!project) return null;
  useStore.setState(state => ({
    sessionProjectCatalog: {
      ...state.sessionProjectCatalog,
      projects: state.sessionProjectCatalog.projects.some(item => item.id === project.id)
        ? state.sessionProjectCatalog.projects.map(item => item.id === project.id ? project : item)
        : [...state.sessionProjectCatalog.projects, project],
    },
    sessionProjectCatalogLoaded: true,
  }));
  return project;
}

export async function patchSessionProjectFolderInCatalog(
  folderId: string,
  patch: { name?: string },
): Promise<SessionProjectFolder | null> {
  const res = await lucFetch(`/api/session-projects/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  const folder = normalizeFolder(asObject(data)?.folder, 0);
  if (!folder) return null;
  useStore.setState(state => ({
    sessionProjectCatalog: {
      ...state.sessionProjectCatalog,
      folders: (state.sessionProjectCatalog.folders || []).some(item => item.id === folder.id)
        ? (state.sessionProjectCatalog.folders || []).map(item => item.id === folder.id ? folder : item)
        : [...(state.sessionProjectCatalog.folders || []), folder],
    },
    sessionProjectCatalogLoaded: true,
  }));
  return folder;
}

export async function reorderSessionProjectsInCatalog(folderId: string | null, projectIds: string[]): Promise<void> {
  const res = await lucFetch('/api/session-projects/projects/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, projectIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (asObject(data)?.catalog) {
    useStore.getState().setSessionProjectCatalog(normalizeSessionProjectCatalogResponse(data));
  }
}

export async function reorderSessionProjectFoldersInCatalog(folderIds: string[]): Promise<void> {
  const res = await lucFetch('/api/session-projects/folders/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderIds }),
  });
  const data = await res.json().catch(() => ({}));
  if (asObject(data)?.catalog) {
    useStore.getState().setSessionProjectCatalog(normalizeSessionProjectCatalogResponse(data));
  }
}

export async function deleteSessionProjectFromCatalog(projectId: string, fallbackSessionPaths: string[] = []): Promise<void> {
  const res = await lucFetch(`/api/session-projects/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  const root = asObject(data);
  if (root?.catalog) {
    useStore.getState().setSessionProjectCatalog(normalizeSessionProjectCatalogResponse(data));
  }
  const assignment = asObject(root?.assignment);
  const sessionPaths = Array.isArray(assignment?.sessionPaths)
    ? assignment.sessionPaths.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : fallbackSessionPaths;
  const nextProjectId = typeof assignment?.projectId === 'string' ? assignment.projectId : UNCATEGORIZED_PROJECT_ID;
  const pathSet = new Set(sessionPaths);
  if (pathSet.size > 0) {
    useStore.setState(state => ({
      sessions: state.sessions.map(session => (
        pathSet.has(session.path) ? { ...session, projectId: nextProjectId } : session
      )),
      pendingProjectId: state.pendingProjectId === projectId ? null : state.pendingProjectId,
    }));
  } else {
    useStore.setState(state => ({
      pendingProjectId: state.pendingProjectId === projectId ? null : state.pendingProjectId,
    }));
  }
}

export async function deleteSessionProjectFolderFromCatalog(folderId: string): Promise<void> {
  const res = await lucFetch(`/api/session-projects/folders/${encodeURIComponent(folderId)}`, {
    method: 'DELETE',
  });
  const data = await res.json().catch(() => ({}));
  if (asObject(data)?.catalog) {
    useStore.getState().setSessionProjectCatalog(normalizeSessionProjectCatalogResponse(data));
  }
}

export async function setSessionProjectAssignmentForSession(sessionPath: string, projectId: string | null): Promise<void> {
  await lucFetch('/api/session-projects/session-assignment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, projectId }),
  });
  useStore.setState(state => ({
    sessions: state.sessions.map(session => session.path === sessionPath
      ? { ...session, projectId }
      : session),
  }));
}
