import { memo, useEffect, useRef, type RefObject } from 'react';
import type { FileMentionItem } from '../../utils/file-mention-items';
import { kindOfFileName } from '../../utils/file-kind';
import { FileKindIcon } from '../shared/FileKindIcon';
import { FolderIcon } from '../shared/FolderIcon';
import styles from './InputArea.module.css';

export const FileMentionMenu = memo(function FileMentionMenu({
  items,
  selected,
  busy,
  onSelect,
  onHover,
}: {
  items: FileMentionItem[];
  selected: number;
  busy: boolean;
  onSelect: (item: FileMentionItem) => void;
  onHover: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof selectedRef.current?.scrollIntoView === 'function') {
      selectedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  return (
    <div className={styles['file-mention-menu']}>
      {items.map((item, i) => (
        <FileMentionButton
          key={item.id}
          item={item}
          selected={i === selected}
          refProp={i === selected ? selectedRef : undefined}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item)}
        />
      ))}
      {items.length === 0 && busy && <div className={styles['file-mention-empty']}>...</div>}
    </div>
  );
});

function FileMentionButton({
  item,
  selected,
  refProp,
  onHover,
  onSelect,
}: {
  item: FileMentionItem;
  selected: boolean;
  refProp?: RefObject<HTMLButtonElement | null>;
  onHover: () => void;
  onSelect: () => void;
}) {
  const fileKind = kindOfFileName(item.name || item.path, item.mimeType);
  const thumbnailUrl = !item.isDirectory && (fileKind === 'image' || fileKind === 'svg') && item.path && typeof window !== 'undefined'
    ? window.platform?.getFileUrl?.(item.path)
    : null;

  return (
    <button
      ref={refProp}
      className={`${styles['file-mention-item']}${selected ? ` ${styles.selected}` : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
    >
      <span className={styles['file-mention-icon']} aria-hidden="true">
        {thumbnailUrl ? (
          <img className={styles['file-mention-thumbnail']} src={thumbnailUrl} alt="" />
        ) : item.isDirectory ? <FolderIcon size={18} /> : <FileKindIcon kind={fileKind} size={18} />}
      </span>
      <span className={styles['file-mention-main']}>
        <span className={styles['file-mention-name']}>{item.name}</span>
        <span className={styles['file-mention-detail']}>{item.detail || item.path}</span>
      </span>
    </button>
  );
}
