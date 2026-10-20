import type {
  PluginResourceDescriptor,
  PluginResourceEdit,
  PluginResourceListItem,
  PluginResourceListResult,
  PluginResourceMaterializeResult,
  PluginResourceMoveResult,
  PluginResourceReadResult,
  PluginResourceRef,
  PluginResourceSearchMatch,
  PluginResourceSearchOptions,
  PluginResourceSearchResult,
  PluginResourceStat,
  PluginResourceTrashOptions,
  PluginResourceTrashResult,
  PluginResourceVersion,
  PluginResourceWatchTarget,
  PluginResourceWriteConflictResult,
  PluginResourceWriteExpectedVersionResult,
  PluginResourceMutationResult,
} from '@luccode/plugin-protocol';

export type MaybePromise<T> = T | Promise<T>;

export type JsonSchema = Record<string, unknown>;

export const LUC_BUS_SKIP = Symbol.for('luc.event-bus.skip');

export interface LucToolResult {
  content?: Array<Record<string, unknown>>;
  details?: Record<string, unknown>;
}

export interface LucSessionRef {
  sessionId: string;
  sessionPath?: string | null;
  legacySessionPath?: string | null;
}

export type LucSessionTarget = string | LucSessionRef | {
  sessionId?: string | null;
  sessionPath?: string | null;
  path?: string | null;
  legacySessionPath?: string | null;
};

export interface LucSessionFile {
  id?: string | null;
  fileId?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  realPath?: string;
  displayName?: string;
  filename?: string;
  label?: string;
  ext?: string | null;
  mime?: string;
  size?: number;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: unknown[];
  createdAt?: number | string;
  storageKind?: string;
  status?: string;
  missingAt?: number | string | null;
  resource?: LucResourceEnvelope;
  [key: string]: unknown;
}

export interface LucResourceEnvelope {
  schemaVersion: 1;
  resourceId: string;
  name: string;
  studioId: string;
  type: 'file' | string;
  source: 'session_file' | string;
  sourceId?: string;
  fileId?: string;
  displayName?: string;
  filename?: string;
  ext?: string | null;
  mime?: string;
  size?: number | null;
  kind?: string;
  isDirectory?: boolean;
  origin?: string;
  operations?: string[];
  createdAt?: number | string;
  mtimeMs?: number;
  lifecycle: {
    status: string;
    missingAt: number | string | null;
  };
  storage: {
    provider: string;
    storageKind?: string;
    localOnly?: boolean;
  };
  links: {
    self: string;
    content?: string;
  };
  [key: string]: unknown;
}

export type LucResourceRef = PluginResourceRef;
export type LucResourceVersion = PluginResourceVersion;
export type LucResourceDescriptor = PluginResourceDescriptor;
export type LucResourceStat = PluginResourceStat;
export type LucResourceReadResult = PluginResourceReadResult;
export type LucResourceMutationResult = PluginResourceMutationResult;
export type LucResourceWriteConflictResult = PluginResourceWriteConflictResult;
export type LucResourceWriteExpectedVersionResult = PluginResourceWriteExpectedVersionResult;
export type LucResourceMoveResult = PluginResourceMoveResult;
export type LucResourceTrashOptions = PluginResourceTrashOptions;
export type LucResourceTrashResult = PluginResourceTrashResult;
export type LucResourceEdit = PluginResourceEdit;
export type LucResourceListItem = PluginResourceListItem;
export type LucResourceListResult = PluginResourceListResult;
export type LucResourceSearchOptions = PluginResourceSearchOptions;
export type LucResourceSearchMatch = PluginResourceSearchMatch;
export type LucResourceSearchResult = PluginResourceSearchResult;
export type LucResourceMaterializeResult = PluginResourceMaterializeResult;
export type LucResourceWatchTarget = PluginResourceWatchTarget;

export interface LucPluginResourceMutationOptions {
  emit?: boolean;
}

export interface LucPluginResourceWatchOptions {
  purpose?: string | null;
  sessionRef?: LucSessionRef | { sessionPath?: string | null; path?: string | null } | null;
  /** @deprecated Prefer sessionId/sessionRef on the invocation context. */
  sessionPath?: string | null;
}

export interface LucResourceWatchSubscription {
  subscriptionId: string;
  resourceKeys: string[];
  unsubscribe(): boolean;
  close(): boolean;
}

