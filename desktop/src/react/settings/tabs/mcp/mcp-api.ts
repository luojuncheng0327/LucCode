import { lucFetch } from '../../api';
import type { McpBulkResult, McpConnectorInput, McpState, McpToolPermission } from './types';

/** Mirrors the manager's own default, used only until the first state load lands. */
const DEFAULT_DEFER_THRESHOLD = 10;

export const EMPTY_MCP_STATE: McpState = {
  enabled: false,
  deferEnabled: true,
  deferThreshold: DEFAULT_DEFER_THRESHOLD,
  builtinDeferEnabled: false,
  connectors: [],
  agentConfig: { connectors: {} },
};

async function jsonOrError<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function loadMcpState(agentId: string): Promise<McpState> {
  const res = await lucFetch(`/api/mcp/state?agentId=${encodeURIComponent(agentId)}`);
  const data = await jsonOrError<McpState>(res);
  return {
    enabled: data.enabled === true,
    // Only an explicit false turns defer off, matching the server's own
    // read-time default for configs written before defer existed.
    deferEnabled: data.deferEnabled !== false,
    deferThreshold: Number.isSafeInteger(data.deferThreshold) && data.deferThreshold > 0
      ? data.deferThreshold
      : DEFAULT_DEFER_THRESHOLD,
    builtinDeferEnabled: data.builtinDeferEnabled === true,
    connectors: Array.isArray(data.connectors) ? data.connectors : (Array.isArray(data.servers) ? data.servers : []),
    servers: Array.isArray(data.servers) ? data.servers : undefined,
    agentConfig: data.agentConfig || { connectors: {} },
  };
}

export async function setMcpEnabled(enabled: boolean): Promise<void> {
  const res = await lucFetch('/api/mcp/settings/enabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const data = await jsonOrError<McpState>(res);
  if (typeof data?.enabled !== 'boolean') {
    throw new Error('MCP enabled endpoint returned an invalid state');
  }
  if (data.enabled !== enabled) {
    throw new Error(`MCP enabled state did not persist: expected ${enabled}, got ${data.enabled}`);
  }
}

export async function addMcpConnector(input: McpConnectorInput): Promise<void> {
  const res = await lucFetch('/api/mcp/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await jsonOrError(res);
}

/**
 * Import several connectors in one request.
 *
 * The server validates the whole batch before writing any of it. On rejection
 * it still answers with one result per submitted row, so the preview list can
 * mark exactly which entry was refused; that array is returned rather than
 * thrown away with the error.
 */
export async function addMcpConnectorsBulk(inputs: McpConnectorInput[]): Promise<McpBulkResult[]> {
  const res = await lucFetch('/api/mcp/connectors/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectors: inputs }),
  });
  const data = await res.json();
  if (data?.error) {
    const error = new Error(data.error) as Error & { results?: McpBulkResult[] };
    if (Array.isArray(data.results)) error.results = data.results;
    throw error;
  }
  return Array.isArray(data?.results) ? data.results : [];
}

export async function setMcpDeferSettings(
  patch: { deferEnabled?: boolean; deferThreshold?: number; builtinDeferEnabled?: boolean },
): Promise<void> {
  const res = await lucFetch('/api/mcp/settings/defer', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await jsonOrError(res);
}

export async function updateMcpConnector(connectorId: string, input: McpConnectorInput): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await jsonOrError(res);
}

export async function removeMcpConnector(connectorId: string): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'DELETE',
  });
  await jsonOrError(res);
}

export async function runMcpConnectorAction(
  connectorId: string,
  action: 'start' | 'stop' | 'refresh-tools',
): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}/${action}`, {
    method: 'POST',
  });
  await jsonOrError(res);
}

export async function setAgentMcpConnector(
  agentId: string,
  connectorId: string,
  enabled: boolean,
): Promise<void> {
  const res = await lucFetch(`/api/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  await jsonOrError(res);
}

export async function setAgentMcpTool(
  agentId: string,
  connectorId: string,
  toolName: string,
  enabled: boolean,
): Promise<void> {
  await setAgentMcpTools(agentId, connectorId, { [toolName]: enabled });
}

/**
 * Flip several tools for one agent in a single request.
 *
 * The batch selection controls route through here: forty tools used to mean
 * forty round trips, each racing the others' state reload.
 */
export async function setAgentMcpTools(
  agentId: string,
  connectorId: string,
  tools: Record<string, boolean>,
): Promise<void> {
  const res = await lucFetch(`/api/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools }),
  });
  await jsonOrError(res);
}

/**
 * Write connector-level policy fields.
 *
 * These ride the ordinary connector update endpoint. They are deliberately sent
 * on their own: an update carrying only policy leaves the connection fingerprint
 * untouched, so changing a permission never restarts a live connector.
 */
export async function updateMcpConnectorPolicy(
  connectorId: string,
  patch: {
    permissionMode?: 'review-all' | 'allowlist';
    toolPermissions?: Record<string, McpToolPermission>;
    trustReadOnlyHint?: boolean;
    pinnedTools?: Record<string, boolean>;
  },
): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await jsonOrError(res);
}

export async function startMcpOAuth(connectorId: string): Promise<{ sessionId: string; url: string }> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/start`, {
    method: 'POST',
  });
  return jsonOrError<{ sessionId: string; url: string }>(res);
}

export async function pollMcpOAuth(sessionId: string): Promise<{ status: string; error?: string }> {
  const res = await lucFetch(`/api/mcp/oauth/poll/${encodeURIComponent(sessionId)}`);
  return jsonOrError<{ status: string; error?: string }>(res);
}

/** Abandon a browser round trip the user gave up on. Saved credentials are untouched. */
export async function cancelMcpOAuth(connectorId: string): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/cancel`, {
    method: 'POST',
  });
  await jsonOrError(res);
}

export async function logoutMcpOAuth(connectorId: string): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/logout`, {
    method: 'POST',
  });
  await jsonOrError(res);
}
