import React, { useMemo, useState } from 'react';
import { Toggle } from '@/ui';
import { t } from '../../../helpers';
import styles from '../../../Settings.module.css';
import type { McpConnector, McpTool, McpToolPermission } from '../types';

interface ConnectorToolListProps {
  connector: McpConnector;
  /** Per-agent tool enablement for the agent currently in view. */
  enabledTools: Record<string, boolean>;
  /** False when the connector itself is off for this agent; tool switches are moot then. */
  agentConnectorEnabled: boolean;
  disabled: boolean;
  busy: boolean;
  onToolsEnabledChange: (tools: Record<string, boolean>) => void;
  onToolPermissionChange: (toolName: string, permission: McpToolPermission) => void;
  onToolPinnedChange: (toolName: string, pinned: boolean) => void;
}

/**
 * The connector's tools, with the three independent decisions each one carries:
 * whether this agent may use it, whether calling it needs review, and whether it
 * stays loaded up front. Selection is batched — forty tools used to mean forty
 * requests, one per switch.
 */
export function ConnectorToolList({
  connector,
  enabledTools,
  agentConnectorEnabled,
  disabled,
  busy,
  onToolsEnabledChange,
  onToolPermissionChange,
  onToolPinnedChange,
}: ConnectorToolListProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(true);

  const tools = connector.tools || [];
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter(tool =>
      tool.name.toLowerCase().includes(needle)
      || (tool.title || '').toLowerCase().includes(needle)
      || (tool.description || '').toLowerCase().includes(needle));
  }, [tools, query]);

  const isEnabled = (tool: McpTool) => enabledTools[tool.name] === true;
  // Bulk actions act on what the user can currently see, so a filtered list
  // cannot silently flip tools that scrolled out of the search.
  const applyToVisible = (next: (tool: McpTool) => boolean) => {
    const patch: Record<string, boolean> = {};
    for (const tool of visible) {
      const value = next(tool);
      if (value !== isEnabled(tool)) patch[tool.name] = value;
    }
    if (Object.keys(patch).length > 0) onToolsEnabledChange(patch);
  };

  const selectionDisabled = disabled || busy || !agentConnectorEnabled;

  if (tools.length === 0) {
    return (
      <p className={`${styles['agent-skill-empty']} ${styles['mcp-empty-state']}`}>
        {t('settings.mcp.noTools')}
      </p>
    );
  }

  return (
    <div className={styles['mcp-tool-zone']}>
      <div className={styles['mcp-tool-toolbar']}>
        <button
          type="button"
          className={styles['mcp-tool-collapse']}
          aria-expanded={expanded}
          onClick={() => setExpanded(open => !open)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            data-expanded={expanded}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          {t('settings.mcp.toolsTitle')}
          <span className={styles['skills-list-name-hint']}>
            {visible.length}/{tools.length}
          </span>
        </button>
        <div className={styles['settings-search-shell']}>
          <svg
            className={styles['settings-search-icon']}
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            className={styles['settings-search-input']}
            value={query}
            aria-label={t('settings.mcp.toolSearch')}
            placeholder={t('settings.mcp.toolSearch')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
          />
        </div>
      </div>

      {expanded && (
        <>
          <div className={styles['mcp-tool-bulk']}>
            <button
              type="button"
              className={styles['settings-text-btn']}
              disabled={selectionDisabled}
              onClick={() => applyToVisible(() => true)}
            >
              {t('settings.mcp.selectAll')}
            </button>
            <button
              type="button"
              className={styles['settings-text-btn']}
              disabled={selectionDisabled}
              onClick={() => applyToVisible(() => false)}
            >
              {t('settings.mcp.selectNone')}
            </button>
            <button
              type="button"
              className={styles['settings-text-btn']}
              disabled={selectionDisabled}
              onClick={() => applyToVisible(tool => !isEnabled(tool))}
            >
              {t('settings.mcp.selectInvert')}
            </button>
          </div>

          {visible.length === 0 ? (
            <p className={`${styles['agent-skill-empty']} ${styles['mcp-empty-state']}`}>
              {t('settings.mcp.noToolMatches')}
            </p>
          ) : (
            visible.map(tool => {
              const permission: McpToolPermission = connector.toolPermissions?.[tool.name] || 'review';
              const destructive = tool.annotations?.destructiveHint === true;
              const readOnly = tool.annotations?.readOnlyHint === true;
              return (
                <div key={tool.name} className={`${styles['skills-list-item']} ${styles['mcp-tool-row']}`}>
                  <label className={styles['skills-list-info']}>
                    <div className={styles['skills-list-name']}>
                      <input
                        type="checkbox"
                        className={styles['mcp-tool-check']}
                        checked={isEnabled(tool)}
                        disabled={selectionDisabled}
                        aria-label={tool.title || tool.name}
                        onChange={(e) => onToolsEnabledChange({ [tool.name]: e.target.checked })}
                      />
                      {tool.title || tool.name}
                      {/* Badges restate what the running server declares about the
                          tool. They are its claims, not verified facts. */}
                      {readOnly && (
                        <span className={styles['mcp-badge']}>{t('settings.mcp.badgeReadOnly')}</span>
                      )}
                      {destructive && (
                        <span className={`${styles['mcp-badge']} ${styles['mcp-badge-danger']}`}>
                          {t('settings.mcp.badgeDestructive')}
                        </span>
                      )}
                    </div>
                    <div className={styles['skills-list-desc']}>{tool.description || tool.name}</div>
                  </label>
                  <div className={styles['skills-list-actions']}>
                    <label className={styles['mcp-tool-inline-control']}>
                      <span className={styles['settings-form-hint']}>{t('settings.mcp.permissionAllow')}</span>
                      <Toggle
                        on={permission === 'allow'}
                        // A server-declared destructive tool is never silently
                        // approved, so the control that would grant it is not
                        // offered at all.
                        disabled={disabled || busy || destructive || connector.permissionMode !== 'allowlist'}
                        ariaLabel={`${tool.name} ${t('settings.mcp.permissionAllow')}`}
                        onChange={(on) => onToolPermissionChange(tool.name, on ? 'allow' : 'review')}
                      />
                    </label>
                    <label className={styles['mcp-tool-inline-control']}>
                      <span className={styles['settings-form-hint']}>{t('settings.mcp.pinTool')}</span>
                      <Toggle
                        on={connector.pinnedTools?.[tool.name] === true}
                        disabled={disabled || busy}
                        ariaLabel={`${tool.name} ${t('settings.mcp.pinTool')}`}
                        onChange={(on) => onToolPinnedChange(tool.name, on)}
                      />
                    </label>
                  </div>
                </div>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
