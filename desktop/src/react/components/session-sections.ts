import type { Session } from '../types';
import type {
  SessionProject,
  SessionProjectCatalog,
  SessionProjectFolder,
  SessionProjectFolderGroup,
  SessionProjectGroup,
} from '../types/session-projects';
import {
  UNCATEGORIZED_PROJECT_ID,
  autoProjectIdForCwd as makeAutoProjectIdForCwd,
  autoProjectNameForCwd,
  isAutoProjectId,
} from '../../../../shared/session-projects.ts';

export type {
  SessionProject,
  SessionProjectCatalog,
  SessionProjectFolder,
  SessionProjectFolderGroup,
  SessionProjectGroup,
} from '../types/session-projects';

export type SessionViewMode = 'time' | 'project';
export type DateGroup = 'today' | 'thisWeek' | 'earlier';

export interface SessionProjectView {
  pinned: Session[];
  rootProjects: SessionProjectGroup[];
  folders: SessionProjectFolderGroup[];
  // True while the project catalog has not finished loading. Consumers should show a
  // loading affordance instead of trusting the (intentionally incomplete) grouping,
  // because catalog-assigned sessions are held back rather than demoted to cwd.
  pending: boolean;
}

export type SessionSection =
  | {
      id: 'pinned';
      kind: 'pinned';
      titleKey: 'sidebar.pinned';
      items: Session[];
    }
  | {
      id: `date:${DateGroup}`;
      kind: 'date';
      titleKey: `time.${DateGroup}`;
      group: DateGroup;
      items: Session[];
    };

interface BuildSessionSectionsOptions {
  mode?: 'time';
  now?: Date;
}

const DATE_GROUP_ORDER: DateGroup[] = ['today', 'thisWeek', 'earlier'];

