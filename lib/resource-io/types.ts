export type ResourceRef =
  | { kind: "local-file"; path: string }
  | { kind: "mount"; mountId: string; path: string }
  | { kind: "session-file"; fileId: string; sessionId?: string; sessionPath?: string }
  | { kind: "resource"; resourceId: string }
  | { kind: "url"; url: string };

export type ResourceVersion = {
  mtimeMs?: number;
  size?: number | null;
  sha256?: string;
  etag?: string;
  sequence?: number;
};

export type ResourceDescriptor = ResourceRef & {
  provider?: string;
  filePath?: string;
  displayName?: string;
  isDirectory?: boolean;
};

export type ResourceEventSource =
  | "agent_tool"
  | "provider_watch"
  | "api"
  | "plugin"
  | "bash_reconcile"
  | "mount"
  | "session_file"
  | "unknown";

export type ResourceChangedEvent = {
  type: "resource.changed";
  changeType: "created" | "modified";
  resourceKey: string;
  resource: ResourceDescriptor;
  version?: ResourceVersion;
  source: ResourceEventSource;
  reason?: string;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceDeletedEvent = {
  type: "resource.deleted";
  resourceKey: string;
  resource: ResourceDescriptor;
  source: ResourceEventSource;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceRenamedEvent = {
  type: "resource.renamed";
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: ResourceDescriptor;
  newResource: ResourceDescriptor;
  source: ResourceEventSource;
  sessionPath?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceEvent =
  | ResourceChangedEvent
  | ResourceDeletedEvent
  | ResourceRenamedEvent;

export type ResourceEventCatchUpResult =
  | {
    stale: false;
    latestSequence: number;
    events: ResourceEvent[];
  }
  | {
    stale: true;
    latestSequence: number;
    events: [];
  };

export type ResourceProviderCapabilities = {
  stat?: boolean;
  read?: boolean;
  write?: boolean;
  writeExpectedVersion?: boolean;
  edit?: boolean;
  list?: boolean;
  search?: boolean;
  watch?: boolean;
  materialize?: boolean;
  copy?: boolean;
  rename?: boolean;
  move?: boolean;
  trash?: boolean;
  delete?: boolean;
  mkdir?: boolean;
};

export type ResourceProviderCapability = keyof ResourceProviderCapabilities;

export type ResourceProviderId =
  | "local_fs"
  | "mount"
  | "session_file"
  | "resource"
  | "url";

export type ResourceStat = {
  resourceKey: string;
  resource: ResourceDescriptor;
  exists: boolean;
  isDirectory: boolean;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceReadResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  content: Buffer;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceMutationResult = {
  changeType: "created" | "modified";
  resourceKey: string;
  resource: ResourceDescriptor;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceWriteConflictResult = {
  ok: false;
  conflict: true;
  resourceKey: string;
  resource: ResourceDescriptor;
  version?: ResourceVersion;
  filePath?: string;
};

export type ResourceWriteExpectedVersionResult =
  | ResourceMutationResult
  | ResourceWriteConflictResult;

export type ResourceMoveResult = {
  oldResourceKey: string;
  newResourceKey: string;
  oldResource: ResourceDescriptor;
  newResource: ResourceDescriptor;
  oldFilePath?: string;
  newFilePath?: string;
};

export type ResourceTrashOptions = {
  namespace?: string;
  metadata?: Record<string, unknown>;
};

export type ResourceTrashResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  trashId: string;
  trashPath?: string;
  payloadPath?: string;
  filePath?: string;
};

export type ResourceEdit = {
  oldText: string;
  newText: string;
};

export type ResourceListItem = {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mtimeMs: number;
};

export type ResourceListResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  items: ResourceListItem[];
};

export type ResourceSearchMatch = {
  filePath: string;
  line: number;
  text: string;
  name?: string;
  relativePath?: string;
  parentSubdir?: string;
  isDirectory?: boolean;
  size?: number | null;
  mtimeMs?: number;
};

export type ResourceSearchResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  matches: ResourceSearchMatch[];
};

export type MaterializeResult = {
  resourceKey: string;
  resource: ResourceDescriptor;
  filePath: string;
  version?: ResourceVersion;
  isDirectory?: boolean;
};

export type SessionFileResolution = {
  ref: Extract<ResourceRef, { kind: "session-file" }>;
  entry: Record<string, any>;
  filePath: string;
  sourceRef?: ResourceRef;
  displayName?: string;
  storageKind?: string;
};

export type ResourceWatchTarget = {
  ref?: ResourceRef;
  filePath: string;
  isDirectory?: boolean;
  resourceKey: string;
  resource: ResourceDescriptor;
  toResource?: (changedPath: string) => {
    resourceKey: string;
    resource: ResourceDescriptor;
    filePath?: string;
  };
};

export type ResourceProvider = {
  id: ResourceProviderId;
  capabilities?: (ref: ResourceRef) => ResourceProviderCapabilities;
  watchTarget?: (ref: ResourceRef) => ResourceWatchTarget;
  stat?: (ref: ResourceRef) => Promise<ResourceStat>;
  read?: (ref: ResourceRef) => Promise<ResourceReadResult>;
  write?: (ref: ResourceRef, content: string | Buffer) => Promise<ResourceMutationResult>;
  writeExpectedVersion?: (ref: ResourceRef, content: string | Buffer, expectedVersion: ResourceVersion) => Promise<ResourceWriteExpectedVersionResult>;
  edit?: (ref: ResourceRef, edits: ResourceEdit[]) => Promise<ResourceMutationResult>;
  mkdir?: (ref: ResourceRef) => Promise<ResourceMutationResult>;
  delete?: (ref: ResourceRef) => Promise<ResourceMutationResult>;
  list?: (ref: ResourceRef) => Promise<ResourceListResult>;
  search?: (ref: ResourceRef, options?: Record<string, unknown>) => Promise<ResourceSearchResult>;
  materialize?: (ref: ResourceRef) => Promise<MaterializeResult>;
  copy?: (from: ResourceRef, to: ResourceRef) => Promise<ResourceMutationResult>;
  rename?: (from: ResourceRef, to: ResourceRef) => Promise<ResourceMoveResult>;
  move?: (from: ResourceRef, to: ResourceRef) => Promise<ResourceMoveResult>;
  trash?: (ref: ResourceRef, options?: ResourceTrashOptions) => Promise<ResourceTrashResult>;
};

export type ResourcePrincipal = {
  kind: "agent" | "plugin" | "api" | "watch" | "system";
  userId?: string | null;
  studioId?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  pluginId?: string | null;
  connectionKind?: string | null;
  credentialKind?: string | null;
  requestId?: string | null;
};

export type ResourceOperationContext = {
  source?: ResourceEventSource;
  reason?: string;
  principal?: ResourcePrincipal;
  sessionId?: string | null;
  sessionPath?: string | null;
  requestId?: string | null;
  emit?: boolean;
  auditRead?: boolean;
};

export type ResourceAuditOutcome = "allowed" | "denied" | "conflict";

export type ResourceAuditEvent = {
  type: "resource.audit";
  outcome: ResourceAuditOutcome;
  operation: ResourceProviderCapability;
  providerId?: ResourceProviderId;
  resourceKey?: string;
  resource?: ResourceDescriptor;
  principal?: ResourcePrincipal;
  reason?: string;
  code?: string;
  safeMessage?: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  requestId?: string | null;
  sequence: number;
  occurredAt: string;
};

export type ResourceAuditSink = {
  record(event: Omit<ResourceAuditEvent, "type" | "sequence" | "occurredAt">): ResourceAuditEvent | void;
};
