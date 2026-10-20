import { useEffect, useState } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import { useTrainUpdateState } from '../../hooks/use-train-update-state';
import type { TrainUpdatePhase, TrainUpdateProgressState } from '../../hooks/use-train-update-state';
import type { CrashFallbackNotice, SessionMetaRecoveryStatus } from '../../types';
import styles from './SidebarNoticeSlot.module.css';

/**
 * 左下角更新贴纸默认使用“内容更新”语境；壳更新只在
 * `minShellBlocked`（不更新壳收不到新列车）时才占用这张卡片。壳更新器
 * 自己下载好了这件事本身不再触发卡片——那安静躺在设置页，不来打扰这里。
 * 两种触发态互斥：`minShellBlocked` 为真时切到"需更新应用本体"形态
 * （点击走既有 autoUpdateInstall 流程，这是唯一允许从这张卡片走壳安装的
 * 情形），否则只要 `available` 非空就是默认的列车形态（点击 = applyNow，
 * 下载→验签→激活→重载一条龙，进行中的阶段/进度直接显示在卡面上）。
 *
 * 两种触发态的叉号语义不同：
 * - blocked（需更新应用本体）= "本 session 安静，下次启动重新出现" ——
 *   用组件内存状态（不落 localStorage），进程重启即天然重置。
 * - train（默认热更新）= 沿用既有 dismissed-key 机制（按 "version:X" 存
 *   localStorage），出现新版本自然重新弹出。
 *
 * 第三种触发态 fallback（崩溃回退提示）优先级最高——它不是"有没有更新"这
 * 类可选提示，是"已经发生的事情，用户必须被告知"：连续启动/加载失败触发
 * 自动回退到上一版本后，用户此前完全无感知（只写日志），这是明确
 * 禁止的静默降级。它的叉号语义也不同于前两种：一次性 ack（关掉即消费，
 * 状态归属在主进程内存，见 desktop/main.cjs 的 `_crashFallbackNotice`），
 * 不用 dismissed-key，也不用组件内存——数据源是 hook 里的
 * `fallbackNotice`，本组件只负责渲染与转发 ack 动作。
 *
 * 第四种触发态 meta-recovery（session 元数据待恢复）优先级次于 fallback、
 * 高于 blocked/train——同样是"已经发生的事情"（session-meta 损坏/隔离），
 * 但不像 fallback 那样有主进程一次性 ack 通道。数据源是 store.metaRecovery
 * （loadSessions() 从 /api/health 的 sessionStore 附块写入），没有可点击的
 * 动作——点击卡面无事发生，只能叉掉。
 *
 * 它的叉号语义是"按劣化签名永久关闭，出现新劣化时重现一次"：比照 train 的
 * dismissed-key 落 localStorage，只是键值不是版本号而是当前劣化集合的签名。
 * 之所以不能用 blocked 那种会话内存态：这条提示的信号来自持久化账本里被判
 * 死刑的旧文件全集，它永不自愈，于是"下次启动重新出现"意味着用户每次开应用
 * 都被同一张、且没有任何可执行动作的警示卡拦一次——那是对注意力的无意义
 * 消耗。反过来，新出现的劣化是事件而不是稳态，签名一变卡片自然重现一次，
 * 该打扰的时候仍然打扰。关掉之后它是从四态候选里退出、把这个卡槽让给
 * blocked/train，而不是把卡槽本身清空——否则一次永久关闭会连带永久压掉
 * 更新贴纸和"必须更新壳"的阻塞卡。
 */
const DISMISSED_TRAIN_UPDATE_KEY = 'luc-sidebar-train-update-dismissed-key';
const DISMISSED_META_RECOVERY_KEY = 'luc-sidebar-meta-recovery-dismissed-key';

type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface SidebarUpdateNoticeCardProps {
  available: { version: string } | null;
  minShellBlocked: boolean;
  phase: TrainUpdatePhase;
  progress: TrainUpdateProgressState | null;
  fallbackNotice?: CrashFallbackNotice | null;
  metaRecovery?: SessionMetaRecoveryStatus | null;
  onInstallShell?: () => void | Promise<unknown>;
  onApplyTrain?: () => void | Promise<unknown>;
  onAckFallback?: () => void | Promise<unknown>;
  storage?: NoticeStorage | null;
}

