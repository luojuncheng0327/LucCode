import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store';
import { t } from '../helpers';
import { SettingsSection } from '../components/SettingsSection';
import { ConfirmDialog, Toggle } from '@/ui';
import { ConnectorDetail } from './mcp/ConnectorDetail';
import { DeferSettings } from './mcp/DeferSettings';
import { ConnectorForm } from './mcp/ConnectorForm';
import { ConnectorImport } from './mcp/ConnectorImport';
import { ConnectorList } from './mcp/ConnectorList';
import {
  EMPTY_MCP_STATE,
  addMcpConnector,
  addMcpConnectorsBulk,
  cancelMcpOAuth,
  loadMcpState,
  logoutMcpOAuth,
  pollMcpOAuth,
  removeMcpConnector,
  runMcpConnectorAction,
  setAgentMcpConnector,
  setAgentMcpTools,
  setMcpDeferSettings,
  setMcpEnabled,
  startMcpOAuth,
  updateMcpConnector,
  updateMcpConnectorPolicy,
} from './mcp/mcp-api';
import type {
  McpConnectorInput,
  McpPermissionMode,
  McpToolPermission,
} from './mcp/types';
import styles from '../Settings.module.css';

const platform = window.platform;

/** How long a browser OAuth round trip is waited on before it is given up as stale. */
const OAUTH_POLL_INTERVAL_MS = 3000;
const OAUTH_POLL_ATTEMPTS = 100;

