import { useCallback, useEffect, useState } from 'react';
import type { CrashFallbackNotice, TrainUpdateAvailable, TrainUpdateStatus } from '../types';

/**
 * 列车更新（OTA）状态 hook——表盘（左下角贴纸 + 设置页关于 tab）唯一的数据源。
 *
 * 对外状态遵循以下界面契约：
 * 1. 默认永远是"热更新"语境；壳更新只在 `minShellBlocked` 时才需要界面
 *    另作处理（贴纸/设置页各自决定怎么呈现，hook 本身只如实转发这个布尔值）。
 * 2. 对外只暴露产品版本（`currentVersion`/`available.version`），从不
 *    转发 train 号。
 * 3. `applyNow` 是唯一会真正下载字节的入口，且只由调用方（用户点击）
 *    触发——hook 挂载时只读一次已缓存的状态，绝不自作主张地检查或下载。
 * 4. `lastError`/`lastCheckedAt` 如实转发主进程记的账，界面据此判断
 *    "有新版本"/"上次检查失败"/"已是最新"三态，hook 不替 UI 做这个判断。
 *
 * 旧版本这个 hook 曾经把数据映射成 `AutoUpdateState`（电子更新器的状态
 * 形状）方便复用 `AutoUpdateStatus` 组件——"staged"/"downloaded" 就是那个
 * 年代遗留的适配层。新表盘不再有"暂存待应用"这个中间态（点击就是下载+应用
 * 一条龙），这层适配已经没有存在的理由，整块删除。
 */

export type TrainUpdatePhase = 'idle' | 'checking' | 'downloading' | 'applying';

export interface TrainUpdateProgressState {
  receivedBytes: number;
  totalBytes: number;
}

export interface UseTrainUpdateStateResult {
  /** 已激活内容的产品版本（单一源，见 desktop/main.cjs 的 getCurrentContentVersion）。 */
  currentVersion: string;
  /** 最近一次检查发现的、尚未下载的一班车；没有可用更新时为 null。 */
  available: { version: string } | null;
  /** 有新列车，但当前壳版本太旧收不到——贴纸/设置页据此切换成"需更新应用本体"文案。 */
  minShellBlocked: boolean;
  /** 最近一次检查或应用留下的错误消息；成功的检查/应用会清空它。 */
  lastError: string | null;
  /** 最近一次检查完成的时间（ISO 字符串），用于"已是最新"文案里的时间戳。 */
  lastCheckedAt: string | null;
  /**
   * 货架清单来源治理留痕，原样转发自 IPC（不在 hook 里做判断，由 UI 决定
   * 怎么呈现——见 desktop/src/shared/artifact-ota.cjs 的 "dual-source
   * manifest fetch" 设计注释）。`manifestSource` 是最近一次成功检查采信
   * 的清单来自产地还是镜像；`manifestReleasedAt` 是该清单自述的签发时间；
   * `originUnreachable` 标记产地这一轮是否没能参与比较。
   */
  manifestSource: 'origin' | 'mirror' | null;
  manifestReleasedAt: string | null;
  originUnreachable: boolean;
  /** 当前所处阶段：idle（无事发生）/checking（手动检查中）/downloading/applying。 */
  phase: TrainUpdatePhase;
  /** apply-now 下载阶段的字节进度；不在下载中或没收到过进度事件时为 null。 */
  progress: TrainUpdateProgressState | null;
  /** 崩溃回退的一次性提示；已 ack 或从未发生过时为 null。 */
  fallbackNotice: CrashFallbackNotice | null;
  /** 触发一轮手动 OTA 检查（只读清单+验签+过闸门，绝不下载）。 */
  checkNow(): Promise<void>;
  /** 唯一会下载字节的入口：下载→验签→激活→重启 server→重载窗口一条龙。 */
  applyNow(): Promise<{ ok: boolean; error?: string } | undefined>;
  /** 用户确认崩溃回退提示后调用：清空主进程状态并让卡片消失。 */
  ackFallbackNotice(): Promise<void>;
}

interface StatusSnapshot {
  currentVersion: string;
  available: { version: string } | null;
  minShellBlocked: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
  manifestSource: 'origin' | 'mirror' | null;
  manifestReleasedAt: string | null;
  originUnreachable: boolean;
  fallbackNotice: CrashFallbackNotice | null;
}

const IDLE_SNAPSHOT: StatusSnapshot = {
  currentVersion: '',
  available: null,
  minShellBlocked: false,
  lastError: null,
  lastCheckedAt: null,
  manifestSource: null,
  manifestReleasedAt: null,
  originUnreachable: false,
  fallbackNotice: null,
};

function projectAvailable(available: TrainUpdateAvailable | null | undefined): { version: string } | null {
  return available ? { version: available.version } : null;
}

function snapshotFromStatus(status: TrainUpdateStatus): StatusSnapshot {
  return {
    currentVersion: status.currentVersion || '',
    available: projectAvailable(status.available),
    minShellBlocked: status.minShellBlocked === true,
    lastError: status.lastError ?? null,
    lastCheckedAt: status.lastCheckedAt ?? null,
    manifestSource: status.manifestSource ?? null,
    manifestReleasedAt: status.manifestReleasedAt ?? null,
    originUnreachable: status.originUnreachable === true,
    fallbackNotice: status.fallbackNotice ?? null,
  };
}

