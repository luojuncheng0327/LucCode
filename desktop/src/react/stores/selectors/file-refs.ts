import type { FileRef } from '../../types/file-ref';
import type { DeskFile, FileVersion } from '../../types';
import type { ChatListItem, ContentBlock, ResourceEnvelope, SessionRegistryFile } from '../chat-types';
import { inferKindByExt, buildFileRefId } from '../../utils/file-kind';
import { sessionScopedKey, sessionScopedValue, type SessionLocatorState } from '../session-slice';

type StateShape = {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskWorkspaceMountId?: string | null;
  deskCurrentPath: string;
  chatSessions?: Record<string, unknown>;
  sessionRegistryFilesByPath?: Record<string, readonly SessionRegistryFile[] | undefined>;
} & SessionLocatorState;

function joinPath(base: string, sub: string, name: string): string {
  // 保持 OS 原生习惯：仅用正斜杠拼接（preload 层自行适配 Windows 反斜杠）。
  // UNC 路径（Windows 网络盘，如 //server/share/...）的前导 `//` 必须保留，
  // 否则 pathToFileUrl 的 UNC 分支（要求 `//` 前缀）匹配不上，网络盘图片预览会坏。
  const joined = [base, sub, name].filter(Boolean).join('/');
  return joined.startsWith('//')
    ? '//' + joined.slice(2).replace(/\/+/g, '/')
    : joined.replace(/\/+/g, '/');
}

function extOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  return name.slice(dot + 1);
}

// ── Desk ──

let cachedDesk: { files: DeskFile[]; basePath: string; result: FileRef[] } | null = null;

export function selectDeskFiles(state: StateShape): FileRef[] {
  const { deskFiles, deskBasePath, deskWorkspaceMountId } = state;
  if (deskWorkspaceMountId) return [];
  if (
    cachedDesk
    && cachedDesk.files === deskFiles
    && cachedDesk.basePath === deskBasePath
  ) {
    return cachedDesk.result;
  }
  const result: FileRef[] = [];
  for (const f of deskFiles) {
    if (f.isDir) continue;
    const path = joinPath(deskBasePath, '', f.name);
    const ext = extOf(f.name);
    result.push({
      id: buildFileRefId({ source: 'desk', path }),
      kind: inferKindByExt(ext),
      source: 'desk',
      name: f.name,
      path,
      ext,
      version: versionFromDeskFile(f),
    });
  }
  cachedDesk = { files: deskFiles, basePath: deskBasePath, result };
  return result;
}

// ── Session ──

type SessionStateShape = StateShape & {
  chatSessions?: Record<string, { items: ChatListItem[] } | undefined>;
};

const cachedSession = new Map<string, {
  sessionPath: string;
  sessionKey: string;
  includeUnlisted: boolean;
  items: readonly ChatListItem[];
  registryFiles: readonly SessionRegistryFile[];
  result: FileRef[];
}>();
const EMPTY_SESSION_RESULT: readonly FileRef[] = Object.freeze([]);
const EMPTY_REGISTRY_FILES: readonly SessionRegistryFile[] = Object.freeze([]);
const EMPTY_CHAT_ITEMS: readonly ChatListItem[] = Object.freeze([]);

/**
 * 清理 session → FileRef[] 缓存。必须由 session 生命周期持有方（chat-slice）
 * 在 clearSession / LRU eviction 时主动调用，否则 cachedSession 只增不减，
 * 长期会让 FileRef.inlineData 里的 base64 载荷在 renderer 里滞留。
 *
 * 不传 sessionPath 时清空整张 Map（用于登出 / 切换 workspace）。
 */
export function invalidateSessionCache(sessionPath?: string): void {
  if (sessionPath == null) {
    cachedSession.clear();
    return;
  }
  for (const [key, cached] of cachedSession) {
    if (cached.sessionPath === sessionPath || cached.sessionKey === sessionPath) cachedSession.delete(key);
  }
}

