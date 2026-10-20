/**
 * JianEditor — jian.md 编辑器面板
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { saveJianContent } from '../../stores/desk-actions';
import s from './Desk.module.css';

const EXEC_LOG_START = '<!-- exec-log -->';

/** 从完整 jian 内容中分离用户正文和隐藏执行记录 */
function splitJian(raw: string) {
  const startIdx = raw.indexOf(EXEC_LOG_START);
  if (startIdx === -1) return { instructions: raw, hiddenExecLogBlock: '' };
  return {
    instructions: raw.slice(0, startIdx).trimEnd(),
    hiddenExecLogBlock: raw.slice(startIdx),
  };
}

/** 将用户正文和隐藏执行记录重新拼合为完整 jian 内容 */
function combineJian(instructions: string, hiddenExecLogBlock: string) {
  if (!hiddenExecLogBlock.trim()) return instructions;
  return instructions
    ? `${instructions}\n\n${hiddenExecLogBlock.trimStart()}`
    : hiddenExecLogBlock.trimStart();
}

export function JianEditor({ showHeader = true }: { showHeader?: boolean }) {
  const deskJianContent = useStore(s => s.deskJianContent);
  const [localValue, setLocalValue] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const prevContentRef = useRef(deskJianContent);
  const hiddenExecLogBlockRef = useRef('');

  // 解析 store 内容，分离用户正文和隐藏执行记录
  const parsed = useMemo(() => splitJian(deskJianContent || ''), [deskJianContent]);

  useEffect(() => {
    if (deskJianContent !== prevContentRef.current) {
      setLocalValue(parsed.instructions);
      hiddenExecLogBlockRef.current = parsed.hiddenExecLogBlock;
      prevContentRef.current = deskJianContent;
    }
  }, [deskJianContent, parsed]);

  // 初始化
  useEffect(() => {
    setLocalValue(parsed.instructions);
    hiddenExecLogBlockRef.current = parsed.hiddenExecLogBlock;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback((instructions: string) => {
    const full = combineJian(instructions, hiddenExecLogBlockRef.current);
    useStore.setState({ deskJianContent: full });
    prevContentRef.current = full;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveJianContent(full), 800);
  }, []);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setLocalValue(value);
    save(value);
  }, [save]);

  return (
    <div className={s.editor} data-desk-editor="">
      {showHeader && (
        <div className={s.editorHeader}>
          <span className={s.editorLabel}>{(window.t ?? ((p: string) => p))('desk.jianLabel')}</span>
        </div>
      )}
      <span className={s.editorStatus} ref={statusRef}></span>
      <textarea
        className={s.editorInput}
        placeholder={(window.t ?? ((p: string) => p))('desk.jianPlaceholder')}
        spellCheck={false}
        value={localValue}
        onChange={handleInput}
      />
    </div>
  );
}
