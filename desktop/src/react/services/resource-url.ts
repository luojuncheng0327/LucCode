import type { FileRef } from '../types/file-ref';
import { buildConnectionUrl, isLocalOwnerConnection, type ServerConnection } from './server-connection';

export type FileRefUrlMode = 'local-file' | 'resource-content' | 'inline-data';

export interface FileRefUrlResult {
  mode: FileRefUrlMode;
  url: string;
}

export interface ResourceUrlPlatform {
  getFileUrl?: (path: string) => string;
}

export function resolveFileRefUrl(ref: FileRef, {
  connection,
  platform,
  preferLocalFile = true,
}: {
  connection?: ServerConnection | null;
  platform?: ResourceUrlPlatform | null;
  preferLocalFile?: boolean;
}): FileRefUrlResult {
  const isLocalTransport = !connection || isLocalOwnerConnection(connection);
  const getFileUrl = platform?.getFileUrl;
  const canUseLocalFile = preferLocalFile
    && isLocalTransport
    && !!ref.path
    && typeof getFileUrl === 'function';

  if (canUseLocalFile) {
    return { mode: 'local-file', url: appendFileRefVersion(getFileUrl(ref.path), ref) };
  }

  const resource = ref.resource;
  const contentLink = resource?.links.content;
  if (contentLink) {
    if (!connection) {
      throw new Error(`resource URL requires server connection: ${resource.resourceId}`);
    }
    return {
      mode: 'resource-content',
      url: appendFileRefVersion(buildConnectionUrl(connection, contentLink, { includeTokenQuery: true }), ref),
    };
  }

  if (ref.inlineData) {
    return {
      mode: 'inline-data',
      url: `data:${ref.inlineData.mimeType};base64,${ref.inlineData.base64}`,
    };
  }

  if (ref.path && isLocalTransport) {
    if (typeof getFileUrl !== 'function') {
      throw new Error('platform.getFileUrl not available and resource content link missing');
    }
    return { mode: 'local-file', url: appendFileRefVersion(getFileUrl(ref.path), ref) };
  }

  if (ref.path) {
    throw new Error(`remote file ref requires resource content link: ${ref.id}`);
  }

  throw new Error(`file ref lacks local path, resource content link, and inline data: ${ref.id}`);
}

export function fileRefVersionToken(ref: Pick<FileRef, 'version'>): string | null {
  const version = ref.version;
  if (!version || typeof version.mtimeMs !== 'number' || typeof version.size !== 'number') return null;
  if (!Number.isFinite(version.mtimeMs) || !Number.isFinite(version.size)) return null;
  const parts = [String(version.mtimeMs), String(version.size)];
  if (version.sha256) parts.push(version.sha256);
  return parts.join('-');
}

function appendFileRefVersion(url: string, ref: FileRef): string {
  const token = fileRefVersionToken(ref);
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', token);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${encodeURIComponent(token)}`;
  }
}
