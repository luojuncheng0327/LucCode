import { lucFetch } from '../hooks/use-luc-fetch';
import { hasServerConnection } from '../services/server-connection';
import type { PreviewItem, RightWorkspaceTab } from '../types';
import { readFileForPreviewType } from '../utils/preview-file-content';
import { useStore } from './index';
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.ts';
import {
  normalizePreviewReadingPosition,
  type PreviewReadingPosition,
} from '../../../../shared/preview-reading-position.ts';

interface PersistedPreviewTab {
  id: string;
  filePath?: string;
  relativePath?: string;
  title?: string;
  type?: string;
  ext?: string;
  language?: string | null;
  sourceRootPath?: string;
  readingPosition?: PreviewReadingPosition;
}

export interface PersistedWorkspaceUiState {
  updatedAt?: number;
  /** Legacy read-only field from the old folder-navigation desk. New writes omit it. */
  deskCurrentPath?: string;
  deskExpandedPaths?: string[];
  deskSelectedPath?: string;
  rightWorkspaceTab?: RightWorkspaceTab;
  jianView?: string;
  jianDrawerOpen?: boolean;
  previewOpen?: boolean;
  openTabs?: string[];
  activeTabId?: string | null;
  previewTabs?: PersistedPreviewTab[];
}

const SAVE_DEBOUNCE_MS = 350;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export type WorkspaceUiSurface = 'electron' | 'pwa';

function normalizeRoot(root: string | null | undefined): string | null {
  return normalizeWorkspacePath(root);
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspacePath(root: string, relativePath: string): string {
  const base = root.replace(/[\\/]+$/g, '');
  const rel = normalizeSubdir(relativePath);
  return rel ? `${base}/${rel}` : base;
}

function relativePathFor(root: string, filePath: string | undefined): string {
  if (!filePath) return '';
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : '';
}

function previewTabFromItem(root: string, item: PreviewItem, readingPosition?: PreviewReadingPosition): PersistedPreviewTab | null {
  if (!item.filePath) return null;
  const relativePath = relativePathFor(root, item.filePath);
  const normalizedReadingPosition = normalizePreviewReadingPosition(readingPosition);
  return {
    id: item.id,
    filePath: item.filePath,
    ...(relativePath ? { relativePath } : {}),
    title: item.title,
    type: item.type,
    ext: item.ext,
    language: item.language ?? null,
    ...(item.sourceRootPath ? { sourceRootPath: item.sourceRootPath } : {}),
    ...(normalizedReadingPosition ? { readingPosition: normalizedReadingPosition } : {}),
  };
}

function restoredSourceRootPath(tab: PersistedPreviewTab, normalizedRoot: string, type: string): string | undefined {
  const explicitRoot = normalizeRoot(tab.sourceRootPath);
  if (explicitRoot) return explicitRoot;
  return type === 'html' && tab.relativePath ? normalizedRoot : undefined;
}

export function resolveWorkspaceUiSurface(): WorkspaceUiSurface {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-platform') === 'web') {
    return 'pwa';
  }
  if (typeof window !== 'undefined' && window.location?.pathname?.startsWith('/mobile')) {
    return 'pwa';
  }
  return 'electron';
}

function workspaceUiStateUrl(root: string): string {
  const params = new URLSearchParams();
  params.set('workspace', root);
  params.set('surface', resolveWorkspaceUiSurface());
  return `/api/preferences/workspace-ui-state?${params.toString()}`;
}

