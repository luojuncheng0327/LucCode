import React, { useEffect, useState } from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { ConfirmDialog, SelectWidget } from '@/ui';
import { parseKeyValueLines, remoteUrlError, serializeKeyValueLines } from './mcp-config';
import type { McpAuthType, McpConnector, McpConnectorInput, McpTransport } from './types';

type FormMode = 'local' | 'remote';

/** The transport a remote connector uses when its saved one is a local transport. */
const DEFAULT_REMOTE_TRANSPORT: McpTransport = 'remote';

interface ConnectorFormProps {
  disabled?: boolean;
  editingConnector?: McpConnector | null;
  onAdd: (input: McpConnectorInput) => Promise<void>;
  onUpdate?: (connectorId: string, input: McpConnectorInput) => Promise<void>;
  onCancelEdit?: () => void;
}

function parseArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.includes('\n')) {
    return trimmed.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  }
  return trimmed.split(/\s+/);
}

const INITIAL_FORM = {
  mode: 'remote' as FormMode,
  name: '',
  description: '',
  url: '',
  transport: 'remote' as McpTransport,
  command: '',
  args: '',
  cwd: '',
  env: '',
  headers: '',
  registryUrl: '',
  timeout: '',
  authType: 'none' as McpAuthType,
  authorizationToken: '',
  oauthClientId: '',
  oauthClientSecret: '',
};

const fieldHalfClass = `${styles['settings-form-field']} ${styles['settings-form-field-half']}`;
const fieldFullClass = styles['settings-form-field'];

