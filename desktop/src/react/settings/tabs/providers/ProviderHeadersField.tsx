import React from 'react';
import { parseKeyValueLines, serializeKeyValueLines } from '../mcp/mcp-config';
import styles from '../../Settings.module.css';

export function parseProviderHeaderLines(value: string): Record<string, string> {
  return parseKeyValueLines(value, 'headers');
}

export function serializeProviderHeaders(value?: Record<string, string>): string {
  return serializeKeyValueLines(value);
}

export function ProviderHeadersField({
  value,
  onChange,
  onBlur,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  readOnly?: boolean;
}) {
  return (
    <textarea
      className={`${styles['settings-textarea']} ${styles['pv-headers-textarea']}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={'Authorization=Bearer token\nX-Corp-Auth=secret'}
      readOnly={readOnly}
    />
  );
}
