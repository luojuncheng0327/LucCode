import React from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import type { McpAgentConnectorConfig, McpConnector } from './types';

interface ConnectorListProps {
  connectors: McpConnector[];
  globalEnabled: boolean;
  loading?: boolean;
  /**
   * Every in-flight mutation key. A set rather than a single value, so two
   * connectors can be busy at once without one disabling the other's controls.
   */
  busyKeys: ReadonlySet<string>;
  agentConfig: {
    connectors?: Record<string, McpAgentConnectorConfig>;
    servers?: Record<string, McpAgentConnectorConfig>;
  };
  onOpen: (connectorId: string) => void;
  onAction: (connectorId: string, action: 'start' | 'stop') => void;
  onRemove: (connectorId: string) => void;
}

export function ConnectorList({
  connectors,
  globalEnabled,
  loading = false,
  busyKeys,
  agentConfig,
  onOpen,
  onAction,
  onRemove,
}: ConnectorListProps) {
  if (loading) {
    return <p className={styles['settings-muted-note']}>{t('status.loading')}</p>;
  }

  if (connectors.length === 0) {
    return <p className={styles['settings-muted-note']}>{t('settings.mcp.noConnectors')}</p>;
  }

  return (
    <div className={styles['skills-list-block']}>
      {connectors.map(connector => {
        const busy = (key: string) => busyKeys.has(`${key}-${connector.id}`);
        const enabledAgents = countEnabledAgents(agentConfig, connector.id);
        const collisionRows = buildCollisionRows(connector);
        return (
          <div key={connector.id} className={`${styles['skills-list-item']} ${styles['mcp-list-item']}`}>
            {/* The whole summary is the way into the detail view; the action
                buttons beside it stop the click from bubbling here. */}
            <div
              className={styles['skills-list-info']}
              role="button"
              tabIndex={0}
              data-testid={`mcp-connector-row-${connector.id}`}
              onClick={() => onOpen(connector.id)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onOpen(connector.id);
              }}
            >
              <div className={styles['skills-list-name']}>
                <span
                  className={`${styles['pv-status-dot']}${connector.status === 'running' ? ' ' + styles['on'] : ''}`}
                  aria-hidden="true"
                />
                {connector.name}
                <span className={styles['skills-list-name-hint']}>{statusLabel(connector)}</span>
              </div>
              <div className={styles['skills-list-desc']}>{connectorTarget(connector)}</div>
              <div className={styles['settings-muted-note']}>
                {transportLabel(connector.transport)}
                {' · '}
                {authLabel(connector)}
                {' · '}
                {connector.tools.length} {t('settings.mcp.toolsCount')}
                {' · '}
                {enabledAgents} {t('settings.mcp.enabledAgentsCount')}
              </div>
              {/* A connector that failed used to read only "failed". The reason
                  the runtime recorded is the whole point of looking here. */}
              {connector.error && (
                <div className={styles['settings-inline-error']} data-testid={`mcp-connector-error-${connector.id}`}>
                  {connector.error}
                </div>
              )}
              {/* A tool dropped for an ambiguous id is otherwise indistinguishable
                  from a tool the server never offered, so each clash is spelled
                  out — but grouped by the fix it needs, not by its casualties. */}
              {collisionRows.length > 0 && (
                <div data-testid={`mcp-connector-collisions-${connector.id}`}>
                  {collisionRows.map(row => (
                    <div
                      key={row.key}
                      className={styles['settings-inline-error']}
                      data-testid="mcp-connector-collision-row"
                    >
                      {row.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className={`${styles['skills-list-actions']} ${styles['mcp-list-actions']}`}>
              {canStart(connector.status) ? (
                <button
                  className={styles['pv-add-form-btn']}
                  type="button"
                  disabled={!globalEnabled || busy('start')}
                  onClick={() => onAction(connector.id, 'start')}
                >
                  {t('settings.mcp.start')}
                </button>
              ) : (
                <button
                  className={styles['pv-add-form-btn']}
                  type="button"
                  disabled={busy('stop') || !canStop(connector.status)}
                  onClick={() => onAction(connector.id, 'stop')}
                >
                  {t('settings.mcp.stop')}
                </button>
              )}
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                onClick={() => onOpen(connector.id)}
              >
                {t('settings.mcp.manage')}
              </button>
              {/* Removal sits apart from the reversible actions and carries the
                  danger styling, so it cannot be hit while aiming for stop. */}
              <span className={styles['mcp-list-danger-slot']}>
                <button
                  className={`${styles['pv-add-form-btn']} ${styles['danger']}`}
                  type="button"
                  disabled={busy('remove')}
                  onClick={() => onRemove(connector.id)}
                >
                  {t('common.remove')}
                </button>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One notice per thing the user has to fix, rather than one per casualty.
 *
 * Two connector ids that normalize onto each other take down every tool both of
 * them carry. That is a single mistake with a single fix, and a connector with
 * fifty tools would otherwise stack fifty identical red lines onto its row and
 * bury everything else on the page, so those fold into one summary per
 * counterpart. A connector clashing with itself is the opposite case: each pair
 * is its own tool naming to correct, and summarizing them would throw away the
 * only detail that makes them actionable. A clash with the built-in status tool
 * gets its own wording, because there the host tool survives and the generic
 * notice would claim a casualty that does not exist.
 */
function buildCollisionRows(connector: McpConnector): Array<{ key: string; text: string }> {
  const collisions = connector.collisions || [];
  const perCounterpart = new Map<string, number>();
  for (const collision of collisions) {
    if (collision.host || collision.otherConnectorId === connector.id) continue;
    perCounterpart.set(
      collision.otherConnectorId,
      (perCounterpart.get(collision.otherConnectorId) || 0) + 1,
    );
  }

  const summarized = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const collision of collisions) {
    const a = `${connector.id}/${collision.toolName}`;
    if (collision.host) {
      rows.push({
        key: `host-${collision.toolName}`,
        text: t('settings.mcp.toolCollisionHostNotice', { a }),
      });
      continue;
    }
    const count = perCounterpart.get(collision.otherConnectorId) || 0;
    if (count > 1) {
      if (summarized.has(collision.otherConnectorId)) continue;
      summarized.add(collision.otherConnectorId);
      rows.push({
        key: `summary-${collision.otherConnectorId}`,
        text: t('settings.mcp.toolCollisionSummary', { count, other: collision.otherConnectorId }),
      });
      continue;
    }
    rows.push({
      key: `${collision.canonical}-${collision.toolName}`,
      text: t('settings.mcp.toolCollisionNotice', {
        a,
        b: `${collision.otherConnectorId}/${collision.otherToolName}`,
      }),
    });
  }
  return rows;
}

function countEnabledAgents(
  agentConfig: ConnectorListProps['agentConfig'],
  connectorId: string,
): number {
  // The tab loads one agent's config at a time, so this counts whether the
  // agent currently in view has the connector on.
  const config = agentConfig.connectors?.[connectorId] || agentConfig.servers?.[connectorId];
  return config?.enabled === true ? 1 : 0;
}

function connectorTarget(connector: McpConnector): string {
  if (connector.transport === 'stdio') {
    return [connector.command, ...(connector.args || [])].filter(Boolean).join(' ');
  }
  return connector.url || connector.id;
}

function statusLabel(connector: McpConnector): string {
  // The switch outranks the transport state: a switched-off connector reads as
  // "stopped" too, and calling it that would hide why it is not running. Start
  // already means enable-and-start, so the row needs no extra control.
  if (connector.enabled === false) return t('settings.mcp.statusDisabled');
  switch (connector.status) {
    case 'running':
      return t('settings.mcp.statusRunning');
    case 'connecting':
      return t('settings.mcp.statusConnecting');
    case 'reconnecting':
      return t('settings.mcp.statusReconnecting');
    case 'failed':
      return t('settings.mcp.statusFailed');
    case 'needs-auth':
      return t('settings.mcp.statusNeedsAuth');
    case 'stopped':
    default:
      return t('settings.mcp.statusStopped');
  }
}

// Start is offered whenever the connector is not already live or actively
// trying to connect — including failed/needs-auth, so the user can retry.
function canStart(status: McpConnector['status']): boolean {
  return status === 'stopped' || status === 'failed' || status === 'needs-auth';
}

// Stop is offered whenever there is something to tear down: a live session, an
// in-flight connect, or a reconnect/needs-auth loop the user may want to halt.
function canStop(status: McpConnector['status']): boolean {
  return status === 'running'
    || status === 'connecting'
    || status === 'reconnecting'
    || status === 'needs-auth';
}

function transportLabel(transport: string): string {
  if (transport === 'stdio') return t('settings.mcp.modeLocal');
  if (transport === 'streamable-http') return t('settings.mcp.transportStreamable');
  if (transport === 'sse') return t('settings.mcp.transportSse');
  return t('settings.mcp.transportAuto');
}

function authLabel(connector: McpConnector): string {
  if (connector.authType === 'bearer') return t('settings.mcp.authBearer');
  if (connector.authType === 'oauth') {
    return connector.authStatus === 'connected'
      ? t('settings.mcp.oauthConnected')
      : t('settings.mcp.oauthDisconnected');
  }
  return t('settings.mcp.authNone');
}
