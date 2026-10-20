import React, { useState } from 'react';
import { t } from '../../helpers';
import styles from '../../Settings.module.css';
import { connectorsFromMcpJson, remoteUrlError } from './mcp-config';
import type { McpBulkResult, McpConnectorInput } from './types';

interface ConnectorImportProps {
  busy: boolean;
  onImport: (connectors: McpConnectorInput[]) => Promise<McpBulkResult[]>;
  onDone: () => void;
  onCancel: () => void;
}

type Stage = 'paste' | 'preview' | 'result';

interface PreviewRow {
  connector: McpConnectorInput;
  include: boolean;
  /** i18n key for a problem this row would hit, or null when it is fine. */
  problem: string | null;
}

/**
 * JSON import in three steps: paste, review what was found, then submit.
 *
 * The middle step is the point. Importing used to fire one request per server
 * with no transaction and nothing shown first, so a file with a typo in the
 * fourth entry left three connectors added and no way to tell which.
 */
export function ConnectorImport({ busy, onImport, onDone, onCancel }: ConnectorImportProps) {
  const [stage, setStage] = useState<Stage>('paste');
  const [json, setJson] = useState('');
  const [parseError, setParseError] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [results, setResults] = useState<McpBulkResult[]>([]);
  const [submitError, setSubmitError] = useState('');

  const parse = () => {
    setParseError('');
    try {
      const connectors = connectorsFromMcpJson(json);
      if (connectors.length === 0) {
        setParseError(t('settings.mcp.importEmpty'));
        return;
      }
      setRows(connectors.map(connector => ({
        connector,
        include: true,
        problem: connector.transport === 'stdio'
          ? (connector.command ? null : 'settings.mcp.commandRequired')
          : remoteUrlError(connector.url || ''),
      })));
      setStage('preview');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  const selected = rows.filter(row => row.include);
  // A row the user kept but that cannot be saved blocks submission, rather than
  // being dropped silently at send time.
  const blocked = selected.some(row => row.problem);

  const submit = async () => {
    setSubmitError('');
    try {
      const outcome = await onImport(selected.map(row => row.connector));
      setResults(outcome);
      setStage('result');
    } catch (err) {
      const withResults = err as Error & { results?: McpBulkResult[] };
      setSubmitError(withResults.message);
      // The batch was refused as a whole, but the server still says which row
      // was at fault. Show that against the rows the user submitted.
      if (Array.isArray(withResults.results)) {
        setResults(withResults.results);
        setStage('result');
      }
    }
  };

  if (stage === 'result') {
    return (
      <div className={styles['pv-add-form']} data-testid="mcp-import-result">
        {submitError && <p className={styles['settings-inline-error']} role="alert">{submitError}</p>}
        <div className={styles['mcp-import-list']}>
          {results.map((result, index) => (
            <div key={selected[index]?.connector.name || index} className={styles['mcp-import-row']}>
              <span className={styles['skills-list-name']}>
                {result.id || selected[index]?.connector.name || ''}
              </span>
              <span className={result.ok ? styles['settings-form-hint'] : styles['settings-inline-error']}>
                {result.ok ? t('settings.mcp.importItemOk') : result.error}
              </span>
            </div>
          ))}
        </div>
        <div className={styles['pv-add-form-actions']}>
          {submitError ? (
            <button className={styles['pv-add-form-btn']} type="button" onClick={() => setStage('preview')}>
              {t('common.back')}
            </button>
          ) : null}
          <button
            className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
            type="button"
            onClick={submitError ? onCancel : onDone}
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'preview') {
    return (
      <div className={styles['pv-add-form']} data-testid="mcp-import-preview">
        <p className={styles['settings-form-hint']}>{t('settings.mcp.importPreviewHint')}</p>
        <div className={styles['mcp-import-list']}>
          {rows.map((row, index) => (
            <label key={`${row.connector.name}-${index}`} className={styles['mcp-import-row']}>
              <input
                type="checkbox"
                checked={row.include}
                aria-label={row.connector.name || ''}
                onChange={(e) => setRows(current => current.map((item, i) =>
                  (i === index ? { ...item, include: e.target.checked } : item)))}
              />
              <span className={styles['skills-list-name']}>{row.connector.name}</span>
              <span className={styles['settings-form-hint']}>
                {row.connector.transport === 'stdio'
                  ? [row.connector.command, ...(row.connector.args || [])].filter(Boolean).join(' ')
                  : row.connector.url}
              </span>
              <span className={styles['settings-form-hint']}>
                {row.connector.transport === 'stdio'
                  ? t('settings.mcp.modeLocal')
                  : t('settings.mcp.modeRemote')}
              </span>
              {row.problem && (
                <span className={styles['settings-inline-error']}>{t(row.problem)}</span>
              )}
            </label>
          ))}
        </div>
        <div className={styles['pv-add-form-actions']}>
          <button className={styles['pv-add-form-btn']} type="button" onClick={() => setStage('paste')}>
            {t('common.back')}
          </button>
          <button
            className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
            type="button"
            disabled={busy || selected.length === 0 || blocked}
            onClick={submit}
          >
            {t('settings.mcp.importConfirm', { count: String(selected.length) })}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles['pv-add-form']}>
      <div className={styles['settings-form-field']}>
        <label className={styles['settings-form-label']}>{t('settings.mcp.importJson')}</label>
        <textarea
          className={styles['settings-textarea']}
          value={json}
          aria-label={t('settings.mcp.importJson')}
          onChange={(e) => setJson(e.target.value)}
          placeholder={'{"mcpServers":{"example":{"command":"npx","args":["-y","mcp-server-example"]}}}'}
        />
        <span className={styles['settings-form-hint']}>{t('settings.mcp.importJsonHint')}</span>
      </div>
      {parseError && <p className={styles['settings-inline-error']} role="alert">{parseError}</p>}
      <div className={styles['pv-add-form-actions']}>
        <button className={styles['pv-add-form-btn']} type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className={`${styles['pv-add-form-btn']} ${styles['primary']}`}
          type="button"
          disabled={!json.trim()}
          onClick={parse}
        >
          {t('settings.mcp.importParse')}
        </button>
      </div>
    </div>
  );
}
