/**
 * SessionStatusCard — 右侧「本次对话」状态卡（可收纳）
 *
 * desk 卡限高后填充下方，显示当前对话的工作目录 / 模型 / 文件数。
 * 无当前对话时返回 null（welcome 态不显示）。
 */
import { type MouseEvent, useState } from 'react';
import { Collapse } from '@/ui';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { lucFetch } from '../../hooks/use-luc-fetch';
import styles from './SessionStatusCard.module.css';
import { workspaceDisplayName } from '../../../../../shared/workspace-history.ts';

const EMPTY_AUTHORIZED_FOLDERS: string[] = [];

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function FolderAddIcon() {
  return (
    <svg className={styles.folderIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12.0601 16.5V11.5" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 14H9.5" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 11V17C22 21 21 22 17 22H7C3 22 2 21 2 17V7C2 3 3 2 7 2H8.5C10 2 10.33 2.44 10.9 3.2L12.4 5.2C12.78 5.7 13 6 14 6H17C21 6 22 7 22 11Z" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" />
    </svg>
  );
}

export function SessionStatusCard() {
  const [collapsed, setCollapsed] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const deskBasePath = useStore((s) => s.deskBasePath);
  const deskWorkspaceMountId = useStore((s) => s.deskWorkspaceMountId);
  const deskWorkspaceLabel = useStore((s) => s.deskWorkspaceLabel);
  const currentModel = useStore((s) => s.currentModel);
  const sessionModel = useStore((s) => (
    sessionPath ? (sessionScopedValue(s, s.sessionModelsByPath, sessionPath) ?? null) : null
  ));
  const filesCount = useStore((s) => (
    sessionPath ? (sessionScopedValue(s, s.sessionRegistryFilesByPath, sessionPath)?.length ?? 0) : 0
  ));
  const authorizedFolders = useStore((s) => (
    sessionPath
      ? (sessionScopedValue(s, s.sessionAuthorizedFoldersByPath, sessionPath) ?? EMPTY_AUTHORIZED_FOLDERS)
      : EMPTY_AUTHORIZED_FOLDERS
  ));
  const setSessionAuthorizedFolders = useStore((s) => s.setSessionAuthorizedFolders);
  const addToast = useStore((s) => s.addToast);
  const t = window.t ?? ((k: string) => k);

  if (!sessionPath) return null;

  const modelId = sessionModel?.id || currentModel?.id || '—';
  const cwd = deskWorkspaceMountId
    ? (deskWorkspaceLabel || deskWorkspaceMountId)
    : (deskBasePath ? workspaceDisplayName(deskBasePath, '—') : '—');
  const cwdTitle = deskWorkspaceMountId ? cwd : (deskBasePath || undefined);
  const authorizedFolderTitle = authorizedFolders.length > 0 ? authorizedFolders.join('\n') : undefined;
  const authorizedFolderValue = authorizedFolders.length === 0
    ? '0'
    : authorizedFolders.length === 1
      ? workspaceDisplayName(authorizedFolders[0], authorizedFolders[0])
      : `${workspaceDisplayName(authorizedFolders[0], authorizedFolders[0])} +${authorizedFolders.length - 1}`;
  const canSelectAuthorizedFolder = typeof window.platform?.selectFolder === 'function';

  async function handleAddAuthorizedFolder(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (addingFolder) return;
    const currentSessionPath = sessionPath;
    if (!currentSessionPath) return;
    const folder = await window.platform?.selectFolder?.();
    if (!folder) return;
    setAddingFolder(true);
    try {
      const res = await lucFetch('/api/sessions/authorized-folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: currentSessionPath,
          action: 'add',
          folder,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || res.statusText || 'Failed to add folder');
      }
      setSessionAuthorizedFolders(currentSessionPath, Array.isArray(data.authorizedFolders) ? data.authorizedFolders : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast?.(message, 'error');
    } finally {
      setAddingFolder(false);
    }
  }

  return (
    <section className={`universal-card ${styles.card}`} aria-label={t('rightWorkspace.session.title')} data-collapsed={collapsed || undefined}>
      <div className={styles.header}>
        <button className={styles.headerToggle} type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          <span className={styles.title}>{t('rightWorkspace.session.title')}</span>
        </button>
        <div className={styles.headerActions}>
          {canSelectAuthorizedFolder && (
            <button
              className={styles.iconButton}
              type="button"
              onClick={handleAddAuthorizedFolder}
              disabled={addingFolder}
              aria-label={t('rightWorkspace.session.addAuthorizedFolder')}
              title={t('rightWorkspace.session.addAuthorizedFolder')}
            >
              <FolderAddIcon />
            </button>
          )}
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={t('rightWorkspace.session.title')}
            aria-expanded={!collapsed}
          >
            <Chevron open={!collapsed} />
          </button>
        </div>
      </div>
      <Collapse open={!collapsed}>
        <dl className={styles.body}>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.cwd')}</dt>
            <dd className={styles.value} title={cwdTitle}>{cwd}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.authorizedFolders')}</dt>
            <dd className={styles.value} title={authorizedFolderTitle}>{authorizedFolderValue}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.model')}</dt>
            <dd className={styles.value} title={modelId}>{modelId}</dd>
          </div>
          <div className={styles.row}>
            <dt className={styles.label}>{t('rightWorkspace.session.files')}</dt>
            <dd className={styles.value}>{filesCount}</dd>
          </div>
        </dl>
      </Collapse>
    </section>
  );
}