export interface LucPluginResources {
  stat(ref: LucResourceRef | Record<string, unknown>): Promise<LucResourceStat>;
  read(ref: LucResourceRef | Record<string, unknown>): Promise<LucResourceReadResult>;
  list(ref: LucResourceRef | Record<string, unknown>): Promise<LucResourceListResult>;
  search(ref: LucResourceRef | Record<string, unknown>, options?: LucResourceSearchOptions): Promise<LucResourceSearchResult>;
  materialize(ref: LucResourceRef | Record<string, unknown>): Promise<LucResourceMaterializeResult>;
  write(ref: LucResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, options?: LucPluginResourceMutationOptions): Promise<LucResourceMutationResult>;
  writeExpectedVersion(ref: LucResourceRef | Record<string, unknown>, content: string | Uint8Array | ArrayBuffer, expectedVersion: LucResourceVersion, options?: LucPluginResourceMutationOptions): Promise<LucResourceWriteExpectedVersionResult>;
  edit(ref: LucResourceRef | Record<string, unknown>, edits: LucResourceEdit[], options?: LucPluginResourceMutationOptions): Promise<LucResourceMutationResult>;
  mkdir(ref: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceMutationOptions): Promise<LucResourceMutationResult>;
  delete(ref: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceMutationOptions): Promise<LucResourceMutationResult>;
  copy(from: LucResourceRef | Record<string, unknown>, to: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceMutationOptions): Promise<LucResourceMutationResult>;
  rename(from: LucResourceRef | Record<string, unknown>, to: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceMutationOptions): Promise<LucResourceMoveResult>;
  move(from: LucResourceRef | Record<string, unknown>, to: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceMutationOptions): Promise<LucResourceMoveResult>;
  trash(ref: LucResourceRef | Record<string, unknown>, trashOptions?: LucResourceTrashOptions, options?: LucPluginResourceMutationOptions): Promise<LucResourceTrashResult>;
  watch(ref: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceWatchOptions): LucResourceWatchSubscription;
  subscribe(resources: Array<LucResourceRef | Record<string, unknown>>, options?: LucPluginResourceWatchOptions): LucResourceWatchSubscription;
  resolveWatchTarget?(ref: LucResourceRef | Record<string, unknown>, options?: LucPluginResourceWatchOptions): LucResourceWatchTarget;
}

export interface LucExecutionBoundary {
  schemaVersion: 1;
  boundaryId: string;
  kind: 'local_process' | string;
  serverNodeId: string;
  studioId: string;
  workbench?: {
    kind: string;
    root: string | null;
    [key: string]: unknown;
  };
  sandbox?: {
    kind: string;
    enforcedBy?: string;
    [key: string]: unknown;
  };
  filesystem?: {
    policy: string;
    [key: string]: unknown;
  };
  network?: {
    policy: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LucSessionFileMediaItem {
  type: 'session_file';
  fileId: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  filePath?: string;
  label?: string;
  mime?: string;
  size?: number;
  kind?: string;
  [key: string]: unknown;
}

export interface LucStagedSessionFile {
  file?: LucSessionFile | null;
  sessionFile?: LucSessionFile | null;
  mediaItem: LucSessionFileMediaItem;
}

export interface LucMediaDetails {
  media: {
    items: LucSessionFileMediaItem[];
  };
}

export interface LucChatSurfaceCardOptions {
  title?: string;
  description?: string;
  mode?: 'transcript' | 'full' | string;
  composer?: boolean;
  aspectRatio?: string;
}

export interface LucChatSurfaceCardDetails {
  type: 'chat.surface';
  pluginId: string;
  sessionId: string;
  sessionRef: LucSessionRef;
  sessionPath?: string;
  title?: string;
  description: string;
  mode: 'transcript' | 'full' | string;
  composer?: boolean;
  aspectRatio?: string;
}

export interface LucPluginNetworkFetchInit extends RequestInit {
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
}

export interface LucPluginNetwork {
  fetch(input: string | URL | Request, init?: LucPluginNetworkFetchInit): Promise<Response>;
}

export interface LucToolContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: LucExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: LucSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: LucEventBus;
  network: LucPluginNetwork;
  resources: LucPluginResources;
  config: LucPluginConfigStore;
  log: LucPluginLogger;
  registerSessionFile?: (input: Record<string, unknown>) => LucSessionFile;
  stageFile?: (input: Record<string, unknown>) => LucStagedSessionFile;
  [key: string]: unknown;
}

export type LucToolSessionPermissionKind =
  | 'read'
  | 'read_only'
  | 'plugin_output'
  | 'session_file_output'
  | 'workspace_write'
  | 'external_side_effect'
  | 'review'
  | string;

export type LucToolInvocationKind = 'read' | 'routine' | 'review';

export type LucToolInvocationTargetType =
  | 'url'
  | 'browser_tab'
  | 'background_task'
  | 'channel'
  | 'channel_draft'
  | 'agent'
  | 'notification_route'
  | 'setting'
  | 'memory_store'
  | 'pinned_memory_item'
  | 'pinned_memory_query'
  | 'experience_category'
  | 'session_files'
  | 'terminal_process';

export interface LucToolInvocationTarget {
  type: LucToolInvocationTargetType;
  /** Exact wildcard-free identity, limited by the host to 4096 characters. */
  id: string;
  /** Display-only label for reviewer context. */
  label?: string;
}

export interface LucToolInvocationDescriptor {
  action: string;
  kind: LucToolInvocationKind;
  /** Stable capability id in the form `<tool-name>.<action>`. */
  capability: string;
  target?: LucToolInvocationTarget;
  sideEffect?: Record<string, unknown>;
}

export interface LucToolSessionPermission<Input = unknown> {
  /**
   * True means the tool only reads already-authorized data and may run in
   * read-only sessions without reviewer escalation.
   */
  readOnly?: boolean;
  /**
   * Host approval classification hint. Unknown or external side-effect kinds
   * remain reviewer-bound in Auto mode.
   */
  kind?: LucToolSessionPermissionKind;
  /**
   * Override Auto-mode handling for a declared non-read tool.
   */
  auto?: 'allow' | 'review';
  description?: string;
  sideEffect?: Record<string, unknown>;
  describeSideEffect?: (input: Input) => Record<string, unknown> | null | undefined;
  /**
   * Synchronously classify one concrete invocation. Return null for an
   * unsupported action or invalid target so the host can fail closed.
   * Promise/thenable results are consumed safely and rejected. The descriptor
   * action is the resolver's stable permission action; the host does not infer
   * it from an optional input.action field or require those strings to match.
   *
   * Actor, server, and session identity are host-owned and must not appear in
   * the returned descriptor or sideEffect metadata.
   */
  resolveInvocation?: (input: Input) => LucToolInvocationDescriptor | null;
}

export interface LucToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters?: JsonSchema;
  promptSnippet?: string;
  promptGuidelines?: string;
  sessionPermission?: LucToolSessionPermission<Input>;
  metadata?: Record<string, unknown>;
  invocationStyle?: 'sdk_tool' | 'pi_tool';
  execute(input: Input, ctx: LucToolContext): MaybePromise<Output>;
}