function safeStorage(): NoticeStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDismissedKey(storage: NoticeStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeDismissedKey(storage: NoticeStorage | null, storageKey: string, value: string): void {
  try {
    storage?.setItem(storageKey, value);
  } catch {
    // Ignore storage failures; the in-memory dismissed state still hides the card for this mount.
  }
}

function trainNoticeKey(available: { version: string } | null): string | null {
  return available ? `version:${available.version}` : null;
}

/**
 * 劣化集合的签名：排序后拼接，让"同一组原因"无论服务端返回顺序如何都得到
 * 同一个键，只有集合真的变了（多一条/换一条原因）才产生新键。degraded 为真
 * 但 reasons 为空时退回常量 'degraded'——空字符串会被"已存键 === 当前签名"
 * 的比较读成"没关过"，那样卡片会立刻回来。reasons 来自 /api/health 的原样
 * 转发（没有做形状校验），所以这里按运行时真相判断是不是数组，不信类型。
 * 两段各自 encodeURIComponent 之后再拼：detail 里本来就可能出现路径或错误
 * 文本，含 `:` 或 `|` 时不做转义会让不同的集合撞出同一个签名。
 */
function metaRecoverySignature(metaRecovery: SessionMetaRecoveryStatus | null | undefined): string | null {
  if (!metaRecovery?.degraded) return null;
  const parts = (Array.isArray(metaRecovery.reasons) ? metaRecovery.reasons : [])
    .map((r) => `${encodeURIComponent(r?.kind ?? '')}:${encodeURIComponent(r?.detail ?? '')}`)
    .sort();
  return parts.join('|') || 'degraded';
}

function percentOf(progress: TrainUpdateProgressState | null): number {
  if (!progress || !progress.totalBytes) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100)));
}

function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// fallback 形态没有可点击的动作（不像 train/blocked 那样点卡片即触发下载/
// 安装），复用 .refreshIcon 的位置与样式 token，只换一个语义正确的图标
// （提醒，不是刷新），避免误导用户以为点击卡面能做什么。
function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  );
}

interface StickerContent {
  kind: 'blocked' | 'train' | 'fallback' | 'meta-recovery';
  title: string;
  /** 内容版本号小字：显示已激活内容版本，不显示壳版本或 train 号。 */
  subtitle: string | null;
}

/**
 * 四态选择，fallbackNotice 优先级最高（已经发生的事必须先说清楚），其次
 * meta-recovery（同样是"已经发生的事情"，但没有 fallback 那样的主进程 ack
 * 通道），再次 minShellBlocked（唯一"壳"相关的触发源，不再看壳自动更新器
 * 自己的 'downloaded' 状态），最后才是默认的 train 形态。纯函数，独立可测。
 */
function resolveStickerContent({
  available,
  minShellBlocked,
  phase,
  progress,
  fallbackNotice,
  metaRecovery,
  translate,
}: Pick<SidebarUpdateNoticeCardProps, 'available' | 'minShellBlocked' | 'phase' | 'progress' | 'fallbackNotice' | 'metaRecovery'> & {
  translate: Window['t'];
}): StickerContent | null {
  if (fallbackNotice) {
    return {
      kind: 'fallback',
      title: translate('settings.about.fallbackStickerTitle', {
        fromVersion: fallbackNotice.fromVersion ?? '?',
        toVersion: fallbackNotice.toVersion ?? '?',
      }),
      subtitle: null,
    };
  }
  if (metaRecovery?.degraded) {
    return {
      kind: 'meta-recovery',
      title: translate('sidebar.metaRecoveryNoticeTitle'),
      subtitle: translate('sidebar.metaRecoveryNoticeBody'),
    };
  }
  if (minShellBlocked) {
    return {
      kind: 'blocked',
      title: translate('settings.about.shellStickerTitleBlocking'),
      subtitle: available ? `v${available.version}` : null,
    };
  }
  if (!available) return null;
  if (phase === 'downloading') {
    return {
      kind: 'train',
      title: translate('settings.about.trainStickerDownloading', { percent: percentOf(progress) }),
      subtitle: `v${available.version}`,
    };
  }
  if (phase === 'applying') {
    return {
      kind: 'train',
      title: translate('settings.about.trainStickerApplying'),
      subtitle: `v${available.version}`,
    };
  }
  return {
    kind: 'train',
    title: translate('settings.about.trainStickerTitle'),
    subtitle: `v${available.version}`,
  };
}

