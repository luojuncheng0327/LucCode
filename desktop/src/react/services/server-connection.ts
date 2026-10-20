import { validateStudioConnectionTrust } from './studio-access';
import { SERVER_PROTOCOL_VERSION } from '../../../../shared/contract-versions.ts';

export type StudioConnectionKind = 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud';
export type ServerTrustState = 'local' | 'lan' | 'tunnel' | 'cloud';
export type ServerAuthState = 'anonymous' | 'paired' | 'user' | 'expired';
export type ConnectionCredentialKind = 'none' | 'loopback_token' | 'device_credential' | 'user_session';
export type OfficialServiceKind = 'relay' | 'cloud_studio' | 'inference' | 'billing';
export type ServerConnectionRegistry = Record<string, ServerConnection>;
export type StudioConnection = ServerConnection;
export type StudioConnectionRegistry = ServerConnectionRegistry;

export const LOCAL_CONNECTION_ID = 'local';

export interface ExecutionBoundary {
  schemaVersion: 1;
  boundaryId: string;
  kind: string;
  serverNodeId: string;
  studioId: string;
  workbench?: {
    kind: string;
    root: string | null;
    [key: string]: unknown;
  };
  sandbox?: Record<string, unknown>;
  filesystem?: Record<string, unknown>;
  network?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ServerConnection {
  connectionId: string;
  kind: StudioConnectionKind;
  serverId: string;
  serverNodeId?: string;
  serverNodeKind?: string;
  serverNodeTransport?: string;
  userId?: string;
  studioId: string;
  label: string;
  userLabel?: string;
  studioLabel?: string;
  serverVersion?: string;
  baseUrl: string;
  wsUrl: string;
  token: string | null;
  authState: ServerAuthState;
  trustState: ServerTrustState;
  credentialKind: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  executionBoundary?: ExecutionBoundary;
  capabilities: string[];
}

export interface ServerIdentity {
  connectionKind?: StudioConnectionKind;
  serverId: string;
  serverNodeId?: string;
  serverNodeKind?: string;
  serverNodeTransport?: string;
  userId?: string;
  studioId: string;
  label: string;
  userLabel?: string;
  studioLabel?: string;
  authState?: ServerAuthState;
  trustState?: ServerTrustState;
  credentialKind?: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  executionBoundary?: ExecutionBoundary;
  capabilities?: string[];
  version?: string;
  /** Server build's runtime protocol version (see shared/contract-versions.cjs).
   *  Optional so an older server that predates this field is read-time
   *  compatible: absence means "don't know", not "mismatch". */
  serverProtocol?: number;
}

export interface ServerConnectionSource {
  serverConnections?: ServerConnectionRegistry | null;
  activeServerConnectionId?: string | null;
  activeServerConnection?: ServerConnection | null;
  serverPort?: string | number | null;
  serverToken?: string | null;
}

const LOCAL_CAPABILITIES = ['chat', 'resources', 'files', 'tools'];
const REMOTE_FALLBACK_CAPABILITIES = ['chat'];
const PERSISTED_CONNECTIONS_KEY = 'luc-server-connections-v1';

interface ConnectionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedServerConnectionState {
  serverConnections: ServerConnectionRegistry;
  activeServerConnectionId: string | null;
}

interface BrowserServerConnectionPrincipal {
  kind?: string | null;
  credentialKind?: string | null;
  connectionKind?: string | null;
  trustState?: string | null;
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  platformAccountId?: string | null;
  officialServiceKind?: string | null;
  scopes?: string[] | null;
}

function normalizePort(port: string | number | null | undefined): string | null {
  if (port === null || port === undefined) return null;
  const text = String(port).trim();
  if (!text) return null;

  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid local server port: ${text}`);
  }
  return text;
}

function normalizeToken(token: string | null | undefined): string | null {
  if (token === null || token === undefined || token === '') return null;
  return String(token);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeBaseUrl(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('server URL required');
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('server URL must use http or https');
  }
  parsed.hash = '';
  parsed.search = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = pathname === '/mobile' || pathname === '/desktop' ? '/' : pathname || '/';
  return trimTrailingSlash(parsed.toString());
}

function assertRoutePath(path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`server connection path must start with "/": ${path}`);
  }
}

function appendQueryParam(url: string, key: string, value: string): string {
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const sep = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

export function canUseQueryToken(connection: ServerConnection): boolean {
  return connection.kind === 'local' && connection.credentialKind === 'loopback_token';
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return { ...headers };
}

export function createLocalServerConnection({
  serverPort,
  serverToken,
}: {
  serverPort: string | number | null | undefined;
  serverToken?: string | null;
}): ServerConnection | null {
  const port = normalizePort(serverPort);
  if (!port) return null;

  return {
    connectionId: LOCAL_CONNECTION_ID,
    kind: 'local',
    serverId: 'local',
    studioId: 'local',
    label: 'Local Luc',
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    token: normalizeToken(serverToken),
    authState: 'paired',
    trustState: 'local',
    credentialKind: 'loopback_token',
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: [...LOCAL_CAPABILITIES],
  };
}

export function createBrowserServerConnection({
  identity,
  principal,
  origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1',
}: {
  identity: ServerIdentity;
  principal?: BrowserServerConnectionPrincipal | null;
  origin?: string;
}): ServerConnection {
  const base = trimTrailingSlash(origin);
  const parsed = new URL(base);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${parsed.host}`;
  const kind = normalizeBrowserConnectionKind(
    principal?.connectionKind || identity.connectionKind,
    parsed.hostname,
  );
  const credentialKind = normalizeBrowserCredentialKind(principal?.credentialKind, kind);
  const trustState = normalizeBrowserTrustState(principal?.trustState || identity.trustState, kind);
  const officialServiceKind = normalizeOfficialServiceKind(identity.officialServiceKind ?? principal?.officialServiceKind);
  const platformAccountId = identity.platformAccountId ?? principal?.platformAccountId ?? null;
  const connection: ServerConnection = {
    connectionId: `browser:${identity.serverId || principal?.serverId || parsed.host}`,
    kind,
    serverId: identity.serverId || principal?.serverId || parsed.host,
    serverNodeId: identity.serverNodeId || principal?.serverNodeId || identity.serverId || principal?.serverId || parsed.host,
    serverNodeKind: identity.serverNodeKind,
    serverNodeTransport: identity.serverNodeTransport,
    userId: principal?.userId || identity.userId,
    studioId: identity.studioId || principal?.studioId || 'default',
    label: identity.label || identity.studioLabel || 'Luc Studio',
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    serverVersion: identity.version,
    baseUrl: base,
    wsUrl,
    token: null,
    authState: principal?.kind === 'account_user' ? 'user' : (identity.authState || 'paired'),
    trustState,
    credentialKind,
    platformAccountId,
    officialServiceKind,
    executionBoundary: identity.executionBoundary,
    capabilities: normalizeBrowserCapabilities(identity.capabilities, principal?.scopes),
  };
  validateStudioConnectionTrust(connection);
  return connection;
}

export function createDeviceServerConnection({
  baseUrl,
  credential,
  identity,
}: {
  baseUrl: string;
  credential: string;
  identity: ServerIdentity;
}): ServerConnection {
  const base = normalizeBaseUrl(baseUrl);
  const parsed = new URL(base);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const serverId = identity.serverId || parsed.host;
  const serverNodeId = identity.serverNodeId || serverId;
  const studioId = identity.studioId || 'default';
  const kind = normalizeManualConnectionKind(identity.connectionKind, parsed.hostname);
  const connection: ServerConnection = {
    connectionId: `${kind}:${serverNodeId}:${studioId}`,
    kind,
    serverId,
    serverNodeId,
    serverNodeKind: identity.serverNodeKind,
    serverNodeTransport: identity.serverNodeTransport,
    userId: identity.userId,
    studioId,
    label: identity.studioLabel || identity.label || 'Luc Studio',
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    serverVersion: identity.version,
    baseUrl: base,
    wsUrl: `${wsProtocol}//${parsed.host}`,
    token: normalizeToken(credential),
    authState: identity.authState || 'paired',
    trustState: kind === 'custom_remote' ? 'tunnel' : (identity.trustState || 'lan'),
    credentialKind: 'device_credential',
    platformAccountId: identity.platformAccountId ?? null,
    officialServiceKind: identity.officialServiceKind ?? null,
    executionBoundary: identity.executionBoundary,
    capabilities: normalizeRemoteCapabilities(identity.capabilities),
  };
  validateStudioConnectionTrust(connection);
  return connection;
}

export async function connectDeviceServerConnection({
  baseUrl,
  credential,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
}): Promise<ServerConnection> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const token = normalizeToken(credential);
  if (!token) throw new Error('server access key required');

