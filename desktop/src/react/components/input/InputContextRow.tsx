import { memo } from 'react';
import { AttachedFilesBar } from './AttachedFilesBar';
import { QuotedSelectionCard } from './QuotedSelectionCard';
import type { AttachedFile } from '../../stores/input-slice';
import styles from './InputArea.module.css';

interface Props {
  attachedFiles: AttachedFile[];
  removeAttachedFile: (index: number) => void;
  hasQuotedSelection: boolean;
}

/** 输入框上方的上下文行：附件、引用 */
export const InputContextRow = memo(function InputContextRow({
  attachedFiles, removeAttachedFile, hasQuotedSelection,
}: Props) {
  if (attachedFiles.length === 0 && !hasQuotedSelection) return null;

  return (
    <div className={styles['input-context-row']}>
      <div className={styles['input-context-left']}>
        {attachedFiles.length > 0 && <AttachedFilesBar files={attachedFiles} onRemove={removeAttachedFile} />}
        <QuotedSelectionCard />
      </div>
    </div>
  );
});