export function SidebarUpdateNoticeCard({
  available,
  minShellBlocked,
  phase,
  progress,
  fallbackNotice,
  metaRecovery,
  onInstallShell,
  onApplyTrain,
  onAckFallback,
  storage,
}: SidebarUpdateNoticeCardProps) {
  const { t } = useI18n();
  const resolvedStorage = storage === undefined ? safeStorage() : storage;

  // blocked 形态的叉号状态只活在组件内存里（不落 localStorage）：进程
  // 重启 = 组件重新挂载 = 天然重置为"未叉过"，这正是"下次启动重新出现"的实现。
  const [blockedDismissed, setBlockedDismissed] = useState(false);

  // meta-recovery 的叉号比照 train 落 localStorage，键值是当前劣化集合的签名：
  // 关掉的是"这一组劣化"，不是"这一次挂载"。签名变了（新劣化）与已存键不等，
  // 卡片自然重现一次。
  const metaRecoveryKey = metaRecoverySignature(metaRecovery);
  const [metaRecoveryDismissedKey, setMetaRecoveryDismissedKey] = useState<string | null>(
    () => readDismissedKey(resolvedStorage, DISMISSED_META_RECOVERY_KEY),
  );
  useEffect(() => {
    setMetaRecoveryDismissedKey(readDismissedKey(resolvedStorage, DISMISSED_META_RECOVERY_KEY));
  }, [metaRecoveryKey, resolvedStorage]);

  const trainKey = trainNoticeKey(available);
  const [trainDismissedKey, setTrainDismissedKey] = useState<string | null>(
    () => readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY),
  );
  useEffect(() => {
    setTrainDismissedKey(readDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY));
  }, [trainKey, resolvedStorage]);

  // 已关掉的劣化态在四态选择之前就退出候选，而不是选中之后再把整张卡片
  // return 掉：通知位只有一张卡，meta-recovery 又排在 blocked/train 前面，
  // 选中后再隐藏等于让一次永久关闭把更新贴纸和"必须更新壳"的阻塞卡一起
  // 永久压掉。让位给下一个候选才是这次关闭该有的射程。
  const activeMetaRecovery = metaRecoveryKey && metaRecoveryDismissedKey === metaRecoveryKey ? null : metaRecovery;

  // Resolve translated content during every subscribed render. useI18n owns
  // the locale subscription, so startup loading and runtime language changes
  // cannot leave a module-level or memoized translation frozen in the card.
  const content = resolveStickerContent({
    available,
    minShellBlocked,
    phase,
    progress,
    fallbackNotice,
    metaRecovery: activeMetaRecovery,
    translate: t,
  });

  if (!content) return null;
  // blocked 关掉后是清空卡槽而不是让位给 train：这是有意例外，不是漏改。
  // 壳被卡住时 train 卡提供的"点击应用更新"是一个执行不了的动作（壳过旧
  // 装不上新列车），让位等于给用户一个假按钮；清空比让位诚实。
  if (content.kind === 'blocked' && blockedDismissed) return null;
  if (content.kind === 'train' && trainKey && trainDismissedKey === trainKey) return null;

  const dismiss = () => {
    if (content.kind === 'fallback') {
      // 一次性 ack：状态归属在主进程内存（见 use-train-update-state 的
      // ackFallbackNotice），不是本组件的本地 dismissed 状态——组件卸载/
      // 重挂载不应该让已 ack 的通知重新出现。
      void onAckFallback?.();
      return;
    }
    if (content.kind === 'meta-recovery') {
      if (metaRecoveryKey) {
        writeDismissedKey(resolvedStorage, DISMISSED_META_RECOVERY_KEY, metaRecoveryKey);
        setMetaRecoveryDismissedKey(metaRecoveryKey);
      }
      return;
    }
    if (content.kind === 'blocked') {
      setBlockedDismissed(true);
      return;
    }
    if (trainKey) {
      writeDismissedKey(resolvedStorage, DISMISSED_TRAIN_UPDATE_KEY, trainKey);
      setTrainDismissedKey(trainKey);
    }
  };

  const handleAction = () => {
    if (content.kind === 'fallback' || content.kind === 'meta-recovery') return; // 没有可执行的动作，点卡面无事发生
    if (content.kind === 'blocked') {
      void onInstallShell?.();
    } else {
      void onApplyTrain?.();
    }
  };

  return (
    <div className={styles.slot}>
      <section className={styles.card} role="status" aria-live="polite">
        <button type="button" className={styles.cardButton} onClick={handleAction}>
          <span className={styles.refreshIcon}>
            {content.kind === 'fallback' || content.kind === 'meta-recovery' ? <AlertIcon /> : <RefreshIcon />}
          </span>
          <span className={styles.textBlock}>
            <span className={styles.title}>{content.title}</span>
            {content.subtitle && <span className={styles.subtitle}>{content.subtitle}</span>}
          </span>
        </button>
        <button
          type="button"
          className={styles.closeButton}
          aria-label={content.kind === 'fallback' ? t('settings.about.fallbackStickerAckLabel') : t('window.close')}
          onClick={dismiss}
        >
          <CloseIcon />
        </button>
      </section>
    </div>
  );
}

export function SidebarNoticeSlot() {
  const { available, minShellBlocked, phase, progress, fallbackNotice, applyNow, ackFallbackNotice } = useTrainUpdateState();
  const metaRecovery = useStore((s) => s.metaRecovery);

  return (
    <SidebarUpdateNoticeCard
      available={available}
      minShellBlocked={minShellBlocked}
      phase={phase}
      progress={progress}
      fallbackNotice={fallbackNotice}
      metaRecovery={metaRecovery}
      onInstallShell={() => window.luc?.autoUpdateInstall?.()}
      onApplyTrain={() => applyNow()}
      onAckFallback={() => ackFallbackNotice()}
    />
  );
}