export function buildPersistedWorkspaceUiState(root: string): PersistedWorkspaceUiState {
  const state = useStore.getState();
  const previewItemsById = new Map(state.previewItems.map(item => [item.id, item]));
  const previewTabs = (state.openTabs || [])
    .map(id => previewItemsById.get(id))
    .filter((item): item is PreviewItem => !!item)
    .map(item => previewTabFromItem(root, item, state.previewReadingPositions?.[item.id]))
    .filter((item): item is PersistedPreviewTab => !!item);
  const persistedIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = (state.openTabs || []).filter(id => persistedIds.has(id));
  const activeTabId = state.activeTabId && openTabs.includes(state.activeTabId)
    ? state.activeTabId
    : (openTabs[0] || null);

  return {
    deskExpandedPaths: [...(state.deskExpandedPaths || [])].map(normalizeSubdir).filter(Boolean),
    deskSelectedPath: normalizeSubdir(state.deskSelectedPath),
    rightWorkspaceTab: state.rightWorkspaceTab,
    jianView: state.jianView,
    jianDrawerOpen: !!state.jianDrawerOpen,
    previewOpen: !!state.previewOpen,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

export function readingPositionsFromPersistedWorkspaceUiState(
  persisted: PersistedWorkspaceUiState | null,
  allowedIds?: Iterable<string>,
): Record<string, PreviewReadingPosition> {
  if (!persisted?.previewTabs?.length) return {};
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out: Record<string, PreviewReadingPosition> = {};
  for (const tab of persisted.previewTabs) {
    if (!tab.id || (allowed && !allowed.has(tab.id))) continue;
    const normalized = normalizePreviewReadingPosition(tab.readingPosition);
    if (normalized) out[tab.id] = normalized;
  }
  return out;
}

export async function loadPersistedWorkspaceUiState(root: string): Promise<PersistedWorkspaceUiState | null> {
  const normalized = normalizeRoot(root);
  const state = useStore.getState();
  if (!normalized || !hasServerConnection(state)) return null;
  try {
    const res = await lucFetch(workspaceUiStateUrl(normalized));
    const data = await res.json().catch(() => null);
    return data?.state && typeof data.state === 'object' ? data.state as PersistedWorkspaceUiState : null;
  } catch (err) {
    console.warn('[workspace-ui-state] load failed:', err);
    return null;
  }
}

export async function hydratePersistedPreviewItems(
  root: string,
  persisted: PersistedWorkspaceUiState | null,
): Promise<PreviewItem[]> {
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot || !persisted?.previewTabs?.length) return [];
  const items: PreviewItem[] = [];
  for (const tab of persisted.previewTabs) {
    const filePath = tab.relativePath
      ? joinWorkspacePath(normalizedRoot, tab.relativePath)
      : (tab.filePath || '');
    if (!filePath || !tab.id) continue;
    try {
      const type = tab.type || 'file-info';
      const read = await readFileForPreviewType(filePath, type);
      if (!read) continue;
      items.push({
        id: tab.id,
        type,
        title: tab.title || filePath.split('/').pop() || filePath,
        content: read.content,
        filePath,
        ext: tab.ext,
        language: tab.language,
        sourceUrl: read.sourceUrl,
        sourceRootPath: restoredSourceRootPath(tab, normalizedRoot, type),
        fileVersion: read.fileVersion,
      });
    } catch (err) {
      console.warn('[workspace-ui-state] preview tab restore failed:', err);
    }
  }
  return items;
}

export function schedulePersistCurrentWorkspaceUiState(root?: string | null): void {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !hasServerConnection(useStore.getState())) return;
  const state = buildPersistedWorkspaceUiState(normalized);
  const existing = saveTimers.get(normalized);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    saveTimers.delete(normalized);
    void persistWorkspaceUiState(normalized, state);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(normalized, timer);
}

export async function persistCurrentWorkspaceUiStateNow(root?: string | null): Promise<void> {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !hasServerConnection(useStore.getState())) return;
  const state = buildPersistedWorkspaceUiState(normalized);
  await persistWorkspaceUiState(normalized, state);
}

async function persistWorkspaceUiState(root: string, state: PersistedWorkspaceUiState): Promise<void> {
  const surface = resolveWorkspaceUiSurface();
  try {
    await lucFetch('/api/preferences/workspace-ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: root, surface, state }),
    });
  } catch (err) {
    console.warn('[workspace-ui-state] save failed:', err);
  }
}
