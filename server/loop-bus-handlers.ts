/**
 * loop-bus-handlers.ts — 把会话 turn 生命周期事件桥接给循环控制器
 *
 * 控制器观测 turn 缝隙的唯一入口。桌面与桥接会话的 turn 事件都经同一总线
 * 转发（sessionPath 分别为桌面/桥接 jsonl 路径），控制器内部解析归位。
 * controller 用 getter 传入，服务重建后订阅仍指向新实例。
 */
export function registerLoopBusHandlers(bus, getController) {
  return bus.subscribe((event, sessionPath) => {
    if (!sessionPath || !event?.type) return;
    const controller = getController();
    if (!controller) return;
    try {
      if (event.type === "turn_start") {
        controller.onTurnStart(sessionPath);
      } else if (event.type === "message_end") {
        controller.onMessageEnd(sessionPath, event.message?.stopReason);
      } else if (event.type === "turn_end") {
        void controller.onTurnEnd(sessionPath, { aborted: event.aborted === true });
      }
    } catch {
      // 观测钩子不允许影响主流程
    }
  });
}
