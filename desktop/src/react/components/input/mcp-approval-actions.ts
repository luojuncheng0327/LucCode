import { lucFetch } from '../../hooks/use-luc-fetch';
import type { SessionConfirmationBlock } from '../../stores/chat-types';

/** The bridge tool that fronts every deferred MCP tool. */
const BRIDGE_CALL_TOOL = 'mcp_call';
/** Namespace the manager puts in front of every directly loaded MCP tool. */
const MCP_TOOL_PREFIX = 'mcp_';

export interface McpApprovalTarget {
  connectorId: string;
  connectorName: string;
  toolName: string;
  /** Agent-facing id, e.g. `github_search_repositories`. */
  qualifiedName: string;
  /** Permission capability string, `${qualifiedName}.invoke`. */
  capability: string;
  /** The running server declares this tool destructive. */
  destructive: boolean;
  /** Connector-level policy as it stands, needed to write a permanent grant without clobbering peers. */
  permissionMode: 'review-all' | 'allowlist';
  toolPermissions: Record<string, 'allow' | 'review'>;
}

interface StateTool {
  name: string;
  qualifiedName?: string;
  capability?: string;
  annotations?: { destructiveHint?: boolean };
}

interface StateConnector {
  id: string;
  name?: string;
  tools?: StateTool[];
  permissionMode?: 'review-all' | 'allowlist';
  toolPermissions?: Record<string, 'allow' | 'review'>;
}

/**
 * Read the connector registry so an approval can be traced back to the tool it
 * is really about.
 *
 * The qualified name is taken from the server rather than rebuilt here: the
 * id-sanitizing rule has exactly one implementation, and a second one in the
 * renderer would drift from it silently.
 */
export async function loadMcpApprovalIndex(): Promise<StateConnector[]> {
  const res = await lucFetch('/api/mcp/state');
  const data = await res.json();
  if (data?.error) throw new Error(data.error);
  const connectors = Array.isArray(data?.connectors)
    ? data.connectors
    : (Array.isArray(data?.servers) ? data.servers : []);
  return connectors as StateConnector[];
}

/**
 * Work out which MCP tool a pending approval is about, or null when it is not
 * an MCP tool at all.
 *
 * Two shapes reach here. A directly loaded tool arrives under its own namespaced
 * name. A deferred one arrives as the bridge, whose parameters name the server
 * and tool — which is how the prompt can speak the real tool's name rather than
 * "mcp_call".
 */
export function resolveMcpApprovalTarget(
  block: SessionConfirmationBlock,
  connectors: StateConnector[],
): McpApprovalTarget | null {
  if (block.kind !== 'tool_action_approval') return null;
  const toolName = typeof block.payload?.toolName === 'string' ? block.payload.toolName : '';
  if (!toolName) return null;

  const params = (block.payload?.params || {}) as Record<string, unknown>;
  const viaBridge = toolName === BRIDGE_CALL_TOOL;
  if (!viaBridge && !toolName.startsWith(MCP_TOOL_PREFIX)) return null;

  for (const connector of connectors) {
    for (const tool of connector.tools || []) {
      const qualifiedName = tool.qualifiedName || '';
      if (!qualifiedName) continue;
      const matches = viaBridge
        ? params.server === connector.id && params.tool === tool.name
        : toolName === `${MCP_TOOL_PREFIX}${qualifiedName}`;
      if (!matches) continue;
      return {
        connectorId: connector.id,
        connectorName: connector.name || connector.id,
        toolName: tool.name,
        qualifiedName,
        capability: tool.capability || `${qualifiedName}.invoke`,
        destructive: tool.annotations?.destructiveHint === true,
        permissionMode: connector.permissionMode === 'allowlist' ? 'allowlist' : 'review-all',
        toolPermissions: connector.toolPermissions || {},
      };
    }
  }
  return null;
}

/**
 * Stop asking about this one tool for the rest of this session.
 *
 * The grant is held by the session runtime and dies with it; nothing is written
 * to the connector.
 */
export async function grantForSession(sessionId: string, capability: string): Promise<void> {
  const res = await lucFetch('/api/mcp/session-permissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, capability }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error || 'failed to grant session permission');
}

/**
 * Allow this tool from now on, recorded against the connector.
 *
 * The write carries the connector's existing per-tool grants so one decision
 * cannot erase another, and turns on allowlist mode, since a grant means nothing
 * while the connector reviews everything.
 */
export async function grantPermanently(target: McpApprovalTarget): Promise<void> {
  const res = await lucFetch(`/api/mcp/connectors/${encodeURIComponent(target.connectorId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      permissionMode: 'allowlist',
      toolPermissions: { ...target.toolPermissions, [target.toolName]: 'allow' },
    }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error || 'failed to save tool permission');
}