export function ConnectorForm({
  disabled,
  editingConnector,
  onAdd,
  onUpdate,
  onCancelEdit,
}: ConnectorFormProps) {
  const [form, setForm] = useState(() => editingConnector ? formFromConnector(editingConnector) : INITIAL_FORM);
  const [error, setError] = useState('');
  const [pendingMode, setPendingMode] = useState<FormMode | null>(null);

  useEffect(() => {
    setForm(editingConnector ? formFromConnector(editingConnector) : INITIAL_FORM);
    setError('');
  }, [editingConnector]);

  // Front-end validation of the URL, so a missing scheme is caught in the field
  // instead of coming back as a server error in a toast.
  const urlErrorKey = form.mode === 'remote' && form.url.trim() ? remoteUrlError(form.url) : null;
  const canSubmit = form.mode === 'local'
    ? form.command.trim().length > 0
    : form.url.trim().length > 0 && !urlErrorKey;

  /**
   * Switching an existing connector between local and remote rewrites how it
   * connects, which drops the fields the other mode does not use and tears down
   * the live client. That is a real consequence, so it is asked about first.
   */
  const requestModeChange = (mode: FormMode) => {
    if (mode === form.mode) return;
    const editingSwitchesTransport = !!editingConnector;
    if (editingSwitchesTransport) {
      setPendingMode(mode);
      return;
    }
    applyModeChange(mode);
  };

  const applyModeChange = (mode: FormMode) => {
    setForm(current => ({
      ...current,
      mode,
      // Keep the saved remote transport when returning to remote; only fall back
      // when the connector has never had one.
      transport: mode === 'local' ? 'stdio' : (isRemoteTransport(current.transport) ? current.transport : DEFAULT_REMOTE_TRANSPORT),
    }));
    setPendingMode(null);
  };

  const submit = async () => {
    setError('');
    if (urlErrorKey) {
      setError(t(urlErrorKey));
      return;
    }
    let parseError = '';
    const parseRecord = (value: string, kind: 'env' | 'headers') => {
      try {
        return parseKeyValueLines(value, kind);
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
        return {};
      }
    };
    const timeout = Number(form.timeout);
    const common = {
      name: form.name,
      description: form.description,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    };
    const input: McpConnectorInput = form.mode === 'local'
      ? {
          ...common,
          name: form.name || form.command,
          transport: 'stdio',
          command: form.command,
          args: parseArgs(form.args),
          cwd: form.cwd,
          env: parseRecord(form.env, 'env'),
          registryUrl: form.registryUrl,
        }
      : {
          ...common,
          name: form.name || form.url,
          transport: form.transport,
          url: form.url,
          headers: parseRecord(form.headers, 'headers'),
          authType: form.authType,
          authorizationToken: form.authType === 'bearer' ? form.authorizationToken : '',
          oauthClientId: form.authType === 'oauth' ? form.oauthClientId : '',
          oauthClientSecret: form.authType === 'oauth' ? form.oauthClientSecret : '',
        };
    if (parseError) {
      setError(parseError);
      return;
    }
    if (editingConnector && onUpdate) {
      await onUpdate(editingConnector.id, input);
    } else {
      await onAdd(input);
    }
    setForm(INITIAL_FORM);
  };

  return (
    <div className={styles['pv-add-form']}>
      <div className={styles['settings-form-grid']}>
        <div className={fieldHalfClass}>
          <label className={styles['settings-form-label']}>{t('settings.mcp.connectorName')}</label>
          <input
            className={styles['settings-input']}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="GitHub"
          />
        </div>
        <div className={fieldHalfClass}>
          <label className={styles['settings-form-label']}>{t('settings.mcp.connectorMode')}</label>
          <SelectWidget
            value={form.mode}
            onChange={(v) => requestModeChange(v as FormMode)}
            options={[
              { value: 'remote', label: t('settings.mcp.modeRemote') },
              { value: 'local',  label: t('settings.mcp.modeLocal') },
            ]}
          />
        </div>
      </div>
      <div className={fieldFullClass}>
        <label className={styles['settings-form-label']}>{t('settings.mcp.description')}</label>
        <input
          className={styles['settings-input']}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder={t('settings.mcp.descriptionPlaceholder')}
        />
      </div>

      {form.mode === 'remote' ? (
        <>
          <div className={styles['settings-form-grid']}>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.remoteUrl')}</label>
              <input
                className={styles['settings-input']}
                value={form.url}
                aria-invalid={!!urlErrorKey}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
              />
              {urlErrorKey && (
                <span className={styles['settings-inline-error']}>{t(urlErrorKey)}</span>
              )}
            </div>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.transport')}</label>
              <SelectWidget
                value={form.transport}
                onChange={(v) => setForm({ ...form, transport: v as McpTransport })}
                options={[
                  { value: 'remote',          label: t('settings.mcp.transportAuto') },
                  { value: 'streamable-http', label: t('settings.mcp.transportStreamable') },
                  { value: 'sse',             label: t('settings.mcp.transportSse') },
                ]}
              />
            </div>
          </div>
          <div className={styles['settings-form-grid']}>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.authType')}</label>
              <SelectWidget
                value={form.authType}
                onChange={(v) => setForm({ ...form, authType: v as McpAuthType })}
                options={[
                  { value: 'none',   label: t('settings.mcp.authNone') },
                  { value: 'bearer', label: t('settings.mcp.authBearer') },
                  { value: 'oauth',  label: t('settings.mcp.authOAuth') },
                ]}
              />
            </div>
            {form.authType === 'bearer' && (
              <div className={fieldHalfClass}>
                <label className={styles['settings-form-label']}>{t('settings.mcp.authToken')}</label>
                <input
                  className={styles['settings-input']}
                  type="password"
                  value={form.authorizationToken}
                  onChange={(e) => setForm({ ...form, authorizationToken: e.target.value })}
                  placeholder="Bearer token"
                />
              </div>
            )}
          </div>
          {form.authType === 'oauth' && (
            <div className={styles['settings-form-grid']}>
              <div className={fieldHalfClass}>
                <label className={styles['settings-form-label']}>{t('settings.mcp.oauthClientId')}</label>
                <input
                  className={styles['settings-input']}
                  value={form.oauthClientId}
                  onChange={(e) => setForm({ ...form, oauthClientId: e.target.value })}
                  placeholder="client_id"
                />
              </div>
              <div className={fieldHalfClass}>
                <label className={styles['settings-form-label']}>{t('settings.mcp.oauthClientSecret')}</label>
                <input
                  className={styles['settings-input']}
                  type="password"
                  value={form.oauthClientSecret}
                  onChange={(e) => setForm({ ...form, oauthClientSecret: e.target.value })}
                  placeholder="client_secret"
                />
              </div>
            </div>
          )}
          <div className={fieldFullClass}>
            <label className={styles['settings-form-label']}>{t('settings.mcp.headers')}</label>
            <textarea
              className={styles['settings-textarea']}
              value={form.headers}
              onChange={(e) => setForm({ ...form, headers: e.target.value })}
              placeholder={'Authorization=Bearer token\nX-API-Key=secret'}
            />
            <span className={styles['settings-form-hint']}>{t('settings.mcp.headersHint')}</span>
          </div>
        </>
      ) : (
        <>
          <div className={styles['settings-form-grid']}>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.command')}</label>
              <input
                className={styles['settings-input']}
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx"
              />
            </div>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.args')}</label>
              <input
                className={styles['settings-input']}
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder="-y @modelcontextprotocol/server-github"
              />
            </div>
          </div>
          <div className={styles['settings-form-grid']}>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.cwd')}</label>
              <input
                className={styles['settings-input']}
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder={t('settings.mcp.cwdPlaceholder')}
              />
            </div>
            <div className={fieldHalfClass}>
              <label className={styles['settings-form-label']}>{t('settings.mcp.registryUrl')}</label>
              <input
                className={styles['settings-input']}
                value={form.registryUrl}
                onChange={(e) => setForm({ ...form, registryUrl: e.target.value })}
                placeholder="https://registry.npmmirror.com"
              />
            </div>
          </div>
          <div className={fieldFullClass}>
            <label className={styles['settings-form-label']}>{t('settings.mcp.env')}</label>
            <textarea
              className={styles['settings-textarea']}
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
              placeholder={'API_KEY=secret\nBASE_URL=https://example.com'}
            />
            <span className={styles['settings-form-hint']}>{t('settings.mcp.envHint')}</span>
          </div>
        </>
      )}

      <div className={fieldFullClass}>
        <label className={styles['settings-form-label']}>{t('settings.mcp.timeout')}</label>
        <input
          className={styles['settings-input']}
          type="number"
          min={1}
          value={form.timeout}
          onChange={(e) => setForm({ ...form, timeout: e.target.value })}
          placeholder="30"
        />
      </div>

      {error && <p className={styles['settings-muted-note']}>{error}</p>}

      <div className={styles['pv-add-form-actions']}>
        {editingConnector && (
          <button
            className={styles['pv-add-form-btn']}
            type="button"
            disabled={disabled}
            onClick={onCancelEdit}
          >
            {t('common.cancel')}
          </button>
        )}
        <button
          className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
          type="button"
          disabled={disabled || !canSubmit}
          onClick={submit}
        >
          {editingConnector ? t('settings.mcp.updateConnector') : t('settings.mcp.addConnector')}
        </button>
      </div>

      <ConfirmDialog
        open={pendingMode !== null}
        scope="window"
        title={t('settings.mcp.modeSwitchTitle')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        confirmTone="danger"
        onConfirm={() => pendingMode && applyModeChange(pendingMode)}
        onCancel={() => setPendingMode(null)}
      >
        {t('settings.mcp.modeSwitchBody')}
      </ConfirmDialog>
    </div>
  );
}

function isRemoteTransport(transport: McpTransport): boolean {
  return transport !== 'stdio';
}

function formFromConnector(connector: McpConnector): typeof INITIAL_FORM {
  const mode = connector.transport === 'stdio' ? 'local' : 'remote';
  return {
    mode,
    name: connector.name || '',
    description: connector.description || '',
    url: connector.url || '',
    // The saved transport is carried through as-is. Rewriting a local
    // connector's transport to "remote" here made the form disagree with the
    // connector it was editing the moment it opened.
    transport: connector.transport,
    command: connector.command || '',
    args: (connector.args || []).join('\n'),
    cwd: connector.cwd || '',
    env: serializeKeyValueLines(connector.env),
    headers: serializeKeyValueLines(connector.headers),
    registryUrl: connector.registryUrl || '',
    timeout: connector.timeout ? String(connector.timeout) : '',
    authType: connector.authType || 'none',
    authorizationToken: connector.authorizationToken || '',
    oauthClientId: connector.oauthClientId || '',
    oauthClientSecret: connector.oauthClientSecret || '',
  };
}
