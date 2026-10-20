import { useStore, type StoreState } from '../stores';
import type { PreviewItem, RemoteWorkbenchContentRef } from '../types';
import {
  PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS,
  PREVIEW_FILE_CHANGE_REFRESH_OPTIONS,
  refreshPreviewItemsFromFile,
  type PreviewFileRefreshOptions,
} from './preview-file-refresh';
import {
  isRemoteWorkbenchContentRef,
  normalizeWorkbenchContentRef,
  refreshPreviewItemsFromRemoteWorkbenchTarget,
} from './remote-file-preview';
import type { ResourceRef } from '../services/resource-events';

export type PreviewDocumentTarget =
  | { kind: 'local-file'; filePath: string }
  | { kind: 'workbench-file'; target: RemoteWorkbenchContentRef };

export type PreviewDocumentRefreshOptions = PreviewFileRefreshOptions;
export type PreviewDocumentWatchResource = {
  ref: ResourceRef;
  target: PreviewDocumentTarget;
};

export type ResourceChangeEvent = {
  type?: unknown;
  filePath?: unknown;
  path?: unknown;
  resourceKey?: unknown;
  resource?: {
    kind?: unknown;
    provider?: unknown;
    mountId?: unknown;
    rootId?: unknown;
    path?: unknown;
    filePath?: unknown;
    isDirectory?: unknown;
  } | null;
  oldResource?: {
    kind?: unknown;
    provider?: unknown;
    mountId?: unknown;
    rootId?: unknown;
    path?: unknown;
    filePath?: unknown;
    isDirectory?: unknown;
  } | null;
  newResource?: {
    kind?: unknown;
    provider?: unknown;
    mountId?: unknown;
    rootId?: unknown;
    path?: unknown;
    filePath?: unknown;
    isDirectory?: unknown;
  } | null;
};

interface PreviewDocumentRefreshControl {
  fallbackOpenDocuments?: boolean;
}

export const PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS: PreviewDocumentRefreshOptions = PREVIEW_FILE_CHANGE_REFRESH_OPTIONS;
export const PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS: PreviewDocumentRefreshOptions = PREVIEW_FILE_CATCH_UP_REFRESH_OPTIONS;

function normalizeComparablePath(value: string): string {
  const slashed = String(value || '').trim().replace(/\\/g, '/');
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/g, '') : slashed;
  return /^[A-Za-z]:/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function normalizeSubdir(value: string | undefined | null): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspaceFilePath(basePath: string, subdir: string | undefined | null, name: string): string {
  const separator = /^[A-Za-z]:\\/.test(basePath) || (basePath.includes('\\') && !basePath.includes('/')) ? '\\' : '/';
  const parts = [normalizeSubdir(subdir), name.replace(/^[/\\]+/g, '')]
    .filter(Boolean)
    .join('/');
  if (!parts) return basePath;
  return `${basePath.replace(/[\\/]+$/g, '')}${separator}${parts.replace(/\//g, separator)}`;
}

function joinResourcePath(subdir: string | undefined | null, name: string): string {
  return [normalizeSubdir(subdir), name.replace(/^[/\\]+/g, '')]
    .filter(Boolean)
    .join('/');
}

function previewDocumentTargetKey(target: PreviewDocumentTarget): string {
  if (target.kind === 'local-file') return `local:${target.filePath}`;
  const normalized = normalizeWorkbenchContentRef(target.target);
  return [
    'workbench',
    normalized.mountId || normalized.rootId || 'default',
    normalized.subdir || '',
    normalized.name,
  ].join(':');
}

export function previewDocumentTargetFromItem(item: PreviewItem | undefined | null): PreviewDocumentTarget | null {
  if (!item) return null;
  if (isRemoteWorkbenchContentRef(item.remoteContentRef)) {
    return { kind: 'workbench-file', target: item.remoteContentRef };
  }
  if (item.filePath && item.storageKind !== 'remote-content') {
    return { kind: 'local-file', filePath: item.filePath };
  }
  return null;
}

function previewDocumentTargetsEqual(left: PreviewDocumentTarget, right: PreviewDocumentTarget): boolean {
  return previewDocumentTargetKey(left) === previewDocumentTargetKey(right);
}

