/**
 * 把毫秒时长格式化成「Xs」或「XmYs」。负数 clamp 到 0（防时钟偏差导致 now < startedAt）。
 * 统一时长口径，供 WorkflowCard / ActivityPanel 等显示运行时长，避免各处内联重复。
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec >= 60) {
    return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
  }
  return `${totalSec}s`;
}
