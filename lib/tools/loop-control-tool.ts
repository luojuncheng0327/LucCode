/**
 * loop-control-tool.ts — 循环的模型侧控制面
 *
 * 仅在会话存在活跃循环时可用（execute 层硬闸）。schedule 设置单槽兜底闹钟；
 * complete 宣告循环目标达成并收尾。后台工作完成会自动唤醒会话，因此闹钟
 * 只用于系统观测不到的外部状态轮询与防挂死的长兜底。
 * ctx 的 sessionPath（桌面/桥接轮内均可得）由控制器解析归位到循环键。
 */
import { Type, StringEnum } from "../pi-sdk/index.ts";
import { getToolSessionPath } from "./tool-session.ts";
import { t } from "../i18n.ts";

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

/**
 * @param {{ getLoopController: () => any }} opts
 */
export function createLoopControlTool({ getLoopController }) {
  return {
    name: "loop_control",
    label: "Loop Control",
    description:
      "Control this session's active recurring loop (started with /loop). Only usable while a loop is active; "
      + "calls outside an active loop fail. action=schedule sets the single fallback alarm that wakes this session "
      + "after delay_seconds — background work completion wakes the session automatically, so never schedule alarms "
      + "to poll it; alarms are for external state the system cannot observe, and for long hang-protection fallbacks. "
      + "A new schedule replaces the previous alarm. action=complete declares the loop task achieved and ends the loop.",
    parameters: Type.Object({
      action: StringEnum(["schedule", "complete"], {
        description: "schedule: set the fallback wakeup alarm. complete: end the loop because its goal is achieved.",
      }),
      delay_seconds: Type.Optional(Type.Number({
        description: "schedule only, required: seconds until the wakeup fires. Clamped to the loop's minimum; long fallbacks (>= 20 min) required while background work is live.",
      })),
      reason: Type.Optional(Type.String({
        description: "schedule: context shown back to you when the wakeup fires. complete: short completion summary.",
      })),
    }),
    sessionPermission: {
      resolveInvocation: () => ({
        action: "control",
        kind: "routine",
        capability: "loop_control.control",
      }),
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const controller = getLoopController();
      if (!controller) return text(t("tool.loopControl.serviceUnavailable"));
      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) return text(t("tool.loopControl.noActiveSession"));
      const loop = controller.toolStatus(sessionPath);
      if (!loop || (loop.status !== "running" && loop.status !== "paused")) {
        return text(t("tool.loopControl.noActiveLoop"));
      }
      try {
        if (params.action === "schedule") {
          if (typeof params.delay_seconds !== "number") {
            return text(t("tool.loopControl.delayRequired"));
          }
          const r = controller.toolSchedule(sessionPath, params.delay_seconds, params.reason || "");
          return text(t("tool.loopControl.scheduled", {
            seconds: r.effectiveDelaySec,
            wakeAt: new Date(r.wakeAt).toISOString(),
          }));
        }
        await controller.toolComplete(sessionPath, params.reason || "");
        return text(t("tool.loopControl.completed"));
      } catch (err: any) {
        // 教育性拒绝（如带活跃后台任务的短闹钟）以工具结果返回，不抛栈
        return text(err?.message || String(err));
      }
    },
  };
}
