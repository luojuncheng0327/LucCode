import React from 'react';
import { SelectWidget, Toggle } from '@/ui';
import { SettingsRow } from '../../../components/SettingsRow';
import { t } from '../../../helpers';
import type { McpConnector, McpPermissionMode } from '../types';

interface ConnectorPermissionZoneProps {
  connector: McpConnector;
  disabled: boolean;
  busy: boolean;
  onPermissionModeChange: (mode: McpPermissionMode) => void;
  onTrustReadOnlyChange: (trust: boolean) => void;
}

/**
 * Where the connector's review policy lives. The deferred-loading knobs are
 * global and live at the tab's top level, not here.
 */
export function ConnectorPermissionZone({
  connector,
  disabled,
  busy,
  onPermissionModeChange,
  onTrustReadOnlyChange,
}: ConnectorPermissionZoneProps) {
  const locked = disabled || busy;
  const allowlist = connector.permissionMode === 'allowlist';

  return (
    <>
      <SettingsRow
        label={t('settings.mcp.permissionMode')}
        hint={t('settings.mcp.permissionModeHint')}
        control={(
          <SelectWidget
            value={connector.permissionMode || 'review-all'}
            disabled={locked}
            onChange={(value) => onPermissionModeChange(value as McpPermissionMode)}
            options={[
              { value: 'review-all', label: t('settings.mcp.permissionReviewAll') },
              { value: 'allowlist', label: t('settings.mcp.permissionAllowlist') },
            ]}
          />
        )}
      />
      <SettingsRow
        label={t('settings.mcp.trustReadOnly')}
        hint={t('settings.mcp.trustReadOnlyHint')}
        hintVariant="warn"
        control={(
          <Toggle
            on={connector.trustReadOnlyHint === true}
            // Only meaningful inside an allowlist: review-all reviews everything
            // regardless of what the server declares.
            disabled={locked || !allowlist}
            ariaLabel={t('settings.mcp.trustReadOnly')}
            onChange={onTrustReadOnlyChange}
          />
        )}
      />
    </>
  );
}
