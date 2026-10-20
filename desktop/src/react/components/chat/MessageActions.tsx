// desktop/src/react/components/chat/MessageActions.tsx
import { memo, useCallback, useMemo } from 'react';
import type { MouseEvent } from 'react';
import { useStore } from '../../stores';
import { useI18n } from '../../hooks/use-i18n';
import { selectSelectedIdsBySession } from '../../stores/session-selectors';
import { sessionScopedValue } from '../../stores/session-slice';
import { MessageFooterActions, type MessageFooterAction } from './MessageFooterActions';

interface Props {
  messageId: string;
  selectionIds?: readonly string[];
  sessionPath: string;
  onCopy: () => void;
  onScreenshot: () => void;
  copied: boolean;
  isStreaming: boolean;
  align?: 'left' | 'right';
}

export function useMessageFooterActions({
  messageId,
  selectionIds,
  sessionPath,
  onCopy,
  onScreenshot,
  copied,
  isStreaming,
}: Props): MessageFooterAction[] {
  const { t } = useI18n();
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const sessionItems = useStore(s => sessionScopedValue(s, s.chatSessions, sessionPath)?.items);
  const setSelection = useStore(s => s.setMessageSelection);
  const targetSelectionIds = useMemo(() => {
    const ids = selectionIds && selectionIds.length > 0 ? selectionIds : [messageId];
    return Array.from(new Set(ids.filter(Boolean)));
  }, [messageId, selectionIds]);
  const targetSelectionIdSet = useMemo(() => new Set(targetSelectionIds), [targetSelectionIds]);
  const isSelected = targetSelectionIds.length > 0 && targetSelectionIds.every(id => selectedIds.includes(id));
  const selectableIds = useMemo(() => (
    (sessionItems || [])
      .filter(item => item.type === 'message')
      .map(item => item.data.id)
  ), [sessionItems]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.includes(id));

  const handleToggle = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (isSelected) {
      setSelection(sessionPath, selectedIds.filter(id => !targetSelectionIdSet.has(id)));
      return;
    }
    setSelection(sessionPath, [...selectedIds, ...targetSelectionIds]);
  }, [isSelected, selectedIds, sessionPath, setSelection, targetSelectionIdSet, targetSelectionIds]);

  const handleSelectAll = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setSelection(sessionPath, allSelected ? [] : selectableIds);
  }, [allSelected, selectableIds, setSelection, sessionPath]);

  return useMemo(() => [
    {
      id: 'copy',
      title: t('common.copyText'),
      icon: copied ? <CheckIcon /> : <CopyIcon />,
      onClick: () => onCopy(),
      disabled: isStreaming,
      active: copied,
    },
    {
      id: 'screenshot',
      title: t('common.screenshot'),
      icon: <ScreenshotIcon />,
      onClick: () => onScreenshot(),
      disabled: isStreaming,
    },
    {
      id: 'select-all',
      title: t('common.selectAllMessages'),
      icon: <SelectAllIcon />,
      onClick: handleSelectAll,
      disabled: isStreaming,
      active: allSelected,
      pressed: allSelected,
    },
    {
      id: 'select',
      title: t('common.selectMessage'),
      icon: <SelectMessageIcon selected={isSelected} />,
      onClick: handleToggle,
      disabled: isStreaming,
      active: isSelected,
      pressed: isSelected,
    },
  ], [allSelected, copied, handleSelectAll, handleToggle, isSelected, isStreaming, onCopy, onScreenshot, t]);
}

export const MessageActions = memo(function MessageActions(props: Props) {
  const { align = 'right' } = props;
  const actions = useMessageFooterActions(props);

  return (
    <MessageFooterActions
      align={align}
      actions={actions}
      visible
      testId="message-actions-inline"
    />
  );
});

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ScreenshotIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function SelectAllIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="m3 6 1 1 2-2" />
      <path d="m3 12 1 1 2-2" />
      <path d="m3 18 1 1 2-2" />
    </svg>
  );
}

function SelectMessageIcon({ selected }: { selected: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {selected
        ? <>
            <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" opacity="0.15" />
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <polyline points="9 12 11.5 14.5 16 9" />
          </>
        : <rect x="3" y="3" width="18" height="18" rx="2" />
      }
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