export type LucSlashPermission = 'anyone' | 'owner' | 'admin';
export type LucSlashScope = 'session' | 'global';

export interface LucCommandContext {
  [key: string]: unknown;
}

export interface LucCommandResult {
  reply?: string;
  silent?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface LucCommandDefinition<Context = LucCommandContext> {
  name: string;
  aliases?: string[];
  description?: string;
  scope?: LucSlashScope;
  permission?: LucSlashPermission;
  usage?: string;
  handler?: (ctx: Context) => MaybePromise<LucCommandResult | void>;
  execute?: (ctx: Context) => MaybePromise<unknown>;
}

export type LucProviderRuntimeKind = 'http' | 'oauth-http' | 'local-cli' | 'browser-cli' | 'plugin';
export type LucMediaCapabilityName = 'imageGeneration' | 'videoGeneration' | 'speechGeneration' | string;
export type LucMediaOutputKind = 'file_glob' | 'json_stdout' | 'url_stdout';
export type LucCliBindingSource = 'prompt' | 'modelId' | 'inputFile' | 'outputDir' | 'size' | 'duration';

export type LucCliArgBinding =
  | { literal: string }
  | { option: string; from: LucCliBindingSource };

export interface LucCliOutputContract {
  kind: LucMediaOutputKind;
  directory?: LucCliBindingSource | string;
  pattern?: string;
  [key: string]: unknown;
}

export interface LucCliCommandSpec {
  executable: string;
  args: LucCliArgBinding[];
  timeoutMs: number;
  output: LucCliOutputContract;
}

export interface LucProviderRuntime {
  kind: LucProviderRuntimeKind;
  protocolId?: string;
  command?: LucCliCommandSpec;
  [key: string]: unknown;
}

export interface LucProviderChatCapability {
  projection?: 'models-json' | 'sdk-auth-alias' | 'none' | string;
  credentialSource?: 'provider-catalog' | 'auth-storage' | 'none';
  runtimeProviderId?: string;
  displayProviderId?: string;
  allowListSource?: string;
  [key: string]: unknown;
}

export interface LucMediaReferenceImageLimits {
  min?: number;
  max?: number;
  [key: string]: unknown;
}

export interface LucMediaInputLimits {
  referenceImages?: LucMediaReferenceImageLimits;
  [key: string]: unknown;
}

export interface LucProviderMediaMode {
  id: string;
  label?: string;
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: LucMediaInputLimits;
  pricing?: Record<string, unknown>;
  agentHints?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LucProviderMediaModel {
  id: string;
  displayName?: string;
  protocolId: string;
  inputs?: string[];
  outputs?: string[];
  supportsEdit?: boolean;
  aliases?: string[];
  credentialLaneId?: string;
  modes?: LucProviderMediaMode[];
  parameterSchema?: JsonSchema;
  defaults?: Record<string, unknown>;
  inputLimits?: LucMediaInputLimits;
  [key: string]: unknown;
}

export interface LucProviderCredentialLane {
  id: string;
  kind?: string;
  label?: string;
  [key: string]: unknown;
}

export interface LucProviderMediaCapability {
  defaultModelId?: string;
  models: LucProviderMediaModel[];
  credentialLanes?: LucProviderCredentialLane[];
  [key: string]: unknown;
}

export interface LucProviderCapabilities {
  chat?: LucProviderChatCapability;
  media?: Partial<Record<LucMediaCapabilityName, LucProviderMediaCapability>>;
  [key: string]: unknown;
}

export interface LucProviderSource {
  kind: 'builtin' | 'plugin' | 'user' | string;
  pluginId?: string;
  [key: string]: unknown;
}

export interface LucProviderDefinition {
  id: string;
  displayName?: string;
  name?: string;
  authType?: 'api-key' | 'oauth' | 'none' | string;
  authJsonKey?: string;
  defaultBaseUrl?: string;
  defaultApi?: string;
  api?: string;
  models?: unknown[];
  runtime?: LucProviderRuntime;
  capabilities?: LucProviderCapabilities;
  source?: LucProviderSource;
  [key: string]: unknown;
}

export type LucExtensionFactory<Pi = unknown> = (pi: Pi) => MaybePromise<void>;

export interface LucPluginConfigStore {
  get<T = unknown>(key: string, options?: LucPluginConfigScopeOptions): MaybePromise<T | undefined>;
  getAll?(options?: LucPluginConfigScopeOptions & { redacted?: boolean }): MaybePromise<Record<string, unknown>>;
  set<T = unknown>(key: string, value: T, options?: LucPluginConfigScopeOptions): MaybePromise<void>;
  setMany?(values: Record<string, unknown>, options?: LucPluginConfigScopeOptions): MaybePromise<Record<string, unknown>>;
  getSchema?(): JsonSchema;
}

export interface LucPluginConfigScopeOptions {
  scope?: 'global' | 'per-agent' | 'per-session';
  agentId?: string;
  sessionId?: string;
  /** @deprecated Use sessionId. Kept for legacy config scopes. */
  sessionPath?: string;
}

export interface LucSessionTurnContext {
  system?: string | Array<string | { text: string; label?: string }>;
  beforeUser?: string | Array<string | { text: string; label?: string }>;
  afterUser?: string | Array<string | { text: string; label?: string }>;
  metadata?: Record<string, unknown>;
}

export interface LucSessionCreateInput {
  agentId?: string | null;
  cwd?: string | null;
  memoryEnabled?: boolean;
  model?: string | { id?: string; modelId?: string; provider?: string; providerId?: string };
  workspaceFolders?: string[];
  authorizedFolders?: string[];
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  sessionKind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface LucSessionSendInput {
  text: string;
  context?: LucSessionTurnContext | null;
  images?: unknown[];
  videos?: unknown[];
  audios?: unknown[];
  imageAttachmentPaths?: string[];
  videoAttachmentPaths?: string[];
  audioAttachmentPaths?: string[];
  [key: string]: unknown;
}

export interface LucSessionListFilter {
  agentId?: string;
  ownerPluginId?: string;
  includePluginPrivate?: boolean;
}

export interface LucSessionUpdateInput {
  title?: string;
  pinned?: boolean;
  projectId?: string | null;
  thinkingLevel?: string;
  permissionMode?: string;
  ownerPluginId?: string | null;
  kind?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
}

export interface LucAgentCreateInput {
  id?: string;
  name: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  initialFiles?: Record<string, string>;
  initialMemory?: Record<string, unknown>;
  memoryPolicy?: { enabled?: boolean };
}

export interface LucAgentUpdateInput {
  name?: string;
  yuan?: string;
  ownerPluginId?: string | null;
  visibility?: 'public' | 'plugin_private' | 'private' | string;
  kind?: string | null;
  memoryPolicy?: { enabled?: boolean };
  toolPolicy?: { disabled?: string[] };
  config?: Record<string, unknown>;
}

export interface LucModelSampleInput {
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown }>;
  sessionId?: string;
  sessionRef?: LucSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  agentId?: string;
  temperature?: number;
  maxTokens?: number;
  operation?: string;
}

export interface LucMediaProviderFilter {
  capability?: string;
}

export interface LucMediaModelRef {
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
  capability?: string;
  credentialLaneId?: string;
}

export type LucSessionFileReference =
  | { kind: 'session_file'; fileId: string }
  | { type: 'session_file'; fileId: string };

export type LucGenerateImageReference = LucSessionFileReference;

export interface LucMediaDelivery {
  mode?: 'session' | 'response' | string;
  ttlMs?: number;
  [key: string]: unknown;
}

export interface LucGenerateImageInput {
  sessionId?: string;
  sessionRef?: LucSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  count?: number;
  image?: LucGenerateImageReference | LucGenerateImageReference[];
  referenceImages?: LucGenerateImageReference[];
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: LucMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface LucGenerateVideoInput {
  sessionId?: string;
  sessionRef?: LucSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  prompt: string;
  image?: LucGenerateImageReference | LucGenerateImageReference[] | string;
  referenceImages?: LucGenerateImageReference[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  delivery?: LucMediaDelivery;
  deliveryMode?: string;
  deliveryTarget?: unknown;
}

export interface LucGenerateMediaInput {
  kind?: 'image' | 'video' | 'audio' | 'image_generation' | 'video_generation' | 'speech_recognition' | 'asr' | 'transcription' | string;
  type?: string;
  mediaKind?: string;
  sessionId?: string;
  sessionRef?: LucSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId?: string;
  prompt?: string;
  image?: LucGenerateImageReference | LucGenerateImageReference[] | string;
  referenceImages?: LucGenerateImageReference[];
  duration?: number;
  ratio?: string;
  resolution?: string;
  quality?: string;
  mode?: string;
  options?: Record<string, unknown>;
  model?: string;
  provider?: string;
  delivery?: LucMediaDelivery;
  deliveryMode?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LucTranscribeAudioInput {
  sessionId?: string;
  sessionRef?: LucSessionRef;
  /** @deprecated Use sessionId/sessionRef. */
  sessionPath?: string;
  fileId: string;
  language?: string;
  providerId?: string;
  provider?: string;
  modelId?: string;
  model?: string;
}

export interface LucTranscribeAudioResult {
  ok: true;
  transcription: unknown;
  taskId?: string;
  stream?: unknown;
}

export interface LucEventBus {
  emit(event: unknown, sessionPath?: string | null): unknown;
  emit(type: string, payload?: unknown): unknown;
  subscribe(callback: (event: unknown, sessionPath?: string | null) => void, filter?: LucBusSubscriptionFilter): () => void;
  subscribe(type: string, handler: (payload: unknown) => void): () => void;
  request<T = unknown>(type: string, payload?: unknown, options?: Record<string, unknown>): Promise<T>;
  hasHandler?(type: string): boolean;
  handle?(type: string, handler: (payload: unknown) => MaybePromise<unknown>): () => void;
  listCapabilities?(): LucEventBusCapability[];
  getCapability?(type: string): LucEventBusCapability | null;
}

export interface LucPluginRouteRequestContext {
  pluginId: string;
  agentId: string | null;
  principal: Record<string, unknown> | null;
  capabilityGrant: {
    accessLevel: string;
    declaredPermissions: readonly string[];
    legacyDeclaration: boolean;
  };
  bus: Pick<LucEventBus, 'request' | 'emit' | 'subscribe' | 'hasHandler' | 'getCapability' | 'listCapabilities'>;
}

export interface LucPluginHonoLikeContext {
  get?(name: string): unknown;
}

export function getPluginRequestContext(c: LucPluginHonoLikeContext): LucPluginRouteRequestContext {
  if (!c || typeof c.get !== 'function') {
    throw new Error('getPluginRequestContext requires a Hono context with c.get(name)');
  }
  const requestContext = c.get('pluginRequestContext');
  if (!requestContext || typeof requestContext !== 'object') {
    throw new Error('getPluginRequestContext must be called inside a Luc plugin route handler');
  }
  const bus = (requestContext as Record<string, unknown>).bus;
  const request = bus && typeof bus === 'object'
    ? (bus as { request?: unknown }).request
    : null;
  if (typeof request !== 'function') {
    throw new Error('getPluginRequestContext found an invalid plugin route request context');
  }
  return requestContext as LucPluginRouteRequestContext;
}

export interface LucBusSubscriptionFilter {
  types?: string[] | Set<string>;
  [key: string]: unknown;
}

export interface LucEventBusCapability {
  type: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: string;
  errors: string[];
  stability: string;
  owner: string;
  since?: string;
  available?: boolean;
}

export interface LucNormalizedUsage {
  input: {
    totalTokens: number | null;
    uncachedTokens: number | null;
  };
  output: {
    totalTokens: number | null;
    reasoningTokens: number | null;
  };
  cache: {
    readTokens: number | null;
    writeTokens: number | null;
    missTokens: number | null;
    hit: boolean | null;
    created: boolean | null;
    hitRatio: number | null;
    support: 'reported' | 'not_reported' | 'not_supported';
  };
  totalTokens: number | null;
  costTotal: number | null;
}

export type LucUsageAttribution =
  | { kind: 'session'; agentId: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'phone_conversation'; agentId: string; conversationId: string; conversationType: 'channel' | 'dm'; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'memory'; agentId: string | null }
  | { kind: 'automation'; jobId?: string | null; runId?: string | null; agentId?: string | null }
  | { kind: 'plugin'; pluginId: string; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'utility'; agentId?: string | null; sessionId?: string | null; sessionPath?: string | null }
  | { kind: 'unknown' };

export interface LucUsageSource {
  subsystem: 'session' | 'phone' | 'memory' | 'automation' | 'subagent' | 'compaction' | 'plugin' | 'utility' | 'vision' | 'unknown' | string;
  operation: string;
  surface: 'desktop' | 'mobile' | 'bridge' | 'channel' | 'dm' | 'cron' | 'heartbeat' | 'system' | 'plugin' | 'unknown' | string;
  trigger: 'user' | 'manual' | 'threshold' | 'overflow' | 'daily' | 'scheduled' | 'startup' | 'tool' | 'unknown' | string;
  actor?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'subagent' | 'unknown' | string;
    agentId?: string | null;
    sessionId?: string | null;
    sessionPath?: string | null;
    taskId?: string | null;
    [key: string]: unknown;
  };
  parent?: {
    kind: 'session' | 'phone_conversation' | 'automation' | 'plugin' | 'unknown' | string;
    sessionId?: string;
    sessionPath?: string;
    conversationId?: string;
    conversationType?: 'channel' | 'dm';
    taskId?: string;
    pluginId?: string;
    [key: string]: unknown;
  };
}

export interface LucUsageLedgerEntry {
  schemaVersion: 1;
  requestId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'aborted' | 'usage_missing';
  source: LucUsageSource;
  attribution: LucUsageAttribution;
  model: {
    provider: string | null;
    modelId: string | null;
    api: string | null;
  };
  usage: LucNormalizedUsage | null;
  rawUsageShape: string | null;
  error: {
    name: string | null;
    message: string | null;
  } | null;
}

export interface LucUsageListFilter {
  since?: string;
  until?: string;
  attributionKind?: string;
  sessionId?: string;
  sessionPath?: string;
  agentId?: string;
  subsystem?: string;
  operation?: string;
  modelId?: string;
  provider?: string;
  status?: 'ok' | 'error' | 'aborted' | 'usage_missing' | string;
  limit?: number;
}

export interface LucUsageListResult {
  entries: LucUsageLedgerEntry[];
  nextCursor: string | null;
}

export interface LucUsageEventMeta {
  sessionId?: string | null;
  sessionPath?: string | null;
  sessionRef?: LucSessionRef | null;
}

export interface LucPluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LucBusHandlerContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: LucExecutionBoundary;
  pluginId: string;
  bus: LucEventBus;
  network?: LucPluginNetwork;
  resources?: LucPluginResources;
  config?: LucPluginConfigStore;
  log?: LucPluginLogger;
  [key: string]: unknown;
}

export interface LucBusHandlerDefinition<
  Payload = unknown,
  Result = unknown,
  Context extends LucBusHandlerContext = LucBusHandlerContext,
> {
  type: string;
  handle(payload: Payload, ctx: Context): MaybePromise<Result>;
}

export interface LucPluginContext {
  serverId: string;
  serverNodeId?: string;
  userId: string;
  studioId: string;
  connectionKind?: 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud' | string;
  credentialKind?: 'none' | 'loopback_token' | 'device_credential' | 'user_session' | string;
  platformAccountId?: string | null;
  officialServiceKind?: 'relay' | 'cloud_studio' | 'inference' | 'billing' | string | null;
  executionBoundary?: LucExecutionBoundary;
  pluginId: string;
  pluginDir: string;
  dataDir: string;
  capabilities?: string[];
  sensitiveCapabilities?: string[];
  sessionId?: string | null;
  sessionRef?: LucSessionRef | null;
  /** @deprecated Use sessionId/sessionRef. Kept for legacy plugins. */
  sessionPath?: string | null;
  bus: LucEventBus;
  network: LucPluginNetwork;
  resources: LucPluginResources;
  config: LucPluginConfigStore;
  log: LucPluginLogger;
  registerTool?: (tool: LucToolDefinition) => () => void;
  registerSessionFile?: (input: Record<string, unknown>) => LucSessionFile;
  stageFile?: (input: Record<string, unknown>) => LucStagedSessionFile;
  [key: string]: unknown;
}

export type LucPluginDisposable = () => void;

export interface LucPluginLifecycleHelpers {
  register(disposable: LucPluginDisposable): void;
}

export interface LucPluginLifecycle {
  onload?(ctx: LucPluginContext, helpers: LucPluginLifecycleHelpers): MaybePromise<void>;
  onunload?(ctx: LucPluginContext): MaybePromise<void>;
}

export interface LucPluginInstance {
  ctx: LucPluginContext;
  register: (disposable: LucPluginDisposable) => void;
  onload?(): MaybePromise<void>;
  onunload?(): MaybePromise<void>;
}

export type LucTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'aborted';

export interface LucTaskProgress {
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface LucTaskRecord {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  progress?: LucTaskProgress | null;
  status: LucTaskStatus;
  aborted?: boolean;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface LucTaskSchedule {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number | null;
  runAt?: number | string | null;
  enabled?: boolean;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastResult?: unknown;
  lastError?: string | null;
  runCount?: number;
}

export interface LucTaskRegisterInput {
  taskId: string;
  type: string;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
  meta?: Record<string, unknown>;
  persist?: boolean;
}

export interface LucTaskUpdateInput {
  taskId: string;
  status?: LucTaskStatus;
  progress?: LucTaskProgress | null;
  meta?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  parentSessionPath?: string | null;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface LucTaskScheduleInput {
  scheduleId: string;
  type: string;
  pluginId?: string | null;
  agentId?: string | null;
  parentSessionPath?: string | null;
  payload?: unknown;
  meta?: Record<string, unknown>;
  intervalMs?: number;
  runAt?: number | string | Date;
  enabled?: boolean;
}

const EMPTY_PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function defineTool<Input = unknown, Output = unknown>(
  definition: LucToolDefinition<Input, Output>,
): LucToolDefinition<Input, Output> & { parameters: JsonSchema } {
  return {
    ...definition,
    parameters: definition.parameters ?? EMPTY_PARAMETERS,
  };
}

export function defineCommand<Context = LucCommandContext>(
  definition: LucCommandDefinition<Context>,
): LucCommandDefinition<Context> {
  return { ...definition };
}

export function defineProvider<T extends LucProviderDefinition>(definition: T): T {
  return definition;
}

export function defineBusHandler<
  Payload = unknown,
  Result = unknown,
  Context extends LucBusHandlerContext = LucBusHandlerContext,
>(
  definition: LucBusHandlerDefinition<Payload, Result, Context>,
): LucBusHandlerDefinition<Payload, Result, Context> {
  return { ...definition };
}

export function requestBus<Result = unknown, Payload = unknown>(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  type: string,
  payload?: Payload,
  options?: Record<string, unknown>,
): Promise<Result> {
  if (!ctx.bus || typeof ctx.bus.request !== 'function') {
    throw new Error('plugin bus request unavailable');
  }
  return ctx.bus.request<Result>(type, payload, options);
}

function pluginIdFromContext(ctx: { pluginId?: string | null }): string | null {
  return typeof ctx.pluginId === 'string' && ctx.pluginId.length > 0 ? ctx.pluginId : null;
}

function withOwnerPlugin<T extends Record<string, unknown>>(
  ctx: { pluginId?: string | null },
  input: T,
): T {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId || input.ownerPluginId) return input;
  return { ...input, ownerPluginId: pluginId };
}

function withContextMetadata(
  ctx: { pluginId?: string | null },
  context: LucSessionTurnContext | null | undefined,
): LucSessionTurnContext | null | undefined {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId) return context;
  if (!context) {
    return { metadata: { pluginId } };
  }
  return {
    ...context,
    metadata: {
      pluginId,
      ...(context.metadata || {}),
    },
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSessionTarget(target: LucSessionTarget): Record<string, unknown> {
  if (typeof target === 'string') return { sessionPath: target };
  if (!target || typeof target !== 'object') return { sessionPath: target as unknown };

  const sessionId = textOrNull((target as any).sessionId);
  const sessionPath = textOrNull((target as any).sessionPath) || textOrNull((target as any).path);
  const legacySessionPath = textOrNull((target as any).legacySessionPath);
  if (!sessionId) {
    return sessionPath ? { sessionPath } : {};
  }

  const sessionRef: LucSessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
  };
  return {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
    ...(legacySessionPath ? { legacySessionPath } : {}),
    sessionRef,
  };
}

function sessionRefFromTarget(target: LucSessionTarget): LucSessionRef | null {
  const payload = normalizeSessionTarget(target);
  return (payload.sessionRef as LucSessionRef | undefined) || null;
}

export function createChatSurfaceCard(
  ctx: { pluginId?: string | null },
  target: LucSessionTarget,
  options: LucChatSurfaceCardOptions = {},
): LucChatSurfaceCardDetails {
  const pluginId = pluginIdFromContext(ctx);
  if (!pluginId) {
    throw new Error('createChatSurfaceCard requires ctx.pluginId');
  }
  const payload = normalizeSessionTarget(target);
  const sessionId = textOrNull(payload.sessionId);
  const sessionPath = textOrNull(payload.sessionPath);
  if (!sessionId) {
    throw new Error('createChatSurfaceCard requires sessionId or sessionRef; sessionPath alone is legacy locator metadata');
  }
  const sessionRef: LucSessionRef = {
    sessionId,
    ...(sessionPath ? { sessionPath } : {}),
  };
  return {
    type: 'chat.surface',
    pluginId,
    sessionId,
    sessionRef,
    ...(sessionPath ? { sessionPath } : {}),
    ...(options.title ? { title: options.title } : {}),
    description: options.description || 'Plugin private chat session.',
    mode: options.mode || 'transcript',
    ...(options.composer !== undefined ? { composer: options.composer } : {}),
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
  };
}

export function createSession(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucSessionCreateInput = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function getSession(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  target: LucSessionTarget,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:get', normalizeSessionTarget(target), options);
}

export function listSessions(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  filter: LucSessionListFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:list', filter, options);
}

export function updateSession(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  target: LucSessionTarget,
  patch: LucSessionUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:update', {
    ...normalizeSessionTarget(target),
    ...withOwnerPlugin(ctx, { ...patch }),
  }, options);
}

export function sendSessionMessage(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  target: LucSessionTarget,
  input: LucSessionSendInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'session:send', {
    ...normalizeSessionTarget(target),
    ...input,
    context: withContextMetadata(ctx, input.context),
  }, options);
}

export function subscribeSessionEvents(
  ctx: { bus?: Pick<LucEventBus, 'subscribe'> | null },
  target: LucSessionTarget,
  handler: (event: unknown, meta: { sessionId: string | null; sessionPath: string | null; sessionRef: LucSessionRef | null }) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  const filter = normalizeSessionTarget(target);
  const targetRef = sessionRefFromTarget(target);
  return ctx.bus.subscribe((event, scopedSessionPath) => {
    const eventSessionId = event && typeof event === 'object' ? textOrNull((event as any).sessionId) : null;
    const sessionId = eventSessionId || targetRef?.sessionId || null;
    const sessionPath = scopedSessionPath || targetRef?.sessionPath || null;
    const sessionRef = sessionId ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(targetRef?.legacySessionPath ? { legacySessionPath: targetRef.legacySessionPath } : {}),
    } : null;
    handler(event, { sessionId, sessionPath, sessionRef });
  }, filter);
}

export function listAgents(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  filter: { ownerPluginId?: string; includePluginPrivate?: boolean } = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:list', filter, options);
}

export function getAgentProfile(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  agentId: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:profile', { agentId }, options);
}

export function createAgent(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucAgentCreateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:create', withOwnerPlugin(ctx, { ...input }), options);
}

export function updateAgent(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  agentId: string,
  patch: LucAgentUpdateInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'agent:update', { agentId, ...withOwnerPlugin(ctx, { ...patch }) }, options);
}

export function sampleText(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucModelSampleInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'model:sample-text', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function listMediaProviders(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  filter: LucMediaProviderFilter = {},
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:media-providers', filter, options);
}

export function resolveMediaModel(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  ref: LucMediaModelRef,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'provider:resolve-media-model', ref, options);
}

export function generateImage(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucGenerateImageInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-image', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateVideo(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucGenerateVideoInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate-video', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function generateMedia(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucGenerateMediaInput,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return requestBus(ctx, 'media:generate', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options);
}

export function transcribeAudio(
  ctx: { pluginId?: string | null; bus?: Pick<LucEventBus, 'request'> | null },
  input: LucTranscribeAudioInput,
  options?: Record<string, unknown>,
): Promise<LucTranscribeAudioResult> {
  return requestBus(ctx, 'media:transcribe-audio', {
    ...input,
    ...(pluginIdFromContext(ctx) ? { pluginId: pluginIdFromContext(ctx) } : {}),
  }, options).then(normalizeTranscribeAudioResult);
}

function normalizeTranscribeAudioResult(result: unknown): LucTranscribeAudioResult {
  if (result && typeof result === 'object' && (result as any).ok === true
    && Object.prototype.hasOwnProperty.call(result, 'transcription')) {
    return result as LucTranscribeAudioResult;
  }
  return { ok: true, transcription: result };
}

export function listUsageEntries(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  filter: LucUsageListFilter = {},
  options?: Record<string, unknown>,
): Promise<LucUsageListResult> {
  return requestBus<LucUsageListResult, LucUsageListFilter>(ctx, 'usage:list', filter, options);
}

export function subscribeUsageEvents(
  ctx: { bus?: Pick<LucEventBus, 'subscribe'> | null },
  handler: (entry: LucUsageLedgerEntry, meta: LucUsageEventMeta) => void,
): () => void {
  if (!ctx.bus || typeof ctx.bus.subscribe !== 'function') {
    throw new Error('plugin bus subscribe unavailable');
  }
  return ctx.bus.subscribe((event, sessionPath) => {
    if (!event || typeof event !== 'object') return;
    const typed = event as { type?: unknown; entry?: unknown };
    if (typed.type !== 'llm_usage') return;
    const entry = typed.entry as LucUsageLedgerEntry;
    const entrySessionId =
      textOrNull((entry as any)?.attribution?.sessionId)
      || textOrNull((entry as any)?.source?.actor?.sessionId)
      || textOrNull((entry as any)?.source?.parent?.sessionId);
    const entrySessionPath =
      textOrNull((entry as any)?.attribution?.sessionPath)
      || textOrNull((entry as any)?.source?.actor?.sessionPath)
      || textOrNull((entry as any)?.source?.parent?.sessionPath)
      || textOrNull(sessionPath);
    handler(entry, {
      ...(entrySessionId ? { sessionId: entrySessionId } : {}),
      sessionPath: entrySessionPath,
      ...(entrySessionId ? {
        sessionRef: {
          sessionId: entrySessionId,
          ...(entrySessionPath ? { sessionPath: entrySessionPath } : {}),
        },
      } : {}),
    });
  }, { types: ['llm_usage'] });
}

export function registerTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  input: LucTaskRegisterInput,
): Promise<{ ok: true }> {
  return requestBus(ctx, 'task:register', input);
}

export function updateTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  input: LucTaskUpdateInput,
): Promise<{ ok: true; task: LucTaskRecord }> {
  return requestBus(ctx, 'task:update', input);
}

