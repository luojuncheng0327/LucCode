/**
 * loop-messages.ts — 循环相关注入消息的构造器
 *
 * 形状对齐后台结果通知消息：{ customType, content, display:false, details }。
 * turn 类消息（kickoff / wakeup）触发模型轮；notice 类只落记录不触发轮。
 * 桥接目标的投递层只取 content 字段作为外呼轮的输入文本。
 */
export const LOOP_TURN_MESSAGE_TYPE = "loop-turn";
export const LOOP_NOTICE_MESSAGE_TYPE = "loop-notice";

export function buildLoopKickoffMessage(loop) {
  const { maxTurns, maxConsecutiveFailures } = loop.limits;
  const content = [
    `<luc-loop kind="kickoff">`,
    `This session is now in recurring-loop mode.`,
    `Task: ${loop.prompt}`,
    ``,
    `Each loop turn: do the work or the check now. Then take EXACTLY one of:`,
    `1. Keep working, including dispatching background work as usual — its completion wakes this session automatically.`,
    `2. Call loop_control {action:"schedule", delay_seconds, reason} to set the single fallback alarm for the next check. Use it only for external state the system cannot observe, or as a long hang-protection fallback. Never schedule short alarms to poll background work.`,
    `3. Call loop_control {action:"complete", reason} once the task's goal is achieved — this ends the loop.`,
    ``,
    `Budget: ${maxTurns} loop turns; ${maxConsecutiveFailures} consecutive failed turns pause the loop automatically.`,
    `</luc-loop>`,
  ].join("\n");
  return {
    customType: LOOP_TURN_MESSAGE_TYPE,
    content,
    display: false,
    details: { schemaVersion: 1, kind: "kickoff" },
  };
}

export function buildLoopWakeupMessage(loop, reason) {
  const content = [
    `<luc-loop kind="wakeup">`,
    `Scheduled wakeup fired. Reason: ${reason || "(none recorded)"}`,
    `Loop task: ${loop.prompt}`,
    `Progress: loop turn ${loop.turnCount}/${loop.limits.maxTurns}.`,
    `Continue the task now; then schedule the next wakeup, or call loop_control {action:"complete"} if the goal is achieved.`,
    `</luc-loop>`,
  ].join("\n");
  return {
    customType: LOOP_TURN_MESSAGE_TYPE,
    content,
    display: false,
    details: { schemaVersion: 1, kind: "wakeup" },
  };
}

export function buildLoopNoticeMessage(text) {
  return {
    customType: LOOP_NOTICE_MESSAGE_TYPE,
    content: text,
    display: false,
    details: { schemaVersion: 1, kind: "notice" },
  };
}
