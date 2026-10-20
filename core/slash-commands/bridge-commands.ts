import { listRecentAgentSessions } from "./list-agent-sessions.ts";

/** @type {import('../slash-command-registry.ts').CommandDef[]} */
// 注意：reply 文案暂硬编码中文，和 session-ops.js 的 "[上下文已压缩]" 一致，
// 未来统一 slash 命令 i18n 时一并迁移到 t() 接口。
export const bridgeCommands = [
  {
    name: "stop",
    aliases: ["abort", "halt"],
    description: "中止当前正在进行的回复",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      // abort 返回值即权威答案：true = 成功中断流，false = 无活动流可中断
      // 之前版本同时读 isStreaming 再判 && ok 是 TOCTOU + 冗余，已移除
      // Phase 2-E：接管态下改中止桌面 session 的 stream 而非 bridge session
      const ref = _redirectRefIfAttached(ctx);
      const ok = await ctx.sessionOps.abort(ref);
      if (ok) return { silent: true };
      return { reply: "已停止（当前无活动回复）" };
    },
  },
  {
    name: "new",
    description: "开启新会话，历史归档",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      // Phase 2-E：接管态下拒绝执行（/new 对桌面 session 语义模糊，可能误删桌面会话）
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间禁止使用 /new，请先 /exitrc 退出接管" };
      }
      // rotate 合约保证返回 {status}，不做防御性 ?. 以便契约破坏时立刻暴露
      const res = await ctx.sessionOps.rotate(ctx.sessionRef);
      if (res.status === "not-found") return { reply: "未找到当前会话" };
      if (res.status === "no-history") return { reply: "已开启新会话（之前无历史记录）" };
      return { reply: "已开启新会话，旧会话已归档" };
    },
  },
  {
    name: "reset",
    aliases: ["clear"],
    description: "彻底重置会话，清除历史",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      // Phase 2-E：接管态下拒绝（/reset 破坏性强，接管态下手滑会删掉桌面会话历史）
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间禁止使用 /reset，请先 /exitrc 退出接管" };
      }
      // delete 合约同上，直接 res.status
      const res = await ctx.sessionOps.delete(ctx.sessionRef);
      if (res.status === "not-found") return { reply: "未找到当前会话" };
      return { reply: "已重置会话，历史已清除" };
    },
  },
  {
    name: "rc",
    description: "接管桌面会话（远程遥控）",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      // Phase 2-B：列出当前 agent 最近 10 个桌面 session，并设 pending-selection 等用户编号输入。
      // 真正的接管动作（summary + attach）在 bridge-manager 的 pending-handler 里做，
      // 因为用户输入的是"2"这种纯数字，不是 slash 命令，slash-dispatcher 不会触发。
      if (ctx.sessionRef?.kind !== "bridge") {
        return { reply: "/rc 只能在 bridge 会话中使用" };
      }
      if (ctx.isGroup) {
        return { reply: "/rc 只能在 bridge 私聊中使用，群聊里不能发起桌面会话接管" };
      }
      const rcState = ctx.engine?.rcState;
      if (!rcState) return { error: "rc 状态存储未初始化" };

      // 已接管：提示先退出再切换（防止一脚踩两个 attachment）
      if (rcState.isAttached(ctx.sessionRef.sessionKey)) {
        return { reply: "当前已处于接管态，请先 /exitrc 再执行 /rc 切换" };
      }

      const sessions = await listRecentAgentSessions(ctx.engine, ctx.sessionRef.agentId, { limit: 10 });
      const availableSessions = sessions.filter(s => !rcState.isDesktopSessionAttached(s.path));
      if (availableSessions.length === 0) {
        return { reply: "当前 agent 没有可接管的桌面会话" };
      }

      const lines = availableSessions.map((s, index) => {
        const titleStr = s.title ? s.title : `未命名 (${_formatShortDate(s.modified)})`;
        return `${index + 1}. ${titleStr}`;
      });
      const promptText = "选择要接管的桌面会话（回复编号）：\n"
        + lines.join("\n")
        + "\n\n5 分钟内不选则自动取消。/exitrc 退出接管。";

      rcState.setPending(ctx.sessionRef.sessionKey, {
        type: "rc-select",
        promptText,
        options: availableSessions.map(s => ({ path: s.path, title: s.title })),
      });
      return { reply: promptText };
    },
  },
  {
    name: "exitrc",
    description: "退出桌面会话接管",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (ctx.sessionRef?.kind !== "bridge") {
        return { reply: "/exitrc 只能在 bridge 会话中使用" };
      }
      const rcState = ctx.engine?.rcState;
      if (!rcState) return { error: "rc 状态存储未初始化" };
      const priorAttachment = rcState.getAttachment(ctx.sessionRef.sessionKey);
      const wasAttached = !!priorAttachment;
      const wasPending = rcState.isPending(ctx.sessionRef.sessionKey);
      rcState.reset(ctx.sessionRef.sessionKey);
      if (!wasAttached && !wasPending) {
        return { reply: "当前未处于接管状态" };
      }
      // Phase 2-D：广播 detached 让桌面 UI 撤横幅
      if (wasAttached && priorAttachment?.desktopSessionPath) {
        try {
          ctx.engine?.emitEvent?.({
            type: "bridge_rc_detached",
            sessionKey: ctx.sessionRef.sessionKey,
            sessionPath: priorAttachment.desktopSessionPath,
          }, priorAttachment.desktopSessionPath);
        } catch {}
      }
      return { reply: "已退出接管桌面会话" };
    },
  },
  {
    name: "apply",
    description: "创建最新的自动任务建议",
    usage: "/apply [建议ID]",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => _applyAutomationSuggestion(ctx),
  },
  {
    name: "confirm",
    aliases: ["approve"],
    description: "确认待处理请求",
    usage: "/confirm <确认ID>",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => _resolvePendingConfirmation(ctx, "confirmed"),
  },
  {
    name: "reject",
    aliases: ["deny"],
    description: "拒绝待处理请求",
    usage: "/reject <确认ID>",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => _resolvePendingConfirmation(ctx, "rejected"),
  },
  {
    name: "compact",
    description: "压缩当前会话上下文",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      // Phase 7：bridge /compact 做真实压缩（Luc cache-preserving compaction），并给用户发"进行中"+"完成/失败"两条消息
      // 让对方在社交平台看到"她在干活"的反馈，不用盯着一个沉默通道
      // 失败路径也要发一条给用户，否则压缩出错用户只会看到什么都没发生
      // Phase 2-E：接管态下 compact 的目标是桌面 session 的 context，不是 bridge 的
      const ref = _redirectRefIfAttached(ctx);
      try { await ctx.reply("（正在压缩上下文，请稍候...）"); } catch {}
      try {
        const result = await ctx.sessionOps.compact(ref);
        const before = result?.tokensBefore;
        const after = result?.tokensAfter;
        const msg = (typeof before === "number" && typeof after === "number")
          ? `（上下文已压缩：${before} → ${after} tokens）`
          : "（上下文已压缩）";
        try { await ctx.reply(msg); } catch {}
      } catch (err) {
        try { await ctx.reply(`（压缩失败：${err?.message || String(err)}）`); } catch {}
      }
      // 已经自己调 reply，走 silent 避免 dispatcher 再回复一次
      return { silent: true };
    },
  },
  {
    name: "fresh-compact",
    aliases: ["freshcompact"],
    description: "使用最新提示词和记忆状态压缩当前会话上下文",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => {
      if (_isAttached(ctx)) {
        return { reply: "接管桌面会话期间暂不支持 /fresh-compact，请先 /exitrc 退出接管" };
      }
      try { await ctx.reply("（正在 fresh-compact：刷新提示词与记忆状态后压缩上下文，请稍候...）"); } catch { /* best-effort */ }
      try {
        const result = await ctx.sessionOps.freshCompact(ctx.sessionRef);
        const before = result?.tokensBefore;
        const after = result?.tokensAfter;
        const reason = result?.reason ? `，原因：${result.reason}` : "";
        const msg = (typeof before === "number" && typeof after === "number")
          ? `（fresh-compact 已完成：${before} → ${after} tokens${reason}）`
          : `（fresh-compact 已完成${reason}）`;
        try { await ctx.reply(msg); } catch { /* best-effort */ }
      } catch (err) {
        try { await ctx.reply(`（fresh-compact 失败：${err?.message || String(err)}）`); } catch { /* best-effort */ }
      }
      return { silent: true };
    },
  },
  {
    name: "loop",
    description: "在当前会话启动/管理循环任务",
    usage: "/loop <任务> | /loop stop | pause | resume | status",
    scope: "session",
    permission: "owner",
    source: "core",
    handler: async (ctx) => _handleLoopCommand(ctx),
  },
];