export function completeTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  taskId: string,
  result?: unknown,
): Promise<{ ok: true; task: LucTaskRecord }> {
  return requestBus(ctx, 'task:complete', { taskId, result });
}

export function failTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  taskId: string,
  error: unknown,
): Promise<{ ok: true; task: LucTaskRecord }> {
  return requestBus(ctx, 'task:fail', { taskId, error });
}

export function cancelTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  taskId: string,
  reason?: string,
): Promise<{ result: string; canceled: boolean }> {
  return requestBus(ctx, 'task:cancel', { taskId, reason });
}

export function scheduleTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  input: LucTaskScheduleInput,
): Promise<{ ok: true; schedule: LucTaskSchedule }> {
  return requestBus(ctx, 'task:schedule', input);
}

export function unscheduleTask(
  ctx: { bus?: Pick<LucEventBus, 'request'> | null },
  scheduleId: string,
): Promise<{ ok: true; removed: boolean }> {
  return requestBus(ctx, 'task:unschedule', { scheduleId });
}

export function sessionFileToMediaItem(file: LucSessionFile): LucSessionFileMediaItem {
  const fileId = firstText(file.fileId, file.id);
  if (!fileId) {
    throw new Error('SessionFile media item requires id or fileId');
  }

  const item: LucSessionFileMediaItem = {
    type: 'session_file',
    fileId,
  };
  assignDefined(item, 'sessionId', file.sessionId);
  assignDefined(item, 'sessionPath', file.sessionPath);
  assignDefined(item, 'filePath', file.filePath);
  assignDefined(item, 'label', firstText(file.label, file.displayName, file.filename));
  assignDefined(item, 'mime', file.mime);
  assignDefined(item, 'size', file.size);
  assignDefined(item, 'kind', file.kind);
  return item;
}

