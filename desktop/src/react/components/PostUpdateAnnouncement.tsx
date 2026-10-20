/**
 * 升级后首启公告：主进程在打包环境下检测到版本变化时，
 * 首次启动返回 pending 公告——(书签, 当前] 区间的随包 release digest 史册
 * 切片，按版本分组、新→旧。跳一版看到一节，跳二十版看到二十节的合订本；
 * 无书签的老用户只看到当前版本一节。用户确认后写回 last-seen-version
 * （书签唯一状态归属），不再弹。组件一次性：挂载时查询，确认即关闭。
 */
import { useEffect, useState } from 'react';
import type { ReleaseDigest } from '../types';
import { NoticeDialog } from '../ui';
import { useI18n } from '../hooks/use-i18n';
import { digestLocale, digestText, kindLabel } from './shared/release-digest-text';
import styles from './AutoUpdateStatus.module.css';

interface PendingAnnouncement {
  version: string;
  entries: ReleaseDigest[];
}

/**
 * 一个版本的 digest 渲染块（摘要 + items 列表）。导出给设置页更新历史视图
 * （desktop/src/react/settings/tabs/AboutTab.tsx）复用——历史视图
 * 跟首启一次性公告都是"渲染一份 ReleaseDigest"，没有理由维护两套 JSX。
 */
export function DigestSection({ digest, showHeading }: { digest: ReleaseDigest; showHeading: boolean }) {
  const locale = digestLocale();
  return (
    <section>
      {showHeading && <h3 className={styles.digestVersionHeading}>{`v${digest.version}`}</h3>}
      <p>{digestText(digest.summary, locale)}</p>
      <div className={styles.digestList}>
        {digest.items.map((item, index) => (
          <article key={item.id || `${item.kind}-${index}`} className={styles.digestItem}>
            <div className={styles.digestItemMeta}>
              <span className={styles.digestKind}>{kindLabel(item.kind)}</span>
            </div>
            <h3 className={styles.digestItemTitle}>{digestText(item.title, locale)}</h3>
            <p className={styles.digestItemSummary}>{digestText(item.summary, locale)}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function PostUpdateAnnouncement() {
  const { t } = useI18n();
  const [announcement, setAnnouncement] = useState<PendingAnnouncement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.luc?.getPendingAnnouncement?.().then((pending) => {
      if (cancelled || !pending) return;
      setAnnouncement(pending);
      setOpen(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!announcement) return null;

  const { version, entries } = announcement;

  const handleConfirm = () => {
    setOpen(false);
    void window.luc?.ackAnnouncement?.();
  };

  return (
    <NoticeDialog
      open={open}
      scope="window"
      title={t('announcement.title', { version })}
      confirmLabel={t('announcement.confirm')}
      onConfirm={handleConfirm}
    >
      {entries.length > 0 ? (
        entries.map((entry) => (
          <DigestSection key={entry.version} digest={entry} showHeading={entries.length > 1} />
        ))
      ) : (
        <p>{t('announcement.fallbackBody', { version })}</p>
      )}
    </NoticeDialog>
  );
}
