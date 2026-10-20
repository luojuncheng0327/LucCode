import React, { useRef } from 'react';
import { useSettingsStore } from '../../store';
import { lucUrl, yuanFallbackAvatar } from '../../api';
import { SelectWidget, type SelectOption } from '@/ui';
import styles from '../../Settings.module.css';

interface AgentSelectProps {
  value: string | null;
  onChange: (agentId: string) => void;
}

export function AgentSelect({ value, onChange }: AgentSelectProps) {
  const agents = useSettingsStore((s) => s.agents);

  const options: SelectOption[] = agents.map((a) => ({
    value: a.id,
    label: a.name,
  }));

  const tsRef = useRef(Date.now());
  const ts = tsRef.current;

  const renderTrigger = (option: SelectOption | undefined, isOpen: boolean) => {
    const agent = agents.find((a) => a.id === option?.value);
    return (
      <>
        <img
          className={styles['bridge-agent-avatar']}
          src={agent?.hasAvatar ? lucUrl(`/api/agents/${agent.id}/avatar?t=${ts}`) : yuanFallbackAvatar(agent?.yuan || 'luc')}
          onError={(e) => { (e.target as HTMLImageElement).src = yuanFallbackAvatar(agent?.yuan || 'luc'); }}
        />
        <span className={styles['bridge-agent-name']}>{agent?.name || '—'}</span>
        <svg className={`${styles['bridge-agent-arrow']}${isOpen ? ` ${styles['open']}` : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </>
    );
  };

  const renderOption = (option: SelectOption, isSelected: boolean) => {
    const agent = agents.find((a) => a.id === option.value);
    /* 直接返回内容，不包内层 div，让 SelectWidget 的 option 作为唯一容器，
     * selected 高亮自然贴到 popup 边，padding 只算一次 */
    return (
      <>
        <img
          className={styles['bridge-agent-avatar']}
          src={agent?.hasAvatar ? lucUrl(`/api/agents/${agent.id}/avatar?t=${ts}`) : yuanFallbackAvatar(agent?.yuan || 'luc')}
          onError={(e) => { (e.target as HTMLImageElement).src = yuanFallbackAvatar(agent?.yuan || 'luc'); }}
        />
        <span className={styles['bridge-agent-name']}>{option.label}</span>
        {isSelected && (
          <svg className={styles['bridge-agent-check']} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </>
    );
  };

  return (
    <div className={styles['bridge-agent-select']}>
      <SelectWidget
        options={options}
        value={value || ''}
        onChange={onChange}
        placeholder="Select Agent"
        renderTrigger={renderTrigger}
        renderOption={renderOption}
      />
    </div>
  );
}