type LucMediaInput = LucSessionFile | LucSessionFileMediaItem | LucStagedSessionFile;

export function createMediaDetails(items: LucMediaInput[]): LucMediaDetails {
  return {
    media: {
      items: items.map(normalizeMediaItem),
    },
  };
}

export function defineExtension<Pi = unknown>(factory: LucExtensionFactory<Pi>): LucExtensionFactory<Pi> {
  return factory;
}

export function definePlugin(lifecycle: LucPluginLifecycle): new () => LucPluginInstance {
  return class DefinedLucPlugin implements LucPluginInstance {
    ctx!: LucPluginContext;
    register!: (disposable: LucPluginDisposable) => void;

    async onload(): Promise<void> {
      await lifecycle.onload?.(this.ctx, { register: this.register });
    }

    async onunload(): Promise<void> {
      await lifecycle.onunload?.(this.ctx);
    }
  };
}

function normalizeMediaItem(input: LucMediaInput): LucSessionFileMediaItem {
  if (isRecord(input) && isRecord(input.mediaItem)) {
    return normalizeSessionFileMediaItem(input.mediaItem);
  }
  if (isRecord(input) && input.type === 'session_file') {
    return normalizeSessionFileMediaItem(input);
  }
  if (isRecord(input)) {
    return sessionFileToMediaItem(input);
  }
  throw new Error('media details item must be a SessionFile, staged file, or session_file media item');
}

function normalizeSessionFileMediaItem(input: Record<string, unknown>): LucSessionFileMediaItem {
  if (input.type !== 'session_file') {
    throw new Error('media details item must be a session_file media item');
  }
  const fileId = firstText(input.fileId);
  if (!fileId) {
    throw new Error('SessionFile media item requires fileId');
  }
  return {
    ...input,
    type: 'session_file',
    fileId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}
