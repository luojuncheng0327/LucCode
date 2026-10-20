import type { DeskFile, FileVersion, RemoteWorkbenchContentRef } from '../types';
import type { FileRef } from '../types/file-ref';
import {
  isLocalOwnerConnection,
  type ServerConnection,
} from './server-connection';

export interface ResourceAccessContext {
  connection?: ServerConnection | null;
}

export type FileRefPreviewAccess =
  | { mode: 'native-path'; path: string }
  | { mode: 'resource-content'; contentPath: string; resourceId: string }
  | { mode: 'inline-data'; dataUrl: string }
  | { mode: 'unsupported'; reason: string };

export type WorkbenchFilePreviewAccess =
  | { mode: 'native-path'; path: string; ext: string; sourceRootPath?: string }
  | {
      mode: 'workbench-content';
      contentPath: string;
      versionedContentPath: string;
      mountId: string;
      rootId: string;
      subdir: string;
      name: string;
      ext: string;
      version?: FileVersion;
      remoteContentRef: RemoteWorkbenchContentRef;
    }
  | { mode: 'unsupported'; reason: string };

export interface WorkbenchFileAccessTarget {
  file: Pick<DeskFile, 'name' | 'isDir' | 'mtime' | 'size'>;
  subdir: string;
  mountId?: string | null;
  rootId?: string | null;
  localRootPath?: string | null;
  nativeRootPath?: string | null;
}

export function canUseNativeResourcePath(context: ResourceAccessContext = {}): boolean {
  const connection = context.connection;
  return !connection || isLocalOwnerConnection(connection);
}

export function encodeWorkbenchContentPath({
  mountId = 'default',
  rootId,
  subdir,
  name,
}: {
  mountId?: string | null;
  rootId?: string | null;
  subdir: string;
  name: string;
}): string {
  const params = new URLSearchParams();
  params.set('mountId', mountId || rootId || 'default');
  params.set('subdir', subdir || '');
  params.set('name', name);
  return `/api/workbench/content?${params.toString()}`;
}

export function resolveFileRefPreviewAccess(
  file: FileRef,
  context: ResourceAccessContext = {},
  options: { preferNativePath?: boolean } = {},
): FileRefPreviewAccess {
  if (file.status === 'expired') return { mode: 'unsupported', reason: 'expired' };
  const preferNativePath = options.preferNativePath !== false;
  if (preferNativePath && file.path && canUseNativeResourcePath(context)) {
    return { mode: 'native-path', path: file.path };
  }
  const contentPath = file.resource?.links.content;
  if (contentPath) {
    return {
      mode: 'resource-content',
      contentPath,
      resourceId: file.resource?.resourceId || file.id,
    };
  }
  if (file.inlineData) {
    return {
      mode: 'inline-data',
      dataUrl: `data:${file.inlineData.mimeType};base64,${file.inlineData.base64}`,
    };
  }
  if (file.path && canUseNativeResourcePath(context)) return { mode: 'native-path', path: file.path };
  if (file.path) return { mode: 'unsupported', reason: 'remote_path_without_content_link' };
  return { mode: 'unsupported', reason: 'missing_resource_content' };
}

export function canPreviewFileRef(file: FileRef, context: ResourceAccessContext = {}): boolean {
  return resolveFileRefPreviewAccess(file, context).mode !== 'unsupported';
}

export function resolveFileRefNativePath(
  file: FileRef,
  context: ResourceAccessContext = {},
  options: { requireAvailable?: boolean } = {},
): string | null {
  if (options.requireAvailable && file.status === 'expired') return null;
  if (!file.path || !canUseNativeResourcePath(context)) return null;
  return file.path;
}

export function canUseFileRefNativePath(
  file: FileRef,
  context: ResourceAccessContext = {},
  options: { requireAvailable?: boolean } = {},
): boolean {
  return !!resolveFileRefNativePath(file, context, options);
}

export function resolveWorkbenchNativePath(
  target: WorkbenchFileAccessTarget,
  context: ResourceAccessContext = {},
): string | null {
  if (!canUseNativeResourcePath(context)) return null;
  const nativeRoot = target.nativeRootPath || (!target.mountId ? target.localRootPath : null);
  if (!nativeRoot) return null;
  return joinNativePath(nativeRoot, childSubdir(target.subdir, target.file.name));
}

export function resolveWorkbenchFilePreviewAccess(
  target: WorkbenchFileAccessTarget,
  context: ResourceAccessContext = {},
  options: { preferNativePath?: boolean } = {},
): WorkbenchFilePreviewAccess {
  if (target.file.isDir) return { mode: 'unsupported', reason: 'directory' };
  const ext = extOfName(target.file.name);
  const preferNativePath = options.preferNativePath !== false;
  const nativePath = resolveWorkbenchNativePath(target, context);
  if (preferNativePath && nativePath) {
    return {
      mode: 'native-path',
      path: nativePath,
      ext,
      sourceRootPath: target.nativeRootPath || target.localRootPath || undefined,
    };
  }

  const mountId = target.mountId || target.rootId || 'default';
  const rootId = target.rootId || mountId;
  const contentPath = encodeWorkbenchContentPath({
    mountId,
    rootId,
    subdir: target.subdir,
    name: target.file.name,
  });
  const version = versionFromDeskFile(target.file);
  return {
    mode: 'workbench-content',
    contentPath,
    versionedContentPath: appendVersionQuery(contentPath, version),
    mountId,
    rootId,
    subdir: target.subdir || '',
    name: target.file.name,
    ext,
    version,
    remoteContentRef: {
      kind: 'workbench-file',
      mountId,
      rootId,
      subdir: target.subdir || '',
      name: target.file.name,
      contentPath,
      version: version ?? null,
    },
  };
}

export function versionFromDeskFile(file: Pick<DeskFile, 'mtime' | 'size'>): FileVersion | undefined {
  const mtimeMs = typeof file.mtime === 'string' ? Date.parse(file.mtime) : NaN;
  if (!Number.isFinite(mtimeMs) || typeof file.size !== 'number') return undefined;
  return { mtimeMs, size: file.size };
}

export function appendVersionQuery(path: string, version: FileVersion | null | undefined): string {
  const token = versionToken(version);
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(token)}`;
}

function versionToken(version: FileVersion | null | undefined): string | null {
  if (!version || typeof version.mtimeMs !== 'number' || typeof version.size !== 'number') return null;
  if (!Number.isFinite(version.mtimeMs) || !Number.isFinite(version.size)) return null;
  return [String(version.mtimeMs), String(version.size), version.sha256].filter(Boolean).join('-');
}

function childSubdir(parent: string | undefined | null, name: string): string {
  const normalizedParent = normalizeSubdir(parent);
  return normalizedParent ? `${normalizedParent}/${name}` : name;
}

function normalizeSubdir(value: string | undefined | null): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinNativePath(rootPath: string, subdir: string): string {
  const separator = rootPath.includes('\\') && !rootPath.includes('/') ? '\\' : '/';
  const root = rootPath.replace(/[\\/]+$/g, '');
  const parts = normalizeSubdir(subdir).split('/').filter(Boolean);
  return [root, ...parts].join(separator);
}

function extOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}
