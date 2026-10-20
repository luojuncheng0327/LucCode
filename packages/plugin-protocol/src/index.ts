export const PLUGIN_UI_PROTOCOL = 'luc.plugin.ui' as const;
export const PLUGIN_UI_PROTOCOL_VERSION = 1 as const;

/**
 * Plugin surface session 的线协议名（#1629）：宿主把会话凭证以
 * `PLUGIN_SURFACE_SESSION_QUERY` 追加在 iframe src 上；iframe 页面调用本插件
 * route handler 时通过 `PLUGIN_SURFACE_SESSION_HEADER`（或同名 query）回传。
 * 服务端、桌面宿主与 iframe SDK 共用这一份定义。
 */
export const PLUGIN_SURFACE_SESSION_HEADER = 'X-Luc-Plugin-Surface-Session' as const;
export const PLUGIN_SURFACE_SESSION_QUERY = 'pluginSurfaceSession' as const;

export const PLUGIN_UI_ERROR_CODE = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  SLOT_DENIED: 'SLOT_DENIED',
  TIMEOUT: 'TIMEOUT',
  HOST_ERROR: 'HOST_ERROR',
} as const;

export const PLUGIN_UI_CAPABILITY = {
  TOAST_SHOW: 'toast.show',
  EXTERNAL_OPEN: 'external.open',
  SESSION_FILE_OPEN: 'sessionFile.open',
  RESOURCE_OPEN: 'resource.open',
  RESOURCE_PICK: 'resource.pick',
  RESOURCE_REQUEST_ACCESS: 'resource.requestAccess',
  UI_RESIZE: 'ui.resize',
  CLIPBOARD_WRITE_TEXT: 'clipboard.writeText',
} as const;

export const PLUGIN_RESOURCE_CAPABILITY = {
  READ: 'resource.read',
  SEARCH: 'resource.search',
  WRITE: 'resource.write',
  MATERIALIZE: 'resource.materialize',
  WATCH: 'resource.watch',
} as const;

export type PluginUiErrorCode =
  (typeof PLUGIN_UI_ERROR_CODE)[keyof typeof PLUGIN_UI_ERROR_CODE];

export type PluginUiCapabilityName =
  (typeof PLUGIN_UI_CAPABILITY)[keyof typeof PLUGIN_UI_CAPABILITY];

export type PluginResourceCapabilityName =
  (typeof PLUGIN_RESOURCE_CAPABILITY)[keyof typeof PLUGIN_RESOURCE_CAPABILITY];

export type PluginResourceRef =
  | { kind: 'local-file'; path: string }
  | { kind: 'mount'; mountId: string; path: string }
  | { kind: 'session-file'; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: 'resource'; resourceId: string }
  | { kind: 'url'; url: string };

export interface PluginResourceVersion {
  mtimeMs?: number;
  size?: number | null;
  sha256?: string;
  etag?: string;
  sequence?: number;
}

export type PluginResourceDescriptor = PluginResourceRef & {
  provider?: string;
  filePath?: string;
  displayName?: string;
};

export interface PluginResourceStat {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  exists: boolean;
  isDirectory: boolean;
  version?: PluginResourceVersion;
  filePath?: string;
}

export interface PluginResourceReadResult {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  content: Uint8Array;
  version?: PluginResourceVersion;
  filePath?: string;
}

export interface PluginResourceMutationResult {
  changeType: 'created' | 'modified';
  resourceKey: string;
  resource: PluginResourceDescriptor;
  version?: PluginResourceVersion;
  filePath?: string;
}

export interface PluginResourceWriteConflictResult {
  ok: false;
  conflict: true;
  resourceKey: string;
  resource: PluginResourceDescriptor;
  version?: PluginResourceVersion;
  filePath?: string;
}

export type PluginResourceWriteExpectedVersionResult =
  | PluginResourceMutationResult
  | PluginResourceWriteConflictResult;

export interface PluginResourceMoveResult {
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: PluginResourceDescriptor;
  newResource: PluginResourceDescriptor;
  oldFilePath?: string;
  newFilePath?: string;
}