function previewDocumentTargetsPushUnique(targets: PreviewDocumentTarget[], seen: Set<string>, target: PreviewDocumentTarget): void {
  const key = previewDocumentTargetKey(target);
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

function openPreviewDocumentTargetMatches(target: PreviewDocumentTarget): boolean {
  const state = useStore.getState();
  const itemsById = new Map((state.previewItems || []).map(item => [item.id, item]));
  for (const id of state.openTabs || []) {
    const openTarget = previewDocumentTargetFromItem(itemsById.get(id));
    if (openTarget && previewDocumentTargetsEqual(openTarget, target)) return true;
  }
  return false;
}

export function openPreviewDocumentTargets(): PreviewDocumentTarget[] {
  const state = useStore.getState();
  const itemsById = new Map((state.previewItems || []).map(item => [item.id, item]));
  const targets: PreviewDocumentTarget[] = [];
  const seen = new Set<string>();

  for (const id of state.openTabs || []) {
    const target = previewDocumentTargetFromItem(itemsById.get(id));
    if (!target) continue;
    const key = previewDocumentTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }

  return targets;
}

export function filePathForPreviewDocumentTarget(target: PreviewDocumentTarget, state: ReturnType<typeof useStore.getState>): string | null {
  if (target.kind === 'local-file') return target.filePath;

  const normalized = normalizeWorkbenchContentRef(target.target);
  const targetMountId = normalized.mountId || normalized.rootId || 'default';
  const activeMountIdValue = typeof state.deskWorkspaceMountId === 'string' ? state.deskWorkspaceMountId.trim() : '';
  const activeMountId = activeMountIdValue
    ? activeMountIdValue
    : 'default';
  const basePath = targetMountId === activeMountId
    ? (activeMountIdValue
        ? (typeof state.deskWorkspaceNativeRoot === 'string' ? state.deskWorkspaceNativeRoot : '')
        : (typeof state.deskBasePath === 'string' ? state.deskBasePath : ''))
    : nativeRootForWorkbenchMount(state, targetMountId);
  if (!basePath) return null;

  return joinWorkspaceFilePath(basePath, normalized.subdir || '', normalized.name);
}

function nativeRootForWorkbenchMount(state: Pick<StoreState, 'studioWorkspaces'>, mountId: string): string {
  const workspaces = Array.isArray(state.studioWorkspaces)
    ? state.studioWorkspaces
    : [];
  const match = workspaces.find((workspace) =>
    typeof workspace?.mountId === 'string' && workspace.mountId === mountId);
  return typeof match?.nativeRootPath === 'string' ? match.nativeRootPath : '';
}

function resourceRefForPreviewDocumentTarget(
  target: PreviewDocumentTarget,
  state: ReturnType<typeof useStore.getState>,
): ResourceRef | null {
  if (target.kind === 'local-file') return { kind: 'local-file', path: target.filePath };

  const normalized = normalizeWorkbenchContentRef(target.target);
  const mountId = normalized.mountId || normalized.rootId || 'default';
  if (mountId && mountId !== 'default') {
    return {
      kind: 'mount',
      mountId,
      path: joinResourcePath(normalized.subdir || '', normalized.name),
    };
  }

  const filePath = filePathForPreviewDocumentTarget(target, state);
  return filePath ? { kind: 'local-file', path: filePath } : null;
}

function resourceRefKey(ref: ResourceRef): string {
  if (ref.kind === 'local-file') return `local:${normalizeComparablePath(ref.path)}`;
  return `mount:${ref.mountId}:${normalizeSubdir(ref.path)}`;
}

function mountIdFromResourceDescriptor(resource: ResourceChangeEvent['resource']): string | null {
  if (!resource || typeof resource !== 'object') return null;
  const mountId = typeof resource.mountId === 'string' && resource.mountId.trim()
    ? resource.mountId.trim()
    : typeof resource.rootId === 'string' && resource.rootId.trim()
      ? resource.rootId.trim()
      : '';
  return mountId || null;
}
export function openPreviewDocumentWatchFilePaths(): string[] {
  const state = useStore.getState();
  const targets = openPreviewDocumentTargets();
  const filePaths: string[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const filePath = filePathForPreviewDocumentTarget(target, state);
    if (!filePath) continue;
    const key = normalizeComparablePath(filePath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    filePaths.push(filePath);
  }

  return filePaths.sort((a, b) => normalizeComparablePath(a).localeCompare(normalizeComparablePath(b)));
}

export function openPreviewDocumentWatchResources(): PreviewDocumentWatchResource[] {
  const state = useStore.getState();
  const targets = openPreviewDocumentTargets();
  const resources: PreviewDocumentWatchResource[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const ref = resourceRefForPreviewDocumentTarget(target, state);
    if (!ref) continue;
    const key = resourceRefKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    resources.push({ ref, target });
  }

  return resources.sort((a, b) => resourceRefKey(a.ref).localeCompare(resourceRefKey(b.ref)));
}

function openPreviewDocumentTargetsForFilePath(filePath: string): PreviewDocumentTarget[] {
  const state = useStore.getState();
  const changedKey = normalizeComparablePath(filePath);
  if (!changedKey) return [];

  const itemsById = new Map((state.previewItems || []).map(item => [item.id, item]));
  const targets: PreviewDocumentTarget[] = [];
  const seen = new Set<string>();
  for (const id of state.openTabs || []) {
    const target = previewDocumentTargetFromItem(itemsById.get(id));
    if (!target) continue;
    const targetFilePath = filePathForPreviewDocumentTarget(target, state);
    if (!targetFilePath || normalizeComparablePath(targetFilePath) !== changedKey) continue;
    const key = previewDocumentTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

type ChangedResourceRef = {
  ref: ResourceRef;
  isDirectory: boolean;
};

function resourceRefMatchesChangedRef(openRef: ResourceRef, changed: ChangedResourceRef): boolean {
  const changedRef = changed.ref;
  if (openRef.kind !== changedRef.kind) return false;

  if (openRef.kind === 'local-file' && changedRef.kind === 'local-file') {
    const openPath = normalizeComparablePath(openRef.path);
    const changedPath = normalizeComparablePath(changedRef.path);
    if (!openPath || !changedPath) return false;
    if (!changed.isDirectory) return openPath === changedPath;
    const prefix = changedPath.endsWith('/') ? changedPath : `${changedPath}/`;
    return openPath === changedPath || openPath.startsWith(prefix);
  }

  if (openRef.kind === 'mount' && changedRef.kind === 'mount') {
    if (openRef.mountId !== changedRef.mountId) return false;
    const openPath = normalizeSubdir(openRef.path);
    const changedPath = normalizeSubdir(changedRef.path);
    if (!changed.isDirectory) return openPath === changedPath;
    const prefix = changedPath ? `${changedPath}/` : '';
    return !changedPath || openPath === changedPath || openPath.startsWith(prefix);
  }

  return false;
}

function pushChangedResourceRef(refs: ChangedResourceRef[], next: ChangedResourceRef): void {
  const key = resourceRefKey(next.ref);
  if (refs.some(existing => resourceRefKey(existing.ref) === key && existing.isDirectory === next.isDirectory)) return;
  refs.push(next);
}

function changedResourceRefsFromDescriptor(resource: ResourceChangeEvent['resource']): ChangedResourceRef[] {
  const refs: ChangedResourceRef[] = [];
  if (!resource || typeof resource !== 'object') return refs;
  const isDirectory = isDirectoryResource(resource);
  const mountId = mountIdFromResourceDescriptor(resource);
  const kind = typeof resource.kind === 'string' ? resource.kind : '';
  const provider = typeof resource.provider === 'string' ? resource.provider : '';
  const isMount = kind === 'mount' || provider === 'mount' || !!mountId;

  if (isMount && mountId) {
    pushChangedResourceRef(refs, {
      ref: {
        kind: 'mount',
        mountId,
        path: typeof resource.path === 'string' ? normalizeSubdir(resource.path) : '',
      },
      isDirectory,
    });
  }

  const projectedFilePath = filePathFromResourceDescriptor(resource);
  if (projectedFilePath) {
    pushChangedResourceRef(refs, {
      ref: { kind: 'local-file', path: projectedFilePath },
      isDirectory,
    });
  }

  return refs;
}

function changedResourceRefsFromEvent(event: ResourceChangeEvent | null | undefined): ChangedResourceRef[] {
  if (!event || typeof event !== 'object') return [];
  const refs: ChangedResourceRef[] = [];
  for (const resource of resourceDescriptorsFromChange(event)) {
    for (const ref of changedResourceRefsFromDescriptor(resource)) {
      pushChangedResourceRef(refs, ref);
    }
  }

  const topLevelPath = typeof event.filePath === 'string' && event.filePath.trim()
    ? event.filePath
    : typeof event.path === 'string' && event.path.trim()
      ? event.path
      : '';
  if (topLevelPath) {
    pushChangedResourceRef(refs, {
      ref: { kind: 'local-file', path: topLevelPath },
      isDirectory: false,
    });
  }

  return refs;
}

function openPreviewDocumentTargetsForResourceChange(event: ResourceChangeEvent | null | undefined): PreviewDocumentTarget[] {
  const state = useStore.getState();
  const itemsById = new Map((state.previewItems || []).map(item => [item.id, item]));
  const changedRefs = changedResourceRefsFromEvent(event);
  const targets: PreviewDocumentTarget[] = [];
  const seen = new Set<string>();

  if (changedRefs.length > 0) {
    for (const id of state.openTabs || []) {
      const target = previewDocumentTargetFromItem(itemsById.get(id));
      if (!target) continue;
      const openRef = resourceRefForPreviewDocumentTarget(target, state);
      if (!openRef) continue;
      if (!changedRefs.some(changedRef => resourceRefMatchesChangedRef(openRef, changedRef))) continue;
      previewDocumentTargetsPushUnique(targets, seen, target);
    }
  }

  for (const filePath of filePathsFromResourceChange(event)) {
    for (const target of openPreviewDocumentTargetsForFilePath(filePath)) {
      previewDocumentTargetsPushUnique(targets, seen, target);
    }
  }

  return targets;
}

export async function refreshPreviewDocumentTarget(
  target: PreviewDocumentTarget,
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
  control: PreviewDocumentRefreshControl = {},
): Promise<void> {
  const shouldFallbackOpenDocuments = control.fallbackOpenDocuments !== false
    && !openPreviewDocumentTargetMatches(target);
  if (target.kind === 'local-file') {
    await refreshPreviewItemsFromFile(target.filePath, options);
  } else {
    await refreshPreviewItemsFromRemoteWorkbenchTarget(target.target, options);
  }
  if (shouldFallbackOpenDocuments) {
    await refreshOpenPreviewDocuments(options);
  }
}

export async function refreshOpenPreviewDocuments(
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CATCH_UP_REFRESH_OPTIONS,
): Promise<void> {
  const targets = openPreviewDocumentTargets();
  if (targets.length === 0) return;
  await Promise.all(targets.map(target => refreshPreviewDocumentTarget(
    target,
    options,
    { fallbackOpenDocuments: false },
  )));
}

export async function refreshOpenPreviewDocumentsForFilePath(
  filePath: string,
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
): Promise<void> {
  const targets = openPreviewDocumentTargetsForFilePath(filePath);
  if (targets.length === 0) return;
  await Promise.all(targets.map(target => refreshPreviewDocumentTarget(
    target,
    options,
    { fallbackOpenDocuments: false },
  )));
}

function filePathFromResourceDescriptor(resource: ResourceChangeEvent['resource']): string | null {
  if (!resource || typeof resource !== 'object') return null;
  const provider = typeof resource.provider === 'string' ? resource.provider : '';
  const kind = typeof resource.kind === 'string' ? resource.kind : '';
  const projectedFilePath = typeof resource.filePath === 'string' && resource.filePath.trim()
    ? resource.filePath
    : null;
  const isLocal = provider === 'local_fs'
    || kind === 'local-file'
    || kind === 'local_path'
    || kind === 'local-path';
  if (isLocal && typeof resource.path === 'string' && resource.path.trim()) return resource.path;
  return projectedFilePath;
}

export function filePathsFromResourceChange(event: ResourceChangeEvent | null | undefined): string[] {
  if (!event || typeof event !== 'object') return [];
  const paths: string[] = [];
  const push = (value: string | null) => {
    if (!value) return;
    const key = normalizeComparablePath(value);
    if (!key || paths.some(existing => normalizeComparablePath(existing) === key)) return;
    paths.push(value);
  };

  if (typeof event.filePath === 'string' && event.filePath.trim()) return [event.filePath];
  if (typeof event.path === 'string' && event.path.trim()) return [event.path];

  push(filePathFromResourceDescriptor(event.resource));
  push(filePathFromResourceDescriptor(event.oldResource));
  push(filePathFromResourceDescriptor(event.newResource));
  return paths;
}

export function filePathFromResourceChange(event: ResourceChangeEvent | null | undefined): string | null {
  return filePathsFromResourceChange(event)[0] || null;
}

function parentSubdirForWorkspaceFile(basePath: string, filePath: string): string | null {
  const base = normalizeComparablePath(basePath);
  const changed = normalizeComparablePath(filePath);
  if (!base || !changed) return null;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (changed !== base && !changed.startsWith(prefix)) return null;
  const relative = changed === base ? '' : changed.slice(prefix.length);
  const parent = relative.split('/').slice(0, -1).join('/');
  return parent.replace(/^\/+|\/+$/g, '');
}

function directorySubdirForWorkspaceFile(basePath: string, filePath: string): string | null {
  const base = normalizeComparablePath(basePath);
  const changed = normalizeComparablePath(filePath);
  if (!base || !changed) return null;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  if (changed !== base && !changed.startsWith(prefix)) return null;
  const relative = changed === base ? '' : changed.slice(prefix.length);
  return relative.replace(/^\/+|\/+$/g, '');
}

function isDirectoryResource(resource: ResourceChangeEvent['resource']): boolean {
  return !!resource && typeof resource === 'object' && (resource as { isDirectory?: unknown }).isDirectory === true;
}

function resourceDescriptorsFromChange(event: ResourceChangeEvent): Array<ResourceChangeEvent['resource']> {
  return [event.resource, event.oldResource, event.newResource].filter(Boolean) as Array<ResourceChangeEvent['resource']>;
}

export function markDeskTreeDirtyForResourceChange(event: ResourceChangeEvent | null | undefined): void {
  const filePaths = filePathsFromResourceChange(event);
  if (filePaths.length === 0) return;
  if (!event) return;
  const state = useStore.getState();
  const basePath = state.deskWorkspaceMountId
    ? (typeof state.deskWorkspaceNativeRoot === 'string' ? state.deskWorkspaceNativeRoot : '')
    : (typeof state.deskBasePath === 'string' ? state.deskBasePath : '');
  if (!basePath) return;
  for (const filePath of filePaths) {
    const subdir = parentSubdirForWorkspaceFile(basePath, filePath);
    if (subdir == null) continue;
    state.markDeskTreeDirty(subdir);
  }
  for (const resource of resourceDescriptorsFromChange(event)) {
    if (!isDirectoryResource(resource)) continue;
    const filePath = filePathFromResourceDescriptor(resource);
    if (!filePath) continue;
    const subdir = directorySubdirForWorkspaceFile(basePath, filePath);
    if (subdir == null) continue;
    state.markDeskTreeDirty(subdir);
  }
}

export async function refreshOpenPreviewDocumentsForResourceChange(
  event: ResourceChangeEvent | null | undefined,
  options: PreviewDocumentRefreshOptions = PREVIEW_DOCUMENT_CHANGE_REFRESH_OPTIONS,
): Promise<void> {
  const targets = openPreviewDocumentTargetsForResourceChange(event);
  if (targets.length === 0) return;
  await Promise.all(targets.map(target => refreshPreviewDocumentTarget(
    target,
    options,
    { fallbackOpenDocuments: false },
  )));
}
