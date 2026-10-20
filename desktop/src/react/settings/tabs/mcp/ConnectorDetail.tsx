import React from 'react';
import { Toggle } from '@/ui';
import { SettingsSection } from '../../components/SettingsSection';
import { SettingsRow } from '../../components/SettingsRow';
import { AgentSelect } from '../bridge/AgentSelect';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { ConnectorForm } from './ConnectorForm';
import { ConnectorToolList } from './detail/ConnectorToolList';
import { ConnectorPermissionZone } from './detail/ConnectorPermissionZone';
import { OAuthWaitCard } from './OAuthWaitCard';
import type {
  McpAgentConnectorConfig,
  McpConnector,
  McpConnectorInput,
  McpPermissionMode,
  McpToolPermission,
} from './types';

interface ConnectorDetailProps {
  connector: McpConnector;
  globalEnabled: boolean;
  busyKeys: ReadonlySet<string>;
  viewAgentId: string | null;
  agentConfig: {
    connectors?: Record<string, McpAgentConnectorConfig>;
    servers?: Record<string, McpAgentConnectorConfig>;
  };
  oauthWaiting: boolean;
  onBack: () => void;
  onUpdate: (connectorId: string, input: McpConnectorInput) => Promise<void>;
  onAction: (connectorId: string, action: 'start' | 'stop' | 'refresh-tools') => void;
  onAgentChange: (agentId: string | null) => void;
  onConnectorToggle: (connectorId: string, enabled: boolean) => void;
  onToolsEnabledChange: (connectorId: string, tools: Record<string, boolean>) => void;
  onToolPermissionChange: (connectorId: string, toolName: string, permission: McpToolPermission) => void;
  onToolPinnedChange: (connectorId: string, toolName: string, pinned: boolean) => void;
  onPermissionModeChange: (connectorId: string, mode: McpPermissionMode) => void;
  onTrustReadOnlyChange: (connectorId: string, trust: boolean) => void;
  onOAuthStart: (connectorId: string) => void;
  onOAuthCancel: (connectorId: string) => void;
  onOAuthLogout: (connectorId: string) => void;
}

/**
 * Everything about one connector, on one page: how it connects, which of its
 * tools this agent may call, and how much review those calls need.
 */
export function ConnectorDetail({
  connector,
  globalEnabled,
  busyKeys,
  viewAgentId,
  agentConfig,
  oauthWaiting,
  onBack,
  onUpdate,
  onAction,
  onAgentChange,
  onConnectorToggle,
  onToolsEnabledChange,
  onToolPermissionChange,
  onToolPinnedChange,
  onPermissionModeChange,
  onTrustReadOnlyChange,
  onOAuthStart,
  onOAuthCancel,
  onOAuthLogout,
}: ConnectorDetailProps) {
  const busy = (key: string) => busyKeys.has(`${key}-${connector.id}`);
  const connectorAgentConfig = agentConfig.connectors?.[connector.id]
    || agentConfig.servers?.[connector.id]
    || {};
  const agentEnabled = connectorAgentConfig.enabled === true;

  return (
    <div data-testid={`mcp-connector-detail-${connector.id}`}>
      <div className={styles['mcp-detail-header']}>
        <button
          type="button"
          className={styles['settings-return-btn']}
          aria-label={t('common.back')}
          onClick={onBack}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className={styles['mcp-detail-heading']}>
          <div className={styles['skills-list-name']}>
            <span
              className={`${styles['pv-status-dot']}${connector.status === 'running' ? ' ' + styles['on'] : ''}`}
              aria-hidden="true"
            />
            {connector.name}
          </div>
          <div className={styles['skills-list-desc']}>{connector.description || connector.id}</div>
        </div>
        <div className={styles['skills-list-actions']}>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            disabled={!globalEnabled || busy('start')}
            onClick={() => onAction(connector.id, 'start')}
          >
            {t('settings.mcp.start')}
          </button>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            disabled={busy('stop')}
            onClick={() => onAction(connector.id, 'stop')}
          >
            {t('settings.mcp.stop')}
          </button>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            disabled={busy('refresh-tools') || connector.status !== 'running'}
            onClick={() => onAction(connector.id, 'refresh-tools')}
          >
            {t('settings.mcp.refresh')}
          </button>
        </div>
      </div>

      {connector.error && (
        <div className={styles['settings-inline-error']} role="alert">
          {connector.error}
        </div>
      )}

      {connector.authType === 'oauth' && (
        <SettingsSection title={t('settings.mcp.authOAuth')}>
          <OAuthWaitCard
            connectorId={connector.id}
            connected={connector.authStatus === 'connected'}
            waiting={oauthWaiting}
            busy={busy('oauth-logout')}
            onStart={onOAuthStart}
            onCancel={onOAuthCancel}
            onLogout={onOAuthLogout}
          />
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.mcp.connectionTitle')}>
        <ConnectorForm
          key={connector.id}
          disabled={busy('update')}
          editingConnector={connector}
          onAdd={async () => { /* detail view only ever updates an existing connector */ }}
          onUpdate={onUpdate}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.mcp.agentTitle')}
        context={<AgentSelect value={viewAgentId} onChange={onAgentChange} />}
      >
        <SettingsRow
          label={t('settings.mcp.agentConnectorEnabled')}
          hint={t('settings.mcp.agentConnectorDesc')}
          control={(
            <Toggle
              on={agentEnabled}
              disabled={!globalEnabled || busy('agent-connector')}
              ariaLabel={t('settings.mcp.agentConnectorEnabled')}
              onChange={(enabled) => onConnectorToggle(connector.id, enabled)}
            />
          )}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.mcp.toolsTitle')}>
        <ConnectorToolList
          connector={connector}
          enabledTools={connectorAgentConfig.tools || {}}
          agentConnectorEnabled={agentEnabled}
          disabled={!globalEnabled}
          busy={busy('tools') || busy('policy')}
          onToolsEnabledChange={(tools) => onToolsEnabledChange(connector.id, tools)}
          onToolPermissionChange={(toolName, permission) =>
            onToolPermissionChange(connector.id, toolName, permission)}
          onToolPinnedChange={(toolName, pinned) => onToolPinnedChange(connector.id, toolName, pinned)}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.mcp.permissionTitle')}>
        <ConnectorPermissionZone
          connector={connector}
          disabled={!globalEnabled}
          busy={busy('policy')}
          onPermissionModeChange={(mode) => onPermissionModeChange(connector.id, mode)}
          onTrustReadOnlyChange={(trust) => onTrustReadOnlyChange(connector.id, trust)}
        />
      </SettingsSection>
    </div>
  );
}