export interface PluginResourceTrashOptions {
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface PluginResourceTrashResult {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  trashId: string;
  trashPath?: string;
  payloadPath?: string;
  filePath?: string;
}

export interface PluginResourceEdit {
  oldText: string;
  newText: string;
}

export interface PluginResourceListItem {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mtimeMs: number;
}

export interface PluginResourceListResult {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  items: PluginResourceListItem[];
}

export interface PluginResourceSearchOptions {
  query?: string;
  [key: string]: unknown;
}

export interface PluginResourceSearchMatch {
  filePath: string;
  line: number;
  text: string;
  name?: string;
  relativePath?: string;
  parentSubdir?: string;
  isDirectory?: boolean;
  size?: number | null;
  mtimeMs?: number;
}

export interface PluginResourceSearchResult {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  matches: PluginResourceSearchMatch[];
}

export interface PluginResourceMaterializeResult {
  resourceKey: string;
  resource: PluginResourceDescriptor;
  filePath: string;
  version?: PluginResourceVersion;
}

export interface PluginResourceWatchTarget {
  ref?: PluginResourceRef;
  filePath: string;
  isDirectory?: boolean;
  resourceKey: string;
  resource: PluginResourceDescriptor;
}

export interface PluginResourceEventCursor {
  streamId?: string;
  sequence: number;
  occurredAt?: string;
}

export interface PluginResourceError {
  code: string;
  message: string;
  capability?: PluginResourceCapabilityName | string;
  resource?: PluginResourceDescriptor;
  cursor?: PluginResourceEventCursor;
  safeMessage?: string;
  details?: unknown;
}

export interface PluginResourceOpenInput {
  resource: PluginResourceRef | Record<string, unknown>;
  mode?: 'preview' | 'reveal' | 'download' | string;
}

export interface PluginResourceOpenResult {
  opened: boolean;
}

export interface PluginResourcePickInput {
  mode?: 'file' | 'directory' | string;
  multiple?: boolean;
  capability?: PluginResourceCapabilityName | string;
}

export interface PluginResourcePickResult {
  resources: Array<PluginResourceRef | Record<string, unknown>>;
}

export interface PluginResourceRequestAccessInput {
  capability: PluginResourceCapabilityName | string;
  resource?: PluginResourceRef | Record<string, unknown>;
  reason?: string;
}

export interface PluginResourceRequestAccessResult {
  granted: boolean;
  capability: PluginResourceCapabilityName | string;
}

export type PluginUiSlot = 'page' | 'widget' | 'card' | 'settings';

export type PluginUiMessageKind = 'event' | 'request' | 'response' | 'error';

export interface PluginUiError {
  code: PluginUiErrorCode | string;
  message: string;
  details?: unknown;
}

export interface PluginUiMessage {
  protocol: typeof PLUGIN_UI_PROTOCOL;
  version: typeof PLUGIN_UI_PROTOCOL_VERSION;
  id?: string;
  kind: PluginUiMessageKind;
  type: string;
  payload?: unknown;
  error?: PluginUiError;
}

export type PluginUiParseResult =
  | { ok: true; value: PluginUiMessage }
  | {
      ok: false;
      error: {
        code:
          | typeof PLUGIN_UI_ERROR_CODE.BAD_MESSAGE
          | typeof PLUGIN_UI_ERROR_CODE.UNSUPPORTED_VERSION;
        message: string;
      };
    };

const MESSAGE_KINDS = new Set<PluginUiMessageKind>([
  'event',
  'request',
  'response',
  'error',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function badMessage(message: string): PluginUiParseResult {
  return {
    ok: false,
    error: {
      code: PLUGIN_UI_ERROR_CODE.BAD_MESSAGE,
      message,
    },
  };
}

export function parsePluginUiMessage(value: unknown): PluginUiParseResult {
  if (!isObject(value)) {
    return badMessage('Plugin UI messages must be objects.');
  }

  if (value.protocol !== PLUGIN_UI_PROTOCOL) {
    return badMessage('Plugin UI message protocol is missing or invalid.');
  }

  if (value.version !== PLUGIN_UI_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: PLUGIN_UI_ERROR_CODE.UNSUPPORTED_VERSION,
        message: `Unsupported Plugin UI protocol version: ${String(value.version)}.`,
      },
    };
  }

  if (typeof value.kind !== 'string' || !MESSAGE_KINDS.has(value.kind as PluginUiMessageKind)) {
    return badMessage('Plugin UI message kind is missing or invalid.');
  }

  if (typeof value.type !== 'string' || value.type.trim() === '') {
    return badMessage('Plugin UI message type must be a non-empty string.');
  }

  const kind = value.kind as PluginUiMessageKind;
  if (kind !== 'event' && (typeof value.id !== 'string' || value.id.trim() === '')) {
    return badMessage(`Plugin UI ${kind} messages must include a non-empty id.`);
  }

  if (kind === 'error') {
    if (!isObject(value.error)) {
      return badMessage('Plugin UI error messages must include an error object.');
    }
    if (typeof value.error.code !== 'string' || value.error.code.trim() === '') {
      return badMessage('Plugin UI error code must be a non-empty string.');
    }
    if (typeof value.error.message !== 'string' || value.error.message.trim() === '') {
      return badMessage('Plugin UI error message must be a non-empty string.');
    }
  }

  return {
    ok: true,
    value: value as unknown as PluginUiMessage,
  };
}

export function isPluginUiMessage(value: unknown): value is PluginUiMessage {
  return parsePluginUiMessage(value).ok;
}