  await requestJson(fetchImpl, `${normalizedBaseUrl}/api/web-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ credential: token }),
  });

  const identity = await requestJson(fetchImpl, `${normalizedBaseUrl}/api/server/identity`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  }) as ServerIdentity;

  return createDeviceServerConnection({
    baseUrl: normalizedBaseUrl,
    credential: token,
    identity,
  });
}

export function refreshLocalServerConnection({
  existingConnection,
  serverPort,
  serverToken,
}: {
  existingConnection?: ServerConnection | null;
  serverPort: string | number | null | undefined;
  serverToken?: string | null;
}): ServerConnection | null {
  const nextTransport = createLocalServerConnection({ serverPort, serverToken });
  if (!nextTransport) return null;
  if (!existingConnection) return nextTransport;

  return {
    ...existingConnection,
    connectionId: LOCAL_CONNECTION_ID,
    kind: 'local',
    baseUrl: nextTransport.baseUrl,
    wsUrl: nextTransport.wsUrl,
    token: nextTransport.token,
    authState: 'paired',
    trustState: 'local',
    credentialKind: 'loopback_token',
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: existingConnection.capabilities.length
      ? [...existingConnection.capabilities]
      : [...nextTransport.capabilities],
  };
}

export function refreshLocalServerConnectionState({
  serverConnections,
  activeServerConnectionId,
  activeServerConnection,
  serverPort,
  serverToken,
}: ServerConnectionSource): {
  serverConnections: ServerConnectionRegistry;
  activeServerConnectionId: string | null;
  activeServerConnection: ServerConnection | null;
} {
  const existingRegistry = { ...(serverConnections ?? {}) };
  if (activeServerConnection?.connectionId && !existingRegistry[activeServerConnection.connectionId]) {
    existingRegistry[activeServerConnection.connectionId] = activeServerConnection;
  }
  const existingLocal = existingRegistry[LOCAL_CONNECTION_ID]
    ?? (activeServerConnection?.connectionId === LOCAL_CONNECTION_ID ? activeServerConnection : null);
  const localConnection = refreshLocalServerConnection({
    existingConnection: existingLocal,
    serverPort,
    serverToken,
  });
  let nextRegistry = existingRegistry;
  if (localConnection) {
    nextRegistry = upsertServerConnection(nextRegistry, localConnection);
  } else if (nextRegistry[LOCAL_CONNECTION_ID]) {
    nextRegistry = { ...nextRegistry };
    delete nextRegistry[LOCAL_CONNECTION_ID];
  }

  const preferredActive = activeServerConnectionId ? nextRegistry[activeServerConnectionId] : null;
  const fallbackActive = activeServerConnection?.connectionId
    ? nextRegistry[activeServerConnection.connectionId]
    : null;
  const nextActive = preferredActive || fallbackActive || localConnection || null;
  return {
    serverConnections: nextRegistry,
    activeServerConnectionId: nextActive?.connectionId ?? null,
    activeServerConnection: nextActive,
  };
}

function normalizeBrowserConnectionKind(
  value: StudioConnectionKind | string | null | undefined,
  hostname: string,
): StudioConnectionKind {
  if (value === 'local' || value === 'lan' || value === 'custom_remote' || value === 'relay' || value === 'cloud') {
    if (value === 'local' && !isLoopbackHost(hostname)) return 'lan';
    return value;
  }
  return isLoopbackHost(hostname) ? 'local' : 'lan';
}

function normalizeManualConnectionKind(
  value: StudioConnectionKind | string | null | undefined,
  hostname: string,
): StudioConnectionKind {
  if (value === 'custom_remote' || value === 'relay' || value === 'cloud') return value;
  if (value === 'local' && isLoopbackHost(hostname)) return 'local';
  return 'lan';
}

function normalizeBrowserTrustState(
  value: ServerTrustState | string | null | undefined,
  kind: StudioConnectionKind,
): ServerTrustState {
  if (kind === 'local') return 'local';
  if (kind === 'lan') return 'lan';
  if (kind === 'custom_remote' || kind === 'relay') return 'tunnel';
  if (kind === 'cloud') return 'cloud';
  if (value === 'local' || value === 'lan' || value === 'tunnel' || value === 'cloud') return value;
  return 'lan';
}

function normalizeBrowserCredentialKind(
  value: string | null | undefined,
  kind: StudioConnectionKind,
): ConnectionCredentialKind {
  if (kind === 'local') return 'loopback_token';
  if (value === 'password' || value === 'user_session') return 'user_session';
  if (kind === 'relay' || kind === 'cloud') return 'user_session';
  return 'device_credential';
}

function normalizeOfficialServiceKind(value: string | null | undefined): OfficialServiceKind | null {
  if (value === 'relay' || value === 'cloud_studio' || value === 'inference' || value === 'billing') return value;
  return null;
}

function normalizeBrowserCapabilities(
  identityCapabilities: string[] | null | undefined,
  scopes: string[] | null | undefined,
): string[] {
  const out = new Set(identityCapabilities?.length ? identityCapabilities : LOCAL_CAPABILITIES);
  for (const scope of scopes || []) {
    addScopeCapability(out, scope);
  }
  return [...out];
}

function normalizeRemoteCapabilities(identityCapabilities: string[] | null | undefined): string[] {
  if (!Array.isArray(identityCapabilities) || identityCapabilities.length === 0) {
    return [...REMOTE_FALLBACK_CAPABILITIES];
  }
  const out = new Set<string>();
  for (const capability of identityCapabilities) {
    addScopeCapability(out, capability);
  }
  return out.size > 0 ? [...out] : [...REMOTE_FALLBACK_CAPABILITIES];
}

function addScopeCapability(out: Set<string>, capability: string): void {
  if (!capability) return;
  out.add(capability);
  if (capability === 'chat') out.add('chat');
  else if (capability === 'resources' || capability.startsWith('resources.')) out.add('resources');
  else if (capability === 'files' || capability.startsWith('files.')) out.add('files');
  else if (capability === 'tools' || capability.startsWith('tools.')) out.add('tools');
  else if (capability === 'settings' || capability.startsWith('settings.')) out.add('settings');
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function resolveServerConnection(source: ServerConnectionSource): ServerConnection | null {
  if (source.activeServerConnectionId) {
    const registryConnection = source.serverConnections?.[source.activeServerConnectionId];
    if (registryConnection) return registryConnection;
  }
  if (source.activeServerConnection) return source.activeServerConnection;
  return createLocalServerConnection({
    serverPort: source.serverPort,
    serverToken: source.serverToken,
  });
}

export function requireServerConnection(
  source: ServerConnectionSource,
  errorMessage: string,
): ServerConnection {
  const connection = resolveServerConnection(source);
  if (!connection) throw new Error(errorMessage);
  return connection;
}

export function hasServerConnection(source: ServerConnectionSource): boolean {
  return !!resolveServerConnection(source);
}

export function isLocalOwnerConnection(connection: ServerConnection | null | undefined): boolean {
  return connection?.kind === 'local' && connection.credentialKind === 'loopback_token';
}

export function upsertServerConnection(
  registry: ServerConnectionRegistry | null | undefined,
  connection: ServerConnection,
): ServerConnectionRegistry {
  if (!connection.connectionId) {
    throw new Error('server connection requires connectionId');
  }
  validateStudioConnectionTrust(connection);
  return {
    ...(registry ?? {}),
    [connection.connectionId]: connection,
  };
}

export function readPersistedServerConnectionState(
  storage: ConnectionStorageLike | null | undefined = getDefaultStorage(),
): PersistedServerConnectionState {
  if (!storage) return { serverConnections: {}, activeServerConnectionId: null };
  try {
    const raw = storage.getItem(PERSISTED_CONNECTIONS_KEY);
    if (!raw) return { serverConnections: {}, activeServerConnectionId: null };
    const parsed = JSON.parse(raw);
    const registry: ServerConnectionRegistry = {};
    for (const connection of Object.values(parsed?.serverConnections || {}) as ServerConnection[]) {
      if (!connection || connection.kind === 'local') continue;
      registry[connection.connectionId] = connection;
      validateStudioConnectionTrust(connection);
    }
    const activeServerConnectionId = typeof parsed?.activeServerConnectionId === 'string'
      && registry[parsed.activeServerConnectionId]
      ? parsed.activeServerConnectionId
      : null;
    return { serverConnections: registry, activeServerConnectionId };
  } catch {
    return { serverConnections: {}, activeServerConnectionId: null };
  }
}

export function writePersistedServerConnectionState(
  state: PersistedServerConnectionState,
  storage: ConnectionStorageLike | null | undefined = getDefaultStorage(),
): void {
  if (!storage) return;
  const serverConnections: ServerConnectionRegistry = {};
  for (const connection of Object.values(state.serverConnections || {})) {
    if (!connection || connection.kind === 'local') continue;
    validateStudioConnectionTrust(connection);
    serverConnections[connection.connectionId] = connection;
  }
  const activeServerConnectionId = state.activeServerConnectionId && serverConnections[state.activeServerConnectionId]
    ? state.activeServerConnectionId
    : null;
  if (Object.keys(serverConnections).length === 0 && !activeServerConnectionId) {
    storage.removeItem(PERSISTED_CONNECTIONS_KEY);
    return;
  }
  storage.setItem(PERSISTED_CONNECTIONS_KEY, JSON.stringify({
    schemaVersion: 1,
    serverConnections,
    activeServerConnectionId,
  }));
}

export function persistServerConnectionSelection(
  connection: ServerConnection,
  storage: ConnectionStorageLike | null | undefined = getDefaultStorage(),
): PersistedServerConnectionState {
  const previous = readPersistedServerConnectionState(storage);
  const next = {
    serverConnections: upsertServerConnection(previous.serverConnections, connection),
    activeServerConnectionId: connection.connectionId,
  };
  writePersistedServerConnectionState(next, storage);
  return next;
}

export function mergeServerIdentity(
  connection: ServerConnection,
  identity: ServerIdentity,
): ServerConnection {
  const nodeScope = {
    ...(identity.serverNodeId !== undefined ? { serverNodeId: identity.serverNodeId } : {}),
    ...(identity.serverNodeKind !== undefined ? { serverNodeKind: identity.serverNodeKind } : {}),
    ...(identity.serverNodeTransport !== undefined ? { serverNodeTransport: identity.serverNodeTransport } : {}),
    ...(identity.executionBoundary !== undefined ? { executionBoundary: identity.executionBoundary } : {}),
  };
  const next = {
    ...connection,
    kind: identity.connectionKind || connection.kind,
    serverId: identity.serverId,
    ...nodeScope,
    userId: identity.userId,
    studioId: identity.studioId,
    label: identity.label,
    userLabel: identity.userLabel,
    studioLabel: identity.studioLabel,
    serverVersion: identity.version,
    authState: identity.authState || connection.authState,
    trustState: identity.trustState || connection.trustState,
    credentialKind: identity.credentialKind || connection.credentialKind,
    platformAccountId: identity.platformAccountId ?? connection.platformAccountId ?? null,
    officialServiceKind: identity.officialServiceKind ?? connection.officialServiceKind ?? null,
    capabilities: identity.capabilities ? [...identity.capabilities] : [...connection.capabilities],
  };
  validateStudioConnectionTrust(next);
  return next;
}

/**
 * Diagnostic-only runtime handshake: this build's renderer and server are
 * always shipped together, so a mismatch here can only mean the running
 * install got into an inconsistent state (a botched manual copy, a
 * self-hosted server pinned to a different release, an update that only
 * landed on one side). It is NOT a gate — the activation-time preload
 * contract check (shared/contract-versions.cjs, artifact-ota.cjs) is what
 * actually keeps that from happening during normal updates; this function
 * only makes an already-running mismatch visible instead of silent. Never
 * call this to decide whether to block or retry anything.
 *
 * An identity response with no `serverProtocol` field (a server built
 * before this handshake existed) is read-time compatible: silently skip
 * the comparison rather than warning about an old server that was never
 * wrong to begin with.
 */
export function warnIfServerProtocolMismatch(identity: ServerIdentity, log: (message: string) => void = console.error): void {
  if (typeof identity.serverProtocol !== 'number') return;
  if (identity.serverProtocol === SERVER_PROTOCOL_VERSION) return;
  log(
    `[server-identity] 界面与服务进程版本偏斜：界面期望的运行时协议版本是 ${SERVER_PROTOCOL_VERSION}，`
      + `但当前连接的服务进程返回的是 ${identity.serverProtocol}。这通常发生在自动更新只更新了`
      + '一侧（界面或服务进程），或者连接的是版本不同的自托管服务；仅记录该信息用于排查，不会中断当前运行。',
  );
}

export function buildConnectionUrl(
  connection: ServerConnection,
  path: string,
  opts: { includeTokenQuery?: boolean } = {},
): string {
  assertRoutePath(path);
  const url = `${trimTrailingSlash(connection.baseUrl)}${path}`;
  if (!opts.includeTokenQuery || !connection.token || !canUseQueryToken(connection)) return url;
  return appendQueryParam(url, 'token', connection.token);
}

export function buildConnectionWsUrl(
  connection: ServerConnection,
  path = '/ws',
  opts: { wsTicket?: string | null } = {},
): string {
  assertRoutePath(path);
  const url = `${trimTrailingSlash(connection.wsUrl)}${path}`;
  if (opts.wsTicket) return appendQueryParam(url, 'wsTicket', opts.wsTicket);
  if (!connection.token || !canUseQueryToken(connection)) return url;
  return appendQueryParam(url, 'token', connection.token);
}

export async function requestConnectionWsTicket(
  connection: ServerConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (canUseQueryToken(connection)) return null;
  const res = await fetchImpl(buildConnectionUrl(connection, '/api/ws-ticket'), {
    method: 'POST',
    headers: appendConnectionAuth(connection, { 'Content-Type': 'application/json' }),
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error(`websocket ticket request failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return typeof body?.ticket === 'string' && body.ticket.trim() ? body.ticket : null;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function buildScopedConnectSources(connection: ServerConnection | null | undefined): string[] {
  if (!connection || connection.kind === 'local') return [];
  const out = new Set<string>();
  const baseOrigin = originOf(connection.baseUrl);
  const wsOrigin = originOf(connection.wsUrl);
  if (baseOrigin) out.add(baseOrigin);
  if (wsOrigin) out.add(wsOrigin);
  if (baseOrigin && !wsOrigin) {
    const base = new URL(baseOrigin);
    out.add(`${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}`);
  }
  return [...out];
}

export function appendConnectionAuth(
  connection: ServerConnection,
  headers?: HeadersInit,
): Record<string, string> {
  const next = headersToRecord(headers);
  if (connection.token) {
    next.Authorization = `Bearer ${connection.token}`;
  }
  return next;
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`server connection request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function getDefaultStorage(): ConnectionStorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