export function selectSessionFiles(
  state: SessionStateShape,
  sessionPath: string,
  options: { includeUnlisted?: boolean } = {},
): readonly FileRef[] {
  const includeUnlisted = options.includeUnlisted === true;
  const sessionKey = sessionScopedKey(state, sessionPath) || sessionPath;
  const items = sessionScopedValue(state, state.chatSessions, sessionPath)?.items || EMPTY_CHAT_ITEMS;
  const registryFiles = sessionScopedValue(state, state.sessionRegistryFilesByPath, sessionPath) || EMPTY_REGISTRY_FILES;
  if (!items.length && !registryFiles.length) return EMPTY_SESSION_RESULT;
  const cacheKey = sessionCacheKey(sessionKey, includeUnlisted);
  const cached = cachedSession.get(cacheKey);
  if (cached && cached.items === items && cached.registryFiles === registryFiles) return cached.result;

  const result: FileRef[] = [];
  const seen = new Set<string>();

  for (const file of registryFiles) {
    if (file.isDirectory) continue;
    if (!includeUnlisted && isUnlistedSessionFile(file)) continue;
    const filePath = file.filePath || file.realPath || '';
    if (!filePath) continue;
    const fileId = file.fileId || file.id;
    const name = file.label || file.displayName || file.filename || basenameOf(filePath);
    const ext = file.ext || extOf(name) || extOf(filePath);
    const legacyFileIds = nonEmptyStrings(file.legacyFileIds);
    const legacyFilePaths = nonEmptyStrings(file.legacyFilePaths);
    pushUniqueFile(result, seen, {
      id: buildFileRefId({
        source: 'session-registry',
        sessionKey,
        path: filePath,
        ...(fileId ? { messageId: fileId } : {}),
      }),
      fileId,
      ...(legacyFileIds.length ? { legacyFileIds } : {}),
      ...(legacyFilePaths.length ? { legacyFilePaths } : {}),
      kind: inferKindByExt(ext),
      source: 'session-registry',
      name,
      path: filePath,
      ext,
      mime: file.mime,
      status: file.status,
      missingAt: file.missingAt,
      origin: file.origin,
      operations: file.operations,
      presentation: presentationOf(file),
      listed: listedOf(file),
      createdAt: file.createdAt,
      timestamp: file.createdAt,
      version: versionFromSessionFile(file),
      resource: compactResourceRef(file.resource),
    });
  }

  for (const item of items) {
    if (item.type !== 'message') continue;
    const msg = item.data;

    // attachments 在前
    if (msg.attachments) {
      for (const att of msg.attachments) {
        if (att.isDir) continue;
        if (!includeUnlisted && isUnlistedSessionFile(att)) continue;
        const ext = extOf(att.name);
        pushUniqueFile(result, seen, {
          id: buildFileRefId({
            source: 'session-attachment',
            sessionKey,
            messageId: msg.id, path: att.path,
          }),
          fileId: att.fileId,
          kind: inferKindByExt(ext),
          source: 'session-attachment',
          name: att.name,
          path: att.path,
          ext,
          mime: att.mimeType,
          status: att.status,
          missingAt: att.missingAt,
          presentation: presentationOf(att),
          listed: listedOf(att),
          timestamp: msg.timestamp,
          sessionMessageId: msg.id,
          inlineData: att.base64Data && att.mimeType
            ? { base64: att.base64Data, mimeType: att.mimeType }
            : undefined,
        });
      }
    }

    // blocks 在后
    if (msg.blocks) {
      for (let i = 0; i < msg.blocks.length; i++) {
        const b: ContentBlock = msg.blocks[i];
        if (b.type === 'file') {
          pushUniqueFile(result, seen, {
            id: buildFileRefId({
              source: 'session-block-file',
              sessionKey,
              messageId: msg.id, blockIdx: i, path: b.filePath,
            }),
            fileId: b.fileId,
            kind: inferKindByExt(b.ext),
            source: 'session-block-file',
            name: b.label || b.filePath.split('/').pop() || b.filePath,
            path: b.filePath,
            ext: b.ext,
            mime: b.mime,
            status: b.status,
            missingAt: b.missingAt,
            presentation: presentationOf(b),
            listed: listedOf(b),
            resource: compactResourceRef(b.resource),
            version: versionFromSessionFile(b),
            timestamp: msg.timestamp,
            sessionMessageId: msg.id,
            sessionBlockIdx: i,
          });
        } else if (b.type === 'artifact' && b.filePath) {
          const ext = b.ext || extOf(b.filePath);
          pushUniqueFile(result, seen, {
            id: buildFileRefId({
              source: 'session-block-legacy-artifact',
              sessionKey,
              messageId: msg.id, blockIdx: i, path: b.filePath,
            }),
            fileId: b.fileId,
            kind: inferKindByExt(ext),
            source: 'session-block-legacy-artifact',
            name: b.title || b.label || b.filePath.split('/').pop() || b.filePath,
            path: b.filePath,
            ext,
            mime: b.mime,
            status: b.status,
            missingAt: b.missingAt,
            presentation: presentationOf(b),
            listed: listedOf(b),
            resource: compactResourceRef(b.resource),
            version: versionFromSessionFile(b),
            timestamp: msg.timestamp,
            sessionMessageId: msg.id,
            sessionBlockIdx: i,
          });
        } else if (b.type === 'screenshot') {
          result.push({
            id: buildFileRefId({
              source: 'session-block-screenshot',
              sessionKey,
              messageId: msg.id, blockIdx: i, path: '',
            }),
            kind: 'image',
            source: 'session-block-screenshot',
            name: `screenshot-${msg.id}-${i}.png`,
            path: '',
            mime: b.mimeType,
            timestamp: msg.timestamp,
            sessionMessageId: msg.id,
            sessionBlockIdx: i,
            inlineData: { base64: b.base64, mimeType: b.mimeType },
          });
        }
      }
    }
  }

  cachedSession.set(cacheKey, { sessionPath, sessionKey, includeUnlisted, items, registryFiles, result });
  return result;
}

