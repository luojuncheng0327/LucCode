import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { lucFetch } from '../../hooks/use-luc-fetch';
import { useStore } from '../../stores';
import type { SessionConfirmationBlock } from '../../stores/chat-types';
import { Tooltip } from '../../ui';
import { ElicitationForm } from './ElicitationForm';
import {
  collectElicitationValue,
  initialElicitationValues,
  missingRequiredFields,
  readElicitationForm,
  type ElicitationValues,
} from './elicitation-schema';
import {
  grantForSession,
  grantPermanently,
  loadMcpApprovalIndex,
  resolveMcpApprovalTarget,
  type McpApprovalTarget,
} from './mcp-approval-actions';
import styles from './InputArea.module.css';

type ConfirmationAction = 'confirmed' | 'rejected';

function textWithFallback(key: string, fallback: string) {
  const translated = window.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

interface SessionConfirmationPromptProps {
  block: SessionConfirmationBlock;
  exiting?: boolean;
}

function displayTitle(block: SessionConfirmationBlock) {
  if (block.kind === 'computer_app_approval') {
    const appName = block.subject?.label || textWithFallback('approval.computerApp.defaultAppName', 'this app');
    const translated = window.t?.('approval.computerApp.controlTitle', { appName });
    if (translated && translated !== 'approval.computerApp.controlTitle') return translated;
    return `Allow Luc to control ${appName}`;
  }
  return block.title;
}

function displaySubject(block: SessionConfirmationBlock, mcpTarget: McpApprovalTarget | null) {
  if (block.kind === 'computer_app_approval') {
    return {
      label: 'computer app',
      detail: block.subject?.detail || block.subject?.label || '',
    };
  }
  // A deferred MCP tool arrives as the bridge. Naming the bridge tells the user
  // nothing about what is being asked, so the real tool is named instead.
  if (mcpTarget) {
    return {
      label: `${mcpTarget.connectorName} · ${mcpTarget.toolName}`,
      detail: block.subject?.detail || '',
    };
  }
  if (block.subject?.label || block.subject?.detail) {
    return {
      label: block.subject?.label || '',
      detail: block.subject?.detail || '',
    };
  }
  return {
    label: block.body || '',
    detail: '',
  };
}

function stringifyTooltipValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatParamsTooltip(params: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return stringifyTooltipValue(params);
  }
  const readable = Object.entries(params as Record<string, unknown>)
    .map(([key, value]) => {
      const text = stringifyTooltipValue(value);
      return text ? `${key}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const json = stringifyTooltipValue(params);
  if (!readable) return json;
  return readable === json ? readable : `${readable}\n\n${json}`;
}

function buildTooltipText(
  block: SessionConfirmationBlock,
  title: string,
  subject: { label: string; detail: string },
) {
  const lines: string[] = [];
  if (title) lines.push(title);
  const subjectLine = [subject.label, subject.detail].filter(Boolean).join(': ');
  if (subjectLine) lines.push(subjectLine);

  const params = block.payload?.params;
  const paramsText = formatParamsTooltip(params);
  if (paramsText) {
    lines.push(paramsText);
  } else if (block.body) {
    lines.push(block.body);
  }

  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean))).join('\n\n');
}

export function SessionConfirmationPrompt({ block, exiting = false }: SessionConfirmationPromptProps) {
  const [submission, setSubmission] = useState<{ confirmId: string; action: ConfirmationAction } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [switchingMode, setSwitchingMode] = useState(false);
  const [mcpTarget, setMcpTarget] = useState<McpApprovalTarget | null>(null);
  const [missingKeys, setMissingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const currentSessionId = useStore((s: any) => s.currentSessionId) as string | null;
  const elicitation = useMemo(() => readElicitationForm(block), [block]);
  const [fieldValues, setFieldValues] = useState<ElicitationValues>(
    () => initialElicitationValues(elicitation),
  );
  useEffect(() => {
    setFieldValues(initialElicitationValues(elicitation));
    setMissingKeys(new Set());
  }, [elicitation]);

  const pending = block.status === 'pending' && !exiting;
  const submitting = submission?.confirmId === block.confirmId ? submission.action : null;
  const confirmLabel = block.actions?.confirmLabel || window.t?.('common.approve') || '同意';
  const rejectLabel = block.actions?.rejectLabel || window.t?.('common.reject') || '拒绝';
  const title = displayTitle(block);
  const subject = displaySubject(block, mcpTarget);
  const hasSubject = !!(subject.label || subject.detail);
  const tooltipText = useMemo(() => buildTooltipText(block, title, subject), [block, subject, title]);
  const tooltipId = `session-confirmation-tooltip-${block.confirmId}`;
  const canDisableAskForConversation = block.kind === 'tool_action_approval';
  // The server's own words explaining why it is asking. Shown in full above the
  // fields, since the summary row only has space for the connector and tool.
  const elicitationMessage = elicitation
    ? String(block.payload?.message || block.body || '')
    : '';
  const hasUnsupportedField = (elicitation?.unsupported.length || 0) > 0;
  const busy = !!submitting || switchingMode;
  // A form we cannot fill faithfully must not be sent as a half-answer.
  const confirmBlocked = busy || hasUnsupportedField;

  // Only a tool approval can be about an MCP tool, and the registry is only
  // worth reading when one is actually on screen.
  useEffect(() => {
    if (!pending || block.kind !== 'tool_action_approval') {
      setMcpTarget(null);
      return;
    }
    let cancelled = false;
    loadMcpApprovalIndex()
      .then((connectors) => {
        if (!cancelled) setMcpTarget(resolveMcpApprovalTarget(block, connectors));
      })
      .catch((err) => {
        // Without the registry the prompt simply offers the plain approve
        // button; it never guesses an identity it could not confirm.
        if (!cancelled) setMcpTarget(null);
        console.warn('[session-confirmation] mcp registry unavailable', err);
      });
    return () => { cancelled = true; };
  }, [block, pending]);

  const updateMenuPosition = useCallback(() => {
    const anchor = menuAnchorRef.current;
    if (!menuOpen || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = menuPanelRef.current?.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 6;
    const panelWidth = panelRect?.width || 160;
    const panelHeight = panelRect?.height || 36;

    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.right - panelWidth, window.innerWidth - panelWidth - viewportPadding),
    );
    const preferredTop = anchorRect.top - panelHeight - gap;
    const fallbackTop = Math.min(
      window.innerHeight - panelHeight - viewportPadding,
      anchorRect.bottom + gap,
    );
    const top = Math.max(viewportPadding, preferredTop < viewportPadding ? fallbackTop : preferredTop);

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      zIndex: 10000,
    });
  }, [menuOpen]);

  useLayoutEffect(() => {
    updateMenuPosition();
  }, [updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuAnchorRef.current?.contains(target)) return;
      if (menuPanelRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [block.confirmId]);

  const submit = useCallback(async (action: ConfirmationAction) => {
    if (!pending || submitting) return;
    if (action === 'confirmed' && elicitation) {
      // A required field left blank is the user's omission, not the server's
      // problem; say so rather than sending an answer the server will reject.
      const missing = missingRequiredFields(elicitation, fieldValues);
      if (missing.length > 0) {
        setMissingKeys(new Set(missing.map(field => field.key)));
        return;
      }
    }
    setMenuOpen(false);
    setSubmission({ confirmId: block.confirmId, action });
    // Only an approval carries answers; a rejection stays a bare decision.
    const value = elicitation && action === 'confirmed'
      ? collectElicitationValue(elicitation, fieldValues)
      : null;
    try {
      await lucFetch(`/api/confirm/${block.confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value ? { action, value } : { action }),
      });
    } catch (err) {
      setSubmission((current) => (
        current?.confirmId === block.confirmId ? null : current
      ));
      console.warn('[session-confirmation] submit failed', err);
    }
  }, [block.confirmId, elicitation, fieldValues, pending, submitting]);

  const notifyFailure = (fallback: string) => {
    window.dispatchEvent(new CustomEvent('luc-inline-notice', {
      detail: { text: fallback, type: 'error' },
    }));
  };

  /** Approve now and stop asking about this one tool for the rest of the session. */
  const approveForSession = useCallback(async () => {
    if (!mcpTarget || !currentSessionId || busy) return;
    setMenuOpen(false);
    setSwitchingMode(true);
    try {
      await grantForSession(currentSessionId, mcpTarget.capability);
      await submit('confirmed');
    } catch (err) {
      notifyFailure(textWithFallback('approval.mcpTool.grantFailed', '无法记住这次授权'));
      console.warn('[session-confirmation] session grant failed', err);
    } finally {
      setSwitchingMode(false);
    }
  }, [busy, currentSessionId, mcpTarget, submit]);

  /** Approve now and record the grant against the connector. */
  const approvePermanently = useCallback(async () => {
    if (!mcpTarget || busy) return;
    setMenuOpen(false);
    setSwitchingMode(true);
    try {
      await grantPermanently(mcpTarget);
      await submit('confirmed');
    } catch (err) {
      notifyFailure(textWithFallback('approval.mcpTool.grantFailed', '无法记住这次授权'));
      console.warn('[session-confirmation] permanent grant failed', err);
    } finally {
      setSwitchingMode(false);
    }
  }, [busy, mcpTarget, submit]);

  const disableAskForConversation = useCallback(async () => {
    if (!pending || submitting || switchingMode || !canDisableAskForConversation) return;
    setMenuOpen(false);
    setSwitchingMode(true);
    try {
      const res = await lucFetch('/api/session-permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'operate', currentSessionOnly: true }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'failed to switch current session permission mode');
      }
      window.dispatchEvent(new CustomEvent('luc-plan-mode', {
        detail: { enabled: false, mode: data?.mode || 'operate' },
      }));
      await submit('confirmed');
    } catch (err) {
      notifyFailure(textWithFallback('input.accessModeLocked', '当前无法更改权限模式'));
      console.warn('[session-confirmation] disable ask for conversation failed', err);
    } finally {
      setSwitchingMode(false);
    }
  }, [canDisableAskForConversation, pending, submit, submitting, switchingMode]);

  const menu = menuOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        className={styles['session-confirmation-menu']}
        ref={menuPanelRef}
        role="menu"
        style={menuStyle}
      >
        {mcpTarget && currentSessionId && (
          <button
            type="button"
            role="menuitem"
            className={styles['session-confirmation-menu-item']}
            data-testid="mcp-approve-session"
            onClick={approveForSession}
          >
            {textWithFallback('approval.mcpTool.allowForSession', '本会话此工具不再询问')}
          </button>
        )}
        {/* A server-declared destructive tool gets no permanent grant. The
            engine refuses to honour one anyway, so offering it would promise
            something that does not happen. */}
        {mcpTarget && !mcpTarget.destructive && (
          <button
            type="button"
            role="menuitem"
            className={styles['session-confirmation-menu-item']}
            data-testid="mcp-approve-always"
            onClick={approvePermanently}
          >
            {textWithFallback('approval.mcpTool.allowAlways', '始终允许此工具')}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={styles['session-confirmation-menu-item']}
          onClick={disableAskForConversation}
        >
          {textWithFallback('input.noAskThisConversation', '本对话不再询问')}
        </button>
      </div>,
      document.body,
    )
    : null;

  return (
    <div
      className={`${styles['session-confirmation-prompt']} ${exiting ? styles['session-confirmation-prompt-exiting'] : ''}`}
      data-confirm-id={block.confirmId}
      data-status={block.status}
      // A destructive tool is styled as the danger it is, whatever severity the
      // generic approval path assigned.
      data-severity={mcpTarget?.destructive ? 'danger' : (block.severity || 'normal')}
    >
      <Tooltip
        id={tooltipId}
        content={tooltipText}
        disabled={!tooltipText}
        placement="top"
        align="start"
        variant="panel"
      >
        {({ ref, ...tooltipProps }) => (
          <div
            className={styles['session-confirmation-body']}
            ref={(node) => ref(node)}
            data-testid="session-confirmation-summary"
            tabIndex={0}
            {...tooltipProps}
          >
            <div className={styles['session-confirmation-title']}>{title}</div>
            {hasSubject && (
              <div className={styles['session-confirmation-subject']}>
                {subject.label && <span className={styles['session-confirmation-subject-label']}>{subject.label}</span>}
                {subject.detail && <span className={styles['session-confirmation-subject-detail']}>{subject.detail}</span>}
              </div>
            )}
          </div>
        )}
      </Tooltip>
      {pending && elicitation && (
        <ElicitationForm
          form={elicitation}
          values={fieldValues}
          message={elicitationMessage}
          busy={busy}
          missingKeys={missingKeys}
          onChange={(key, value) => {
            setFieldValues((current) => ({ ...current, [key]: value }));
            setMissingKeys((current) => {
              if (!current.has(key)) return current;
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }}
        />
      )}
      {pending ? (
        <div className={styles['session-confirmation-actions']}>
          <button
            type="button"
            className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-reject']}`}
            onClick={() => submit('rejected')}
            disabled={busy}
          >
            {rejectLabel}
          </button>
          {canDisableAskForConversation ? (
            <div className={styles['session-confirmation-confirm-wrap']} ref={menuAnchorRef}>
              <div className={styles['session-confirmation-split']}>
                <button
                  type="button"
                  className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']} ${styles['session-confirmation-split-main']}`}
                  onClick={() => submit('confirmed')}
                  disabled={busy}
                >
                  {confirmLabel}
                </button>
                <button
                  type="button"
                  className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']} ${styles['session-confirmation-menu-trigger']}`}
                  aria-label={textWithFallback('input.confirmMoreOptions', '更多确认选项')}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  disabled={busy}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>
              {menu}
            </div>
          ) : (
            <button
              type="button"
              className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']}`}
              onClick={() => submit('confirmed')}
              disabled={confirmBlocked}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      ) : (
        <div className={styles['session-confirmation-resolved']}>
          {block.status === 'confirmed'
            ? (window.t?.('common.approved') || '已同意')
            : (window.t?.('common.rejected') || '已拒绝')}
        </div>
      )}
    </div>
  );
}
