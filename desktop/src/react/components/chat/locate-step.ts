export type LocateStep = 'scroll' | 'load-more' | 'wait' | 'wait-element' | 'refresh' | 'give-up';

export interface LocateStepInput {
  targetIndex: number;
  elementPresent: boolean;
  /** items 中是否存在 id === String(targetIndex) 的 message item */
  itemPresent: boolean;
  oldestId: string | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  /**
   * items 尾部向前找到的第一个数字（canonical）message id；
   * items 全是 live id（stream-* / client id，如新建会话）时为 null。
   */
  newestNumericId: number | null;
}

export function resolveLocateStep(input: LocateStepInput): LocateStep {
  if (input.elementPresent) return 'scroll';
  // items 有该消息但 DOM 未注册：可能是 commit 间隙，也可能永远不会注册
  // （折叠块内 / 渲染为 null）。消费方做有界等待后决定滚动或放弃。
  if (input.itemPresent) return 'wait-element';
  // canonical id 空间过期：find 接口返回的是文件序号，而本次运行新产生的
  // 消息在 items 里是 live id。目标比已知最新 canonical id 新、或 items
  // 里根本没有数字 id（新建会话）→ 让调用方 reconcile 重载后重试。
  if (input.newestNumericId === null || input.targetIndex > input.newestNumericId) return 'refresh';
  const oldest = Number(input.oldestId ?? NaN);
  if (!Number.isFinite(oldest)) return 'refresh'; // oldestId 是 live id：同属 id 空间过期
  if (input.targetIndex < oldest) {
    if (input.loadingMore) return 'wait';
    return input.hasMore ? 'load-more' : 'give-up';
  }
  return 'give-up'; // 在窗口内却无此消息：id 对应的消息前端不可渲染
}