function getSessionDateGroup(isoStr: string | null, now: Date): DateGroup {
  if (!isoStr) return 'earlier';
  const date = new Date(isoStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  if (date >= today) return 'today';
  if (date >= weekAgo) return 'thisWeek';
  return 'earlier';
}

function isPinnedSession(session: Session): boolean {
  return typeof session.pinnedAt === 'string' && session.pinnedAt.length > 0;
}

function modifiedTime(session: Session): number {
  return timestamp(session.modified);
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function compareByPath(a: Session, b: Session): number {
  return String(a.path || '').localeCompare(String(b.path || ''));
}

function compareByModifiedDesc(a: Session, b: Session): number {
  return modifiedTime(b) - modifiedTime(a) || compareByPath(a, b);
}

/**
 * 置顶区按手动顺序升序。还没有顺序的会话排在有顺序的之后，彼此之间仍按最近活动排——
 * 顺序固化前的老数据因此保持原来的显示顺序。
 */
function comparePinned(a: Session, b: Session): number {
  const ao = typeof a.pinOrder === 'number' ? a.pinOrder : Number.POSITIVE_INFINITY;
  const bo = typeof b.pinOrder === 'number' ? b.pinOrder : Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return compareByModifiedDesc(a, b);
}

export function autoProjectIdForCwd(cwd: string | null | undefined): string {
  return makeAutoProjectIdForCwd(cwd);
}

export function buildSessionSections(
  sessions: Session[],
  options: BuildSessionSectionsOptions = {},
): SessionSection[] {
  const pinned = sessions
    .filter(isPinnedSession)
    .sort(comparePinned);
  const regular = sessions.filter(session => !isPinnedSession(session));

  const sections: SessionSection[] = [];
  sections.push({
    id: 'pinned',
    kind: 'pinned',
    titleKey: 'sidebar.pinned',
    items: pinned,
  });

  const now = options.now ?? new Date();
  const dateGroups: Record<DateGroup, Session[]> = {
    today: [],
    thisWeek: [],
    earlier: [],
  };
  for (const session of regular) {
    dateGroups[getSessionDateGroup(session.modified, now)].push(session);
  }

  // Sort within each group: newest modified first
  for (const group of DATE_GROUP_ORDER) {
    dateGroups[group].sort(compareByModifiedDesc);
  }

  for (const group of DATE_GROUP_ORDER) {
    const items = dateGroups[group];
    if (items.length === 0) continue;
    sections.push({
      id: `date:${group}`,
      kind: 'date',
      titleKey: `time.${group}`,
      group,
      items,
    });
  }

  return sections;
}

interface BuildSessionProjectViewOptions {
  // Whether the catalog has finished loading. Defaults to true so existing callers
  // and tests keep the "project missing -> fall back to cwd" semantics. When false,
  // catalog-assigned sessions whose project has not arrived yet are held back.
  catalogLoaded?: boolean;
}

export function buildSessionProjectView(
  sessions: Session[],
  catalog: SessionProjectCatalog = { projects: [] },
  options: BuildSessionProjectViewOptions = {},
): SessionProjectView {
  const catalogLoaded = options.catalogLoaded ?? true;
  const pinned = sessions
    .filter(isPinnedSession)
    .sort(comparePinned);
  const regular = sessions.filter(session => !isPinnedSession(session));

  const catalogFolders = normalizeCatalogFolders(catalog.folders);
  const folderIds = new Set(catalogFolders.map(folder => folder.id));
  const catalogProjects = normalizeCatalogProjects(catalog.projects);
  const projectById = new Map<string, SessionProjectGroup>();

  for (const project of catalogProjects) {
    projectById.set(project.id, {
      id: project.id,
      name: project.name,
      folderId: project.folderId && folderIds.has(project.folderId) ? project.folderId : null,
      order: project.order,
      source: 'catalog',
      items: [],
    });
  }

  for (const session of regular) {
    const explicitProjectId = typeof session.projectId === 'string' ? session.projectId.trim() : '';
    const catalogAssigned = !!explicitProjectId && !isAutoProjectId(explicitProjectId);
    // Catalog still loading: a session pointing at a custom project we have not
    // received yet is held back, never demoted into a cwd-derived project. Demoting
    // here is exactly what made custom projects vanish (their sessions dumped into the
    // auto cwd group) until the user toggled the sort order and triggered a reload.
    if (!catalogLoaded && catalogAssigned && !projectById.has(explicitProjectId)) {
      continue;
    }
    const targetId = explicitProjectId && (projectById.has(explicitProjectId) || isAutoProjectId(explicitProjectId))
      ? explicitProjectId
      : autoProjectIdForCwd(session.cwd);
    const project = ensureProjectGroup(projectById, targetId, session);
    project.items.push(session);
  }

  for (const project of projectById.values()) {
    project.items.sort(compareByModifiedDesc);
  }

  const allProjects = Array.from(projectById.values());
  const rootProjects = allProjects
    .filter(project => !project.folderId)
    .sort(compareProjectGroups);
  const folders = catalogFolders
    .map(folder => ({
      ...folder,
      projects: allProjects
        .filter(project => project.folderId === folder.id)
        .sort(compareProjectGroups),
    }))
    .sort(compareFolders);

  return { pinned, rootProjects, folders, pending: !catalogLoaded };
}

function ensureProjectGroup(
  projectById: Map<string, SessionProjectGroup>,
  projectId: string,
  session: Session,
): SessionProjectGroup {
  const existing = projectById.get(projectId);
  if (existing) return existing;
  const project: SessionProjectGroup = {
    id: projectId,
    name: projectId === UNCATEGORIZED_PROJECT_ID
      ? '未归类'
      : autoProjectNameForCwd(session.cwd, '未指定项目'),
    folderId: null,
    order: Number.MAX_SAFE_INTEGER,
    source: 'cwd',
    items: [],
  };
  projectById.set(projectId, project);
  return project;
}

function normalizeCatalogProjects(
  projects: SessionProject[] | undefined,
): SessionProject[] {
  if (!Array.isArray(projects)) return [];
  return projects
    .filter(project => !!project && typeof project.id === 'string' && typeof project.name === 'string')
    .map((project, index) => ({
      id: project.id,
      name: project.name,
      folderId: typeof project.folderId === 'string' && project.folderId.trim() ? project.folderId.trim() : null,
      order: Number.isFinite(project.order) ? project.order : index,
    }));
}

function normalizeCatalogFolders(
  folders: SessionProjectFolder[] | undefined,
): SessionProjectFolder[] {
  if (!Array.isArray(folders)) return [];
  return folders
    .filter(folder => !!folder && typeof folder.id === 'string' && typeof folder.name === 'string')
    .map((folder, index) => ({
      id: folder.id,
      name: folder.name,
      order: Number.isFinite(folder.order) ? folder.order : index,
    }));
}

function compareProjectGroups(a: SessionProjectGroup, b: SessionProjectGroup): number {
  if (a.source !== b.source) return a.source === 'catalog' ? -1 : 1;
  const latestDelta = latestModifiedTime(b) - latestModifiedTime(a);
  return a.order - b.order
    || (a.source === 'cwd' ? latestDelta : 0)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

function latestModifiedTime(project: SessionProjectGroup): number {
  return project.items.reduce((latest, session) => Math.max(latest, modifiedTime(session)), 0);
}

function compareFolders(a: SessionProjectFolderGroup, b: SessionProjectFolderGroup): number {
  return a.order - b.order
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}