export function McpTab() {
  const currentAgentId = useSettingsStore(s => s.currentAgentId);
  const showToast = useSettingsStore(s => s.showToast);
  const [viewAgentId, setViewAgentId] = useState<string | null>(currentAgentId);
  const viewAgentIdRef = useRef(viewAgentId);
  viewAgentIdRef.current = viewAgentId;

  const [state, setState] = useState(EMPTY_MCP_STATE);
  const [loadingState, setLoadingState] = useState(true);
  // One key per in-flight mutation. Two connectors can be busy at once without
  // one disabling the other's controls, and edit no longer shares remove's key.
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [openConnectorId, setOpenConnectorId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [oauthWaitingId, setOAuthWaitingId] = useState<string | null>(null);
  const oauthCancelledRef = useRef<Set<string>>(new Set());
  // Only the newest load may write state; a slower earlier response must not
  // overwrite a fresher one after concurrent mutations.
  const loadSequenceRef = useRef(0);

  useEffect(() => {
    if (!viewAgentId && currentAgentId) setViewAgentId(currentAgentId);
  }, [currentAgentId, viewAgentId]);

  const loadState = useCallback(async () => {
    const agentId = viewAgentIdRef.current;
    if (!agentId) {
      setLoadingState(false);
      return;
    }
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    setLoadingState(true);
    try {
      const data = await loadMcpState(agentId);
      if (loadSequenceRef.current !== sequence || viewAgentIdRef.current !== agentId) return;
      setState(data);
    } catch (err) {
      console.error('[mcp] load failed:', err);
    } finally {
      if (loadSequenceRef.current === sequence) setLoadingState(false);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState, viewAgentId]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyKeys(current => new Set(current).add(key));
    try {
      await action();
      await loadState();
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusyKeys(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const requireAgentId = () => {
    const agentId = viewAgentIdRef.current;
    if (!agentId) throw new Error('agentId is required');
    return agentId;
  };

  const toggleGlobal = (enabled: boolean) => run('global', () => setMcpEnabled(enabled));
  const toggleGlobalFromRow = () => {
    if (loadingState || busyKeys.has('global')) return;
    toggleGlobal(!state.enabled);
  };

  const addConnector = (input: McpConnectorInput) => run('add', async () => {
    await addMcpConnector(input);
    setAddOpen(false);
  });

  const updateConnector = (connectorId: string, input: McpConnectorInput) =>
    run(`update-${connectorId}`, () => updateMcpConnector(connectorId, input));

  const importConnectors = async (connectors: McpConnectorInput[]) => {
    const results = await addMcpConnectorsBulk(connectors);
    await loadState();
    return results;
  };

  const connectorAction = (connectorId: string, action: 'start' | 'stop' | 'refresh-tools') =>
    run(`${action}-${connectorId}`, () => runMcpConnectorAction(connectorId, action));

  const removeConnector = (connectorId: string) => run(`remove-${connectorId}`, async () => {
    await removeMcpConnector(connectorId);
    setPendingRemoveId(null);
    // The page it was opened on no longer describes anything.
    setOpenConnectorId(current => (current === connectorId ? null : current));
  });

  const setAgentConnector = (connectorId: string, enabled: boolean) =>
    run(`agent-connector-${connectorId}`, () => setAgentMcpConnector(requireAgentId(), connectorId, enabled));

  const setAgentTools = (connectorId: string, tools: Record<string, boolean>) =>
    run(`tools-${connectorId}`, () => setAgentMcpTools(requireAgentId(), connectorId, tools));

  const setToolPermission = (connectorId: string, toolName: string, permission: McpToolPermission) =>
    run(`policy-${connectorId}`, () => {
      const connector = state.connectors.find(item => item.id === connectorId);
      return updateMcpConnectorPolicy(connectorId, {
        toolPermissions: { ...(connector?.toolPermissions || {}), [toolName]: permission },
      });
    });

  const setToolPinned = (connectorId: string, toolName: string, pinned: boolean) =>
    run(`policy-${connectorId}`, () => {
      const connector = state.connectors.find(item => item.id === connectorId);
      const pinnedTools = { ...(connector?.pinnedTools || {}) };
      if (pinned) pinnedTools[toolName] = true;
      else delete pinnedTools[toolName];
      return updateMcpConnectorPolicy(connectorId, { pinnedTools });
    });

  const setPermissionMode = (connectorId: string, permissionMode: McpPermissionMode) =>
    run(`policy-${connectorId}`, () => updateMcpConnectorPolicy(connectorId, { permissionMode }));

  const setTrustReadOnly = (connectorId: string, trustReadOnlyHint: boolean) =>
    run(`policy-${connectorId}`, () => updateMcpConnectorPolicy(connectorId, { trustReadOnlyHint }));

  const changeDefer = (patch: { deferEnabled?: boolean; deferThreshold?: number; builtinDeferEnabled?: boolean }) =>
    run('defer', () => setMcpDeferSettings(patch));

  const connectOAuth = async (connectorId: string) => {
    oauthCancelledRef.current.delete(connectorId);
    setOAuthWaitingId(connectorId);
    try {
      const { sessionId, url } = await startMcpOAuth(connectorId);
      platform?.openExternal?.(url);
      await waitForOAuth(sessionId);
      await loadState();
      showToast(t('settings.autoSaved'), 'success');
    } catch (err: unknown) {
      // A wait the user called off is not a failure to report at them.
      if (!oauthCancelledRef.current.has(connectorId)) {
        showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
      }
    } finally {
      oauthCancelledRef.current.delete(connectorId);
      setOAuthWaitingId(current => (current === connectorId ? null : current));
    }
  };

  const cancelOAuth = async (connectorId: string) => {
    oauthCancelledRef.current.add(connectorId);
    setOAuthWaitingId(current => (current === connectorId ? null : current));
    try {
      await cancelMcpOAuth(connectorId);
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  };

  const disconnectOAuth = (connectorId: string) =>
    run(`oauth-logout-${connectorId}`, () => logoutMcpOAuth(connectorId));

  const openConnector = state.connectors.find(connector => connector.id === openConnectorId) || null;

  if (openConnector) {
    return (
      <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="mcp">
        <ConnectorDetail
          connector={openConnector}
          globalEnabled={state.enabled}
          busyKeys={busyKeys}
          viewAgentId={viewAgentId}
          agentConfig={state.agentConfig}
          oauthWaiting={oauthWaitingId === openConnector.id}
          onBack={() => setOpenConnectorId(null)}
          onUpdate={updateConnector}
          onAction={connectorAction}
          onAgentChange={setViewAgentId}
          onConnectorToggle={setAgentConnector}
          onToolsEnabledChange={setAgentTools}
          onToolPermissionChange={setToolPermission}
          onToolPinnedChange={setToolPinned}
          onPermissionModeChange={setPermissionMode}
          onTrustReadOnlyChange={setTrustReadOnly}
          onOAuthStart={connectOAuth}
          onOAuthCancel={cancelOAuth}
          onOAuthLogout={disconnectOAuth}
        />
      </div>
    );
  }

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="mcp">
      <SettingsSection title={t('settings.mcp.masterTitle')}>
        <div
          className={styles['skills-list-item']}
          tabIndex={busyKeys.has('global') ? -1 : 0}
          onClick={toggleGlobalFromRow}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggleGlobalFromRow();
          }}
        >
          <div className={styles['skills-list-info']}>
            <div className={styles['skills-list-name']}>{t('settings.mcp.masterName')}</div>
            <div className={styles['skills-list-desc']}>{t('settings.mcp.masterDesc')}</div>
          </div>
          <div className={styles['skills-list-actions']}>
            <Toggle
              on={loadingState ? undefined : state.enabled}
              onChange={toggleGlobal}
              disabled={busyKeys.has('global')}
              label={loadingState ? t('status.loading') : state.enabled ? t('common.on') : t('common.off')}
            />
          </div>
        </div>
        <DeferSettings
          deferEnabled={state.deferEnabled}
          deferThreshold={state.deferThreshold}
          builtinDeferEnabled={state.builtinDeferEnabled}
          busy={busyKeys.has('defer') || !state.enabled}
          onChange={changeDefer}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.mcp.connectorsTitle')} surface="plain">
        <div className={styles['pv-add-form-actions']}>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            onClick={() => { setAddOpen(open => !open); setImportOpen(false); }}
          >
            {t('settings.mcp.addConnector')}
          </button>
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            onClick={() => { setImportOpen(open => !open); setAddOpen(false); }}
          >
            {t('settings.mcp.importJson')}
          </button>
        </div>

        {importOpen && (
          <ConnectorImport
            busy={busyKeys.has('import-json')}
            onImport={importConnectors}
            onDone={() => setImportOpen(false)}
            onCancel={() => setImportOpen(false)}
          />
        )}

        {addOpen && (
          <ConnectorForm
            disabled={busyKeys.has('add')}
            editingConnector={null}
            onAdd={addConnector}
            onCancelEdit={() => setAddOpen(false)}
          />
        )}

        <ConnectorList
          connectors={state.connectors}
          globalEnabled={state.enabled}
          loading={loadingState}
          busyKeys={busyKeys}
          agentConfig={state.agentConfig}
          onOpen={setOpenConnectorId}
          onAction={connectorAction}
          onRemove={setPendingRemoveId}
        />
      </SettingsSection>

      <ConfirmDialog
        open={pendingRemoveId !== null}
        scope="window"
        title={t('settings.mcp.removeTitle')}
        confirmLabel={t('common.remove')}
        cancelLabel={t('common.cancel')}
        confirmTone="danger"
        busy={pendingRemoveId ? busyKeys.has(`remove-${pendingRemoveId}`) : false}
        onConfirm={() => pendingRemoveId && removeConnector(pendingRemoveId)}
        onCancel={() => setPendingRemoveId(null)}
      >
        {t('settings.mcp.removeConfirm')}
      </ConfirmDialog>
    </div>
  );
}

async function waitForOAuth(sessionId: string): Promise<void> {
  for (let i = 0; i < OAUTH_POLL_ATTEMPTS; i += 1) {
    await new Promise(resolve => setTimeout(resolve, OAUTH_POLL_INTERVAL_MS));
    const status = await pollMcpOAuth(sessionId);
    if (status.status === 'done') return;
    if (status.status === 'cancelled') return;
    if (status.status === 'error') throw new Error(status.error || t('settings.mcp.oauthFailed'));
  }
  throw new Error(t('settings.mcp.oauthTimeout'));
}
