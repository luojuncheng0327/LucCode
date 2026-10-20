export type McpTransport = 'stdio' | 'remote' | 'streamable-http' | 'sse';
export type McpAuthType = 'none' | 'bearer' | 'oauth';
export type McpConnectorStatus =
  | 'running'
  | 'stopped'
  | 'connecting'
  | 'reconnecting'
  | 'failed'
  | 'needs-auth';

/** Per-connector policy. `review-all` reviews every invocation; `allowlist` honours per-tool grants. */
export type McpPermissionMode = 'review-all' | 'allowlist';
/** Per-tool override inside an allowlist connector. */
export type McpToolPermission = 'allow' | 'review';

/**
 * What the running server says about a tool. These are the server's own claims,
 * not verified facts, which is why the UI labels them as declarations.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  /** Agent-facing tool id, `${connectorId}_${toolName}` sanitized. Assigned by the server. */
  qualifiedName?: string;
  /** Permission capability string for this tool, `${qualifiedName}.invoke`. */
  capability?: string;
  annotations?: McpToolAnnotations;
}

/**
 * One tool the runtime refused to publish because another raw identity
 * normalizes onto the same model-facing id. Both sides of a clash get their own
 * entry, since renaming either one resolves it.
 */
export interface McpToolCollision {
  /** The model-facing id both identities claim. */
  canonical: string;
  /** The tool of this connector that was dropped. */
  toolName: string;
  /** The other claimant's connector id; equal to this connector's own id when a connector clashes with itself. */
  otherConnectorId: string;
  /** The other claimant's tool name. */
  otherToolName: string;
  /**
   * Set when the counterpart is the built-in connectors_status tool. That one
   * is published before connector tools are considered and survives the clash,
   * so only this connector's tool was dropped.
   */
  host?: boolean;
}

export interface McpOAuthState {
  connected?: boolean;
  scope?: string;
  expiresAt?: number;
}

export interface McpConnector {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  registryUrl?: string;
  timeout?: number;
  /** The single persisted switch. Absent means enabled; only false switches it off. */
  enabled?: boolean;
  status: McpConnectorStatus;
  /** Last failure reported by the runtime. Empty when the connector is healthy. */
  error?: string;
  /** Tools dropped for an ambiguous model-facing id. Empty when nothing clashes. */
  collisions?: McpToolCollision[];
  tools: McpTool[];
  authType?: McpAuthType;
  authStatus?: string;
  authorizationToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauth?: McpOAuthState;
  permissionMode?: McpPermissionMode;
  toolPermissions?: Record<string, McpToolPermission>;
  trustReadOnlyHint?: boolean;
  pinnedTools?: Record<string, boolean>;
}

export interface McpAgentConnectorConfig {
  enabled?: boolean;
  tools?: Record<string, boolean>;
}

export interface McpState {
  enabled: boolean;
  /** Global deferred-loading switch. */
  deferEnabled: boolean;
  /** Tool count above which deferred loading engages. */
  deferThreshold: number;
  /** Whether built-in tools join the deferred catalog too (only meaningful while deferEnabled). */
  builtinDeferEnabled: boolean;
  connectors: McpConnector[];
  servers?: McpConnector[];
  agentConfig: {
    connectors?: Record<string, McpAgentConnectorConfig>;
    servers?: Record<string, McpAgentConnectorConfig>;
  };
}

export interface McpConnectorInput {
  name?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  registryUrl?: string;
  timeout?: number;
  enabled?: boolean;
  authType?: McpAuthType;
  authorizationToken?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  permissionMode?: McpPermissionMode;
  toolPermissions?: Record<string, McpToolPermission>;
  trustReadOnlyHint?: boolean;
  pinnedTools?: Record<string, boolean>;
}

/** One row of a bulk import result, positionally matched to the submitted list. */
export interface McpBulkResult {
  ok: boolean;
  id?: string;
  error?: string;
}