function sessionCacheKey(sessionKey: string, includeUnlisted: boolean): string {
  return `${includeUnlisted ? 'all' : 'listed'}\u0000${sessionKey}`;
}

function presentationOf(file: { presentation?: string } | undefined): string {
  return file?.presentation === 'voice-input' ? 'voice-input' : 'attachment';
}

function listedOf(file: { listed?: boolean; presentation?: string } | undefined): boolean {
  if (file?.listed === false) return false;
  return presentationOf(file) !== 'voice-input';
}

function isUnlistedSessionFile(file: { listed?: boolean; presentation?: string } | undefined): boolean {
  return !listedOf(file);
}

function basenameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/** 账本里的别名列表可能缺失、含空串，或者根本不是数组（老数据）。 */
function nonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function versionFromDeskFile(file: DeskFile): FileVersion | undefined {
  const mtimeMs = typeof file.mtime === 'string' ? Date.parse(file.mtime) : NaN;
  if (!Number.isFinite(mtimeMs) || typeof file.size !== 'number') return undefined;
  return { mtimeMs, size: file.size };
}

function versionFromSessionFile(file: {
  version?: FileVersion | null;
  mtimeMs?: number;
  size?: number | null;
  resource?: ResourceEnvelope;
}): FileVersion | undefined {
  if (isFileVersion(file.version)) return file.version;
  const mtimeMs = typeof file.mtimeMs === 'number'
    ? file.mtimeMs
    : typeof file.resource?.mtimeMs === 'number'
      ? file.resource.mtimeMs
      : NaN;
  const size = typeof file.size === 'number'
    ? file.size
    : typeof file.resource?.size === 'number'
      ? file.resource.size
      : NaN;
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return undefined;
  return { mtimeMs, size };
}

function isFileVersion(value: unknown): value is FileVersion {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FileVersion>;
  return typeof candidate.mtimeMs === 'number'
    && Number.isFinite(candidate.mtimeMs)
    && typeof candidate.size === 'number'
    && Number.isFinite(candidate.size);
}

function compactResourceRef(resource: ResourceEnvelope | undefined): FileRef['resource'] | undefined {
  if (!resource?.resourceId || !resource.studioId || !resource.links?.self) return undefined;
  return {
    resourceId: resource.resourceId,
    studioId: resource.studioId,
    links: {
      self: resource.links.self,
      ...(resource.links.content ? { content: resource.links.content } : {}),
    },
  };
}

function fileIdentityKeys(ref: FileRef): string[] {
  const keys: string[] = [];
  if (ref.fileId) keys.push(`id:${ref.fileId}`);
  for (const legacyId of ref.legacyFileIds || []) {
    if (legacyId) keys.push(`id:${legacyId}`);
  }
  if (ref.path) keys.push(`path:${ref.path}`);
  for (const legacyPath of ref.legacyFilePaths || []) {
    if (legacyPath) keys.push(`path:${legacyPath}`);
  }
  return keys;
}

function pushUniqueFile(result: FileRef[], seen: Set<string>, ref: FileRef): void {
  const keys = fileIdentityKeys(ref);
  if (keys.some(key => seen.has(key))) return;
  for (const key of keys) seen.add(key);
  result.push(ref);
}