async function queryStatus(): Promise<TrainUpdateStatus | null> {
  try {
    return (await window.luc?.trainUpdateStatus?.()) ?? null;
  } catch {
    return null;
  }
}

export function useTrainUpdateState(): UseTrainUpdateStateResult {
  const [snapshot, setSnapshot] = useState<StatusSnapshot>(IDLE_SNAPSHOT);
  const [phase, setPhase] = useState<TrainUpdatePhase>('idle');
  const [progress, setProgress] = useState<TrainUpdateProgressState | null>(null);

  // 挂载时只读一次已缓存的状态——不触发检查、更不触发下载。
  useEffect(() => {
    let alive = true;
    queryStatus().then((status) => {
      if (!alive || !status) return;
      setSnapshot(snapshotFromStatus(status));
    });
    return () => { alive = false; };
  }, []);

  // 后台自动检查（checkOnce）发现新列车时的实时广播：不用等用户下次手动
  // 检查或重新挂载组件，贴纸/设置页立刻点亮。
  useEffect(() => {
    const unsubscribe = window.luc?.onTrainUpdateAvailable?.((payload) => {
      setSnapshot((s) => ({
        ...s,
        available: { version: payload.version },
        minShellBlocked: payload.minShellBlocked === true,
        lastError: null,
      }));
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  // apply-now 下载/验证/激活阶段的进度推送，只发给发起这次调用的窗口。
  useEffect(() => {
    const unsubscribe = window.luc?.onTrainUpdateProgress?.((p) => {
      // downloading 与 verifying 都算"下载中"（进度条停在已到达的累计位置，
      // 不因为验签间隙而闪成"应用中"）；只有 activating 才是真的 applying。
      setPhase(p.phase === 'activating' ? 'applying' : 'downloading');
      // overallReceivedBytes/overallTotalBytes 是 ota-core.cjs 新增字段，
      // 跨 server+renderer 两个工件累计，让进度条合成一条连续 0→100，不再
      // 在 renderer 工件开始下载时归零重跑一遍。这里做存在性回退到单工件
      // 字段——不是无主 fallback，是声明式的壳版本偏斜兼容：renderer 由
      // 列车热更走在前面，主进程（IPC 事件的真正来源）可能还没升级到会
      // 发这两个新字段的版本，此时唯一正确的兼容动作就是退回旧的单工件
      // 语义，而不是让进度条整体读不到数据。
      const receivedBytes = p.overallReceivedBytes ?? p.receivedBytes;
      const totalBytes = p.overallTotalBytes ?? p.totalBytes;
      setProgress({ receivedBytes, totalBytes });
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  // 崩溃回退运行时触发（renderer 崩溃重试路径）的实时广播——冷启动路径
  // 走上面 queryStatus() 挂载时拉到的 status.fallbackNotice，这里只覆盖
  // "窗口已经在跑时才发生"的那一种。
  useEffect(() => {
    const unsubscribe = window.luc?.onTrainFallbackNotice?.((payload) => {
      setSnapshot((s) => ({ ...s, fallbackNotice: payload }));
    });
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, []);

  const checkNow = useCallback(async () => {
    setPhase('checking');
    try {
      const result = await window.luc?.trainUpdateCheck?.();
      if (result?.outcome === 'error') {
        setSnapshot((s) => ({ ...s, lastError: result.error || null }));
        return;
      }
      const fresh = await queryStatus();
      if (fresh) {
        setSnapshot(snapshotFromStatus(fresh));
      }
    } catch (err) {
      setSnapshot((s) => ({ ...s, lastError: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPhase('idle');
    }
  }, []);

  const applyNow = useCallback(async () => {
    // 乐观置位：点击即视觉反馈"开始动了"，第一条 progress 事件到达前
    // 也不该显示成 idle。真实进度由 onTrainUpdateProgress 接管。
    setPhase('downloading');
    setProgress(null);
    try {
      const result = await window.luc?.trainUpdateApply?.();
      if (result && !result.ok) {
        setSnapshot((s) => ({ ...s, lastError: result.error || null }));
      } else if (result?.ok && (result as { alreadyCurrent?: boolean }).alreadyCurrent) {
        // 主进程发现本机其实已在最新列车上：不会有窗口重载发生，主动重拉
        // 一次状态，把陈旧的"有新版本"清掉、回到"已是最新"。
        const status = await queryStatus();
        if (status) setSnapshot(snapshotFromStatus(status));
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setSnapshot((s) => ({ ...s, lastError: error }));
      return { ok: false, error };
    } finally {
      // 成功路径上主进程会重载所有窗口，这里的复位形同虚设（组件即将
      // 随页面重载一起消失）；失败路径上则是把 UI 从"进行中"带回可再次
      // 交互的状态，让用户看到 lastError 并能重试。
      setPhase('idle');
      setProgress(null);
    }
  }, []);

  const ackFallbackNotice = useCallback(async () => {
    // 乐观清空：卡片立即消失，不等 IPC 往返——即便 ack 请求失败，下次挂载
    // 顶多重新拉到同一条通知，不是数据丢失，不值得为此阻塞交互。
    setSnapshot((s) => ({ ...s, fallbackNotice: null }));
    try {
      await window.luc?.ackTrainFallbackNotice?.();
    } catch {
      // best-effort：主进程状态清空失败不影响本次会话里卡片已经消失的事实。
    }
  }, []);

  return {
    ...snapshot,
    phase,
    progress,
    checkNow,
    applyNow,
    ackFallbackNotice,
  };
}