const LOOP_SUBCOMMANDS = new Set(["stop", "pause", "resume", "status"]);

function _renderLoopStatus(loop) {
  if (!loop) return null;
  const lines = [
    `循环状态：${loop.status}${loop.pausedReason ? `（${loop.pausedReason}）` : ""}`,
    `任务：${loop.prompt}`,
    `轮数：${loop.turnCount}/${loop.limits?.maxTurns}`,
  ];
  if (loop.alarm) {
    lines.push(`闹钟：${new Date(loop.alarm.wakeAt).toLocaleString()}（${loop.alarm.reason || "无说明"}）`);
  } else {
    lines.push("闹钟：无");
  }
  if (loop.completedSummary) lines.push(`完成摘要：${loop.completedSummary}`);
  return lines.join("\n");
}

async function _handleLoopCommand(ctx) {
  const controller = ctx.engine?.loopController;
  if (!controller) return { error: "循环服务未就绪" };
  const args = (ctx.args || "").trim();
  const firstToken = args.split(/\s+/, 1)[0]?.toLowerCase() || "";
  const isStart = !!args && !LOOP_SUBCOMMANDS.has(firstToken);
  try {
    const target = await controller.targetFromSessionRef(ctx.sessionRef, { ensure: isStart });
    if (!target) return { error: "无法定位当前会话（会话尚未建立或已失效）" };
    if (!args || firstToken === "status") {
      const rendered = _renderLoopStatus(controller.statusForTarget(target));
      if (rendered) return { reply: rendered };
      return args
        ? { reply: "（该会话没有循环）" }
        : { error: "用法：/loop <任务> | /loop stop | pause | resume | status" };
    }
    if (firstToken === "stop") {
      await controller.stop(target);
      return { reply: "（循环已终止）" };
    }
    if (firstToken === "pause") {
      await controller.pause(target, "user");
      return { reply: "（循环已暂停，/loop resume 恢复）" };
    }
    if (firstToken === "resume") {
      await controller.resume(target);
      return { reply: "（循环已恢复）" };
    }
    await controller.start(target, args);
    return { reply: "（循环已启动，/loop status 查看进度，/loop stop 终止）" };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * 接管态检查：当前 bridge session 是否挂接了桌面 session。
 * @private
 */
function _isAttached(ctx) {
  const rcState = ctx.engine?.rcState;
  const sessionKey = ctx.sessionRef?.sessionKey;
  if (!rcState || !sessionKey) return false;
  return rcState.isAttached(sessionKey);
}

/**
 * 若处于接管态，把 bridge sessionRef 改写为指向桌面 session 的 desktop ref，
 * 让 sessionOps.{abort, compact} 的 desktop 分支执行在正确目标上。
 * 否则返回原 ref。
 * @private
 */
function _redirectRefIfAttached(ctx) {
  const rcState = ctx.engine?.rcState;
  const sessionKey = ctx.sessionRef?.sessionKey;
  if (!rcState || !sessionKey) return ctx.sessionRef;
  const att = rcState.getAttachment(sessionKey);
  if (!att) return ctx.sessionRef;
  return {
    kind: "desktop",
    agentId: ctx.sessionRef.agentId,
    sessionPath: att.desktopSessionPath,
  };
}

function _resolvePendingConfirmation(ctx, action) {
  const command = action === "confirmed" ? "confirm" : "reject";
  const confirmId = String(ctx.args || "").trim().split(/\s+/).filter(Boolean)[0];
  if (!confirmId) return { reply: `用法：/${command} <确认ID>` };

  const confirmStore = ctx.engine?.confirmStore || ctx.engine?.getConfirmStore?.() || null;
  if (!confirmStore?.get || !confirmStore?.resolve) {
    return { error: "确认系统未初始化" };
  }

  const pending = confirmStore.get(confirmId);
  if (!pending) return { reply: "确认请求不存在或已处理" };

  const found = confirmStore.resolve(confirmId, action);
  if (!found) return { reply: "确认请求不存在或已处理" };

  try {
    ctx.engine?.emitEvent?.({
      type: "confirmation_resolved",
      confirmId,
      action,
    }, null);
  } catch {}

  return {
    reply: action === "confirmed"
      ? "已确认，正在继续处理。"
      : "已拒绝，已取消这次请求。",
  };
}

async function _applyAutomationSuggestion(ctx) {
  const ref = String(ctx.args || "").trim().split(/\s+/).filter(Boolean)[0] || null;
  const store = ctx.engine?.automationSuggestionStore || ctx.engine?.getAutomationSuggestionStore?.() || null;
  if (!store?.apply) return { error: "自动任务建议系统未初始化" };

  const bridgeSessionKey = ctx.sessionRef?.kind === "bridge"
    ? ctx.sessionRef.sessionKey
    : null;
  const sessionId = ctx.sessionRef?.kind === "desktop"
    ? ctx.sessionRef.sessionId
    : null;
  if (!bridgeSessionKey && !sessionId) {
    return { reply: "/apply 只能在当前会话中创建自动任务建议" };
  }
  let studioId = null;
  try {
    const runtimeContext = ctx.engine?.getRuntimeContext?.();
    studioId = typeof runtimeContext?.studioId === "string" && runtimeContext.studioId.trim()
      ? runtimeContext.studioId.trim()
      : null;
  } catch {
    studioId = null;
  }
  if (!studioId) {
    return { reply: "当前 Studio 身份不可用，无法创建自动任务建议" };
  }

  try {
    const result = await store.apply({
      studioId,
      ...(bridgeSessionKey ? { bridgeSessionKey } : { sessionId }),
      ref,
    });
    if (!result?.ok) {
      return { reply: ref ? `没有找到建议 ${ref}，可能已经创建过了。` : "没有待创建的自动任务建议。" };
    }
    const label = _automationSuggestionLabel(result.suggestion) || "自动任务";
    return { reply: `已创建自动任务：${label}` };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function _automationSuggestionLabel(suggestion) {
  const jobData = suggestion?.jobData;
  const value = typeof jobData?.label === "string" && jobData.label.trim()
    ? jobData.label.trim()
    : typeof suggestion?.title === "string" && suggestion.title.trim()
      ? suggestion.title.trim()
      : "";
  return value;
}

/** 列表显示用的短日期：今天则 HH:mm；否则 M/D HH:mm */
function _formatShortDate(modified) {
  if (modified == null) return "未知时间";
  const d = typeof modified === "number" || typeof modified === "string"
    ? new Date(modified)
    : (modified instanceof Date ? modified : new Date());
  if (Number.isNaN(d.getTime())) return "未知时间";
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const isSameDay = d.toDateString() === now.toDateString();
  if (isSameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
