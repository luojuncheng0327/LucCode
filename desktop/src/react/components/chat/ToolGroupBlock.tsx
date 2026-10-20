/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useState, useCallback, useEffect } from 'react';
import { Collapse } from '@/ui';
import styles from './Chat.module.css';
import { extractToolDetail } from '../../utils/message-parser';
import type { ToolDetail } from '../../utils/message-parser';
import { openInternalLink } from '../../utils/link-open';
import { isToolCallHiddenFromProcessUi } from '../../utils/tool-call-visibility';
import { getToolLabel, phaseForStatus, sessionToolTargetName, sessionToolTargetPath } from '../../utils/tool-label';
import { useStore } from '../../stores';
import { switchSession } from '../../stores/session-actions';
import { LinkContextMenu, type LinkContextMenuState } from '../shared/LinkContextMenu';

import type { ToolCall } from '../../stores/chat-types';

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools: rawTools, collapsed: initialCollapsed, agentName = 'Luc' }: Props) {
  // 独立卡片或产物块承接状态的工具，不在工具组里重复显示。
  const tools = rawTools.filter(t => !isToolCallHiddenFromProcessUi(t));
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  useEffect(() => {
    setCollapsed(initialCollapsed);
  }, [initialCollapsed]);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  if (tools.length === 0) return null;

  const allDone = tools.every(t => t.status ? t.status !== 'running' : t.done);
  const failCount = tools.filter(t => t.status === 'failed' || (!t.status && t.done && !t.success)).length;
  const isSingle = tools.length === 1;

  // 摘要标题
  const _t = window.t ?? ((p: string) => p);
  let summaryText = '';
  if (allDone) {
    if (failCount > 0) {
      summaryText = _t('toolGroup.countWithFail', { total: tools.length, fail: failCount });
    } else {
      summaryText = _t('toolGroup.count', { n: tools.length });
    }
  } else {
    const running = tools.filter(t => !t.done).length;
    summaryText = _t('toolGroup.running', { n: running });
  }

  return (
    <div className={`${styles.toolGroup}${isSingle ? ` ${styles.toolGroupSingle}` : ''}`}>
      {!isSingle && (
        <div
          className={`${styles.toolGroupSummary}${allDone ? ` ${styles.toolGroupSummaryClickable}` : ''}`}
          onClick={allDone ? toggle : undefined}
        >
          <span className={styles.toolGroupTitle}>{summaryText}</span>
          {allDone && <span className={styles.toolGroupArrow}>{collapsed ? '›' : '‹'}</span>}
          {!allDone && (
            <span className={styles.toolDots} />
          )}
        </div>
      )}
      {isSingle ? (
        <div className={styles.toolGroupContent}>
          {tools.map((tool, i) => (
            <ToolIndicator key={tool.id || `${tool.name}-${i}`} tool={tool} agentName={agentName} />
          ))}
        </div>
      ) : (
        <Collapse open={!collapsed}>
          <div className={styles.toolGroupContent}>
            {tools.map((tool, i) => (
              <ToolIndicator key={tool.id || `${tool.name}-${i}`} tool={tool} agentName={agentName} />
            ))}
          </div>
        </Collapse>
      )}
    </div>
  );
});

// ── ToolIndicator ──

function handleDetailClick(e: React.MouseEvent, detail: ToolDetail) {
  e.preventDefault();
  e.stopPropagation();
  if (!detail.href) return;
  void openInternalLink(detail.href, { origin: 'session' });
}

const ToolIndicator = memo(function ToolIndicator({ tool, agentName }: { tool: ToolCall; agentName: string }) {
  const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);

  // session 工具指向另一个会话，把它的名字显示出来并支持点过去。两个 selector 各返回
  // 字符串或 null，引用稳定，不会让每个工具行都因为 sessions 变动而重渲染。
  const isSessionTool = tool.name === 'session';
  const sessionTargetName = useStore(s => (isSessionTool ? sessionToolTargetName(s, tool.args) : null));
  const sessionTargetPath = useStore(s => (isSessionTool ? sessionToolTargetPath(s, tool.args) : null));

  const rawDetail = extractToolDetail(tool.name, tool.args);
  const detail = sessionTargetName ? { ...rawDetail, text: sessionTargetName } : rawDetail;
  const detailTitle = detail.title || detail.href;
  const status = tool.status || (tool.done ? (tool.success ? 'succeeded' : 'failed') : 'running');
  // 失败的工具要说失败：此前这里只传 done/running，失败的读文件会显示"翻完了 ✗"
  const label = getToolLabel(tool.name, phaseForStatus(status), agentName, tool.args);

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <>
      <div className={styles.toolIndicator} data-tool={tool.name} data-done={String(tool.done)}>
        <span className={styles.toolDesc}>{label}</span>
        {detail.text && (
          sessionTargetPath ? (
            <span
              className={`${styles.toolDetail} ${styles.toolDetailLink}`}
              title={detailTitle || detail.text}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void switchSession(sessionTargetPath);
              }}
            >
              {detail.text}
            </span>
          ) : detail.href ? (
            <span
              className={`${styles.toolDetail} ${styles.toolDetailLink}`}
              title={detailTitle}
              onClick={(e) => handleDetailClick(e, detail)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!detail.href) return;
                setLinkMenu({
                  href: detail.href,
                  context: { origin: 'session', label: detail.text },
                  position: { x: e.clientX, y: e.clientY },
                });
              }}
            >
              {detail.text}
            </span>
          ) : (
            <span className={styles.toolDetail} title={detailTitle}>{detail.text}</span>
          )
        )}
        {tool.error && (
          <span className={styles.toolDetail} title={tool.error}>{tool.error}</span>
        )}
        {tag && <span className={styles.toolTag}>{tag}</span>}
        {status !== 'running' ? (
          <span className={`${styles.toolStatus} ${status === 'succeeded' ? styles.toolStatusDone : styles.toolStatusFailed}`}>
            {status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : '?'}
          </span>
        ) : (
          <span className={styles.toolDots} />
        )}
      </div>
      {linkMenu && (
        <LinkContextMenu
          state={linkMenu}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </>
  );
});
