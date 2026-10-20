import { memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { Agent } from '../../types';
import type { FileMentionItem } from '../../utils/file-mention-items';
import type { AgentMentionItem, MentionTab, SessionMentionItem } from '../../utils/mention-items';
import { kindOfFileName } from '../../utils/file-kind';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { FileKindIcon } from '../shared/FileKindIcon';
import { FolderIcon } from '../shared/FolderIcon';
import styles from './InputArea.module.css';

export type MentionMenuItem = FileMentionItem | SessionMentionItem | AgentMentionItem;

export const MentionMenu = memo(function MentionMenu({
  tab,
  items,
  selected,
  busy,
  agents,
  onTabChange,
  onSelect,
  onHover,
}: {
  tab: MentionTab;
  items: MentionMenuItem[];
  selected: number;
  busy: boolean;
  agents: Agent[];
  onTabChange: (tab: MentionTab) => void;
  onSelect: (item: MentionMenuItem) => void;
  onHover: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const t = window.t ?? ((key: string) => key);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <div className={styles['mention-menu']} role="dialog" aria-label={t('input.mention.title')}>
      <div className={styles['mention-tabs']} role="tablist">
        {(['files', 'sessions', 'agents'] as MentionTab[]).map(value => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`${styles['mention-tab']}${tab === value ? ` ${styles.selected}` : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onTabChange(value);
            }}
          >
            {t(`input.mention.tab.${value}`)}
          </button>
        ))}
      </div>
      <div className={styles['mention-results']} role="listbox">
        {items.map((item, index) => (
          <MentionItemButton
            key={item.id}
            item={item}
            agents={agents}
            selected={index === selected}
            refProp={index === selected ? selectedRef : undefined}
            onHover={() => onHover(index)}
            onSelect={() => onSelect(item)}
          />
        ))}
        {items.length === 0 && (
          <div className={styles['mention-empty']}>
            {busy ? t('common.loading') : t('input.mention.empty')}
          </div>
        )}
      </div>
    </div>
  );
});

function MentionItemButton({
  item,
  agents,
  selected,
  refProp,
  onHover,
  onSelect,
}: {
  item: MentionMenuItem;
  agents: Agent[];
  selected: boolean;
  refProp?: RefObject<HTMLButtonElement | null>;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      ref={refProp}
      type="button"
      role="option"
      aria-selected={selected}
      className={`${styles['mention-item']}${selected ? ` ${styles.selected}` : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className={styles['mention-icon']} aria-hidden="true">
        <MentionItemIcon item={item} agents={agents} />
      </span>
      <span className={styles['mention-main']}>
        <span className={styles['mention-name']}>{item.name}</span>
        <span className={styles['mention-detail']}>{item.detail}</span>
      </span>
    </button>
  );
}

function MentionItemIcon({ item, agents }: { item: MentionMenuItem; agents: Agent[] }) {
  const agentInfo = useMemo(() => {
    if (!('kind' in item) || item.kind !== 'agent') return null;
    return resolveAgentDisplayInfo({ id: item.agentId, agents, fallbackAgentName: item.name, fallbackAgentYuan: item.yuan });
  }, [agents, item]);

  if ('kind' in item && item.kind === 'agent' && agentInfo) {
    return <AgentAvatar info={agentInfo} className={styles['mention-agent-avatar']} alt="" />;
  }
  if ('kind' in item && item.kind === 'session') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="4" y="3" width="16" height="18" rx="1" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
    );
  }

  const file = item as FileMentionItem;
  const fileKind = kindOfFileName(file.name || file.path, file.mimeType);
  const thumbnailUrl = !file.isDirectory && (fileKind === 'image' || fileKind === 'svg') && file.path
    ? window.platform?.getFileUrl?.(file.path)
    : null;
  if (thumbnailUrl) return <img className={styles['mention-thumbnail']} src={thumbnailUrl} alt="" />;
  if (file.isDirectory) return <FolderIcon size={18} />;
  return <FileKindIcon kind={fileKind} size={18} />;
}
