/**
 * Hub — 消息调度中枢
 *
 * 同进程模式：Hub 和 LucEngine 跑在同一个 Node 进程里。
 * hub.send() 内部直接调 engine 方法，行为零变化。
 * EventBus 通过 engine.setEventBus() 注入，统一事件广播。
 *
 * 模块：
 *   EventBus      — 统一事件总线
 *   ChannelRouter  — 频道手机送达 + 调度
 *   GuestHandler   — Guest 留言机
 *   Scheduler      — Heartbeat + Cron
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { EventBus } from "./event-bus.ts";
import { ChannelRouter } from "./channel-router.ts";
import { GuestHandler } from "./guest-handler.ts";
import { Scheduler } from "./scheduler.ts";
import { DmRouter } from "./dm-router.ts";
import { AgentPhoneActivityStore } from "../lib/conversations/agent-phone-activity.ts";
import {
  extractTextContent,
  filterUnreferencedInlineImages,
  loadSessionHistoryMessages,
  isValidSessionPath,
} from "../core/message-utils.ts";
import { submitDesktopSessionMessage } from "../core/desktop-session-submit.ts";
import { stripSessionReminderBlocks } from "../core/session-reminders.ts";
import { extOfName, inferFileKind } from "../lib/file-metadata.ts";
import { createModuleLogger } from "../lib/debug-log.ts";
import { normalizeSessionTurnContext } from "../core/session-turn-context.ts";
import { findModel } from "../shared/model-ref.ts";

const log = createModuleLogger("hub");

function assertRuntimeMediaCapabilityOwner(providerRegistry, providerId, requestContext) {
  const caller = requestContext?.caller;
  if (caller?.kind !== "plugin" || typeof caller.pluginId !== "string") {
    throw new Error("Runtime media capability sources can only be managed by their provider plugin");
  }
  const entryPluginId = providerRegistry.get?.(providerId)?.source?.pluginId;
  const registeredOwner = providerRegistry.getRuntimeMediaCapabilitySourceOwner?.(providerId)?.pluginId;
  const expectedPluginId = registeredOwner || entryPluginId || providerId;
  if (caller.pluginId !== expectedPluginId) {
    throw new Error(
      `Plugin "${caller.pluginId}" cannot manage runtime media capabilities for provider "${providerId}"`,
    );
  }
  return { pluginId: caller.pluginId };
}

export class Hub {
  declare _agentPhoneAbortHandlers: any;
  declare _agentPhoneActivities: any;
  declare _bridgeManager: any;
  declare _channelRouter: any;
  declare _dmRouter: any;
  declare _engine: any;
  declare _eventBus: any;
  declare _guestHandler: any;
  declare _scheduler: any;
  declare _sessionHandlerCleanups: any;
  /**
   * @param {object} opts
   * @param {import('../core/engine.ts').LucEngine} opts.engine
   */
  constructor({ engine }) {
    this._engine = engine;
    this._eventBus = new EventBus();
    this._channelRouter = new ChannelRouter({ hub: this });
    this._guestHandler = new GuestHandler({ hub: this });
    this._scheduler = new Scheduler({ hub: this });
    this._dmRouter = new DmRouter({ hub: this });
    this._agentPhoneActivities = new AgentPhoneActivityStore({
      emit: (event) => this._eventBus.emit(event, null),
    });
    this._agentPhoneAbortHandlers = new Set();

    // 注入 Hub 回调到 Engine（单向：Hub → Engine，不再双向引用）
    engine.setHubCallbacks({
      hub: this,  // 用于 slash dispatcher setHub 注入；engine.setHubCallbacks 内部会调 dispatcher.setHub(hub)
      scheduler: this._scheduler,
      dmRouter: this._dmRouter,
      channelRouter: this._channelRouter,
      eventBus: this._eventBus,
      registerAgentPhoneAbortHandler: (handler, meta) => this.registerAgentPhoneAbortHandler(handler, meta),
      pauseForAgentSwitch: () => this.pauseForAgentSwitch(),
      resumeAfterAgentSwitch: () => this.resumeAfterAgentSwitch(),
      triggerChannelDelivery: (name, opts) => this._channelRouter.triggerImmediate(name, opts),
      triggerChannelTriage: (name, opts) => this._channelRouter.triggerImmediate(name, opts),
    });

    // 注入 EventBus（替代旧的 proxy hack）
    engine.setEventBus(this._eventBus);

    this._sessionHandlerCleanups = [];
    this._setupSessionHandlers();
    this._setupDmHandler();
  }

  /** @returns {import('../core/engine.ts').LucEngine} */
  get engine() { return this._engine; }

  /** @returns {EventBus} */
  get eventBus() { return this._eventBus; }

  /** @returns {ChannelRouter} */
  get channelRouter() { return this._channelRouter; }

  /** @returns {Scheduler} */
  get scheduler() { return this._scheduler; }

  /** @returns {import('../lib/bridge/bridge-manager.ts').BridgeManager|null} */
  get bridgeManager() { return this._bridgeManager || null; }
  set bridgeManager(bm) { this._bridgeManager = bm; }

  get agentPhoneActivities() { return this._agentPhoneActivities; }

  registerAgentPhoneAbortHandler(handler, meta: any = {}) {
    if (typeof handler !== "function") return () => {};
    const entry = { handler, meta };
    this._agentPhoneAbortHandlers.add(entry);
    return () => {
      this._agentPhoneAbortHandlers.delete(entry);
    };
  }

  abortAgentPhoneSessions(reason = "phone-disabled", filter = null) {
    const entries = [...this._agentPhoneAbortHandlers];
    let aborted = 0;
    for (const { handler, meta } of entries) {
      if (!matchesAgentPhoneAbortFilter(meta, filter)) continue;
      try {
        handler(reason);
        aborted += 1;
      } catch (err) {
        log.warn(`agent phone abort handler failed: ${err.message}`);
      }
    }
    return aborted;
  }

  // ──────────── 订阅 ────────────

  /**
   * 订阅事件（替代 engine.subscribe）
   * @param {Function} callback  (event, sessionPath) => void
   * @param {object} [filter]    可选过滤器
   * @returns {Function} unsubscribe
   */
  subscribe(callback, filter) {
    return this._eventBus.subscribe(callback, filter);
  }

  // ──────────── 消息统一入口 ────────────

  /**
   * 统一消息入口
   *
   * @param {string} text  消息文本
   * @param {object} [opts]
   * @param {string}  [opts.sessionKey]  Bridge/频道的 session 标识
   * @param {string}  [opts.role]        "owner" | "agent" | "guest"（默认 "owner"）
   * @param {boolean} [opts.ephemeral]   true = 不持久化 session（cron/heartbeat/channel）
   * @param {object}  [opts.meta]        Bridge 元数据 { name, avatarUrl, userId }
   * @param {boolean} [opts.isGroup]     是否群聊（影响 guest 上下文标签）
   * @param {string}  [opts.cwd]         工作目录覆盖
   * @param {string}  [opts.model]       模型覆盖
   * @param {string}  [opts.persist]     持久化目录（activity session）
   * @param {string}  [opts.permissionMode] 后台隔离执行权限档，默认 auto
   * @returns {Promise<*>}
   */
  async send(text, opts: any = {}) {
    const {
      sessionKey,
      role = "owner",
      ephemeral = false,
      meta,
      isGroup = false,
      cwd,
      model,
      persist,
      permissionMode,
      from,
      to,
      onDelta,
      images,
      imageAttachmentPaths,
      videos,
      videoAttachmentPaths,
      audios,
      audioAttachmentPaths,
      inboundFiles,
      clientMessageId,
      sessionId,
      sessionPath,
      agentId,
      uiContext,
      displayMessage,
      sessionFileRefs,
    } = opts;
    const o = { sessionKey, role, ephemeral, meta, isGroup, cwd, model, persist, permissionMode, from, to, onDelta, images, imageAttachmentPaths, videos, videoAttachmentPaths, audios, audioAttachmentPaths, inboundFiles, clientMessageId, sessionId, sessionPath, agentId, uiContext, displayMessage, sessionFileRefs };

    // ── 图片预处理：持久化到磁盘 + 插入 [attached_image] 标记 ──
    // 在路由之前统一处理，所有消息路径（WS / Bridge DM / Bridge Group）共享
    if (
      o.images?.length
      && this._engine.luccodeHome
      && !o.inboundFiles?.length
      && !hasDisplayImageAttachments(o.displayMessage)
    ) {
      const attachDir = path.join(this._engine.luccodeHome, "attachments");
      await fs.promises.mkdir(attachDir, { recursive: true });
      const savedPaths = [];
      for (const img of o.images) {
        const ext = (img.mimeType || "image/png").split("/")[1] || "png";
        const hash = crypto.createHash("md5").update((img.data || "").slice(0, 1024)).digest("hex").slice(0, 8);
        const filePath = path.join(attachDir, `upload-${Date.now()}-${hash}.${ext}`);
        try {
          await fs.promises.writeFile(filePath, Buffer.from(img.data, "base64"));
          savedPaths.push(filePath);
        } catch { /* best-effort; prompt still goes through */ }
      }
      if (savedPaths.length) {
        const pathNote = savedPaths.map(p => `[attached_image: ${p}]`).join("\n");
        text = `${pathNote}\n${text}`;
        o.imageAttachmentPaths = savedPaths;
      }
    }
    if (
      o.videos?.length
      && this._engine.luccodeHome
      && !o.inboundFiles?.length
      && !hasDisplayVideoAttachments(o.displayMessage)
    ) {
      const attachDir = path.join(this._engine.luccodeHome, "attachments");
      await fs.promises.mkdir(attachDir, { recursive: true });
      const savedPaths = [];
      for (const video of o.videos) {
        const ext = extensionForVideoMime(video.mimeType);
        const hash = crypto.createHash("md5").update((video.data || "").slice(0, 1024)).digest("hex").slice(0, 8);
        const filePath = path.join(attachDir, `upload-${Date.now()}-${hash}${ext}`);
        try {
          await fs.promises.writeFile(filePath, Buffer.from(video.data, "base64"));
          savedPaths.push(filePath);
        } catch { /* best-effort; prompt still goes through */ }
      }
      if (savedPaths.length) {
        const pathNote = savedPaths.map(p => `[attached_video: ${p}]`).join("\n");
        text = `${pathNote}\n${text}`;
        o.videoAttachmentPaths = savedPaths;
      }
    }

    // 路由表：按顺序匹配，第一条命中即执行。
    // 优先级通过位置保证，新增路由在此处显式插入，不依赖散落在各处的 if 顺序。
    const routes = [
      { // 桌面端 owner
        match: o => !o.sessionKey && !o.ephemeral && o.role === "owner",
        handle: () => o.sessionPath
          ? submitDesktopSessionMessage(this._engine, {
            sessionId: o.sessionId,
            sessionPath: o.sessionPath,
            text,
            images: o.images,
            imageAttachmentPaths: o.imageAttachmentPaths,
            videos: o.videos,
            videoAttachmentPaths: o.videoAttachmentPaths,
            audios: o.audios,
            audioAttachmentPaths: o.audioAttachmentPaths,
            inboundFiles: o.inboundFiles,
            clientMessageId: o.clientMessageId,
            onDelta: o.onDelta,
            uiContext: o.uiContext,
            displayMessage: o.displayMessage,
            sessionFileRefs: o.sessionFileRefs,
          })
          : this._engine.prompt(text, { images: o.images, videos: o.videos, audios: o.audios }),
      },
      { // Bridge guest
        match: o => o.sessionKey && o.role === "guest",
        handle: () => this._guestHandler.handle(text, o.sessionKey, o.meta, { isGroup: o.isGroup, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths, videos: o.videos, videoAttachmentPaths: o.videoAttachmentPaths, audios: o.audios, audioAttachmentPaths: o.audioAttachmentPaths, inboundFiles: o.inboundFiles, displayMessage: o.displayMessage }),
      },
      { // Bridge owner
        match: o => o.sessionKey && !o.ephemeral,
        handle: () => this._engine.executeExternalMessage(text, o.sessionKey, o.meta, { guest: false, agentId: o.agentId, onDelta: o.onDelta, images: o.images, imageAttachmentPaths: o.imageAttachmentPaths, videos: o.videos, videoAttachmentPaths: o.videoAttachmentPaths, audios: o.audios, audioAttachmentPaths: o.audioAttachmentPaths, inboundFiles: o.inboundFiles, displayMessage: o.displayMessage }),
      },
      { // 隔离执行（cron/heartbeat/channel）
        match: o => o.ephemeral,
        handle: () => this._engine.executeIsolated(text, {
          cwd: o.cwd,
          model: o.model,
          persist: o.persist,
          permissionMode: o.permissionMode || "auto",
          approvalPolicy: "deny_on_prompt",
          allowHumanApproval: false,
        }),
      },
    ];

    for (const route of routes) {
      if (route.match(o)) return route.handle();
    }
    throw new Error(`[Hub] unhandled route: role=${o.role}, sessionKey=${o.sessionKey}, ephemeral=${o.ephemeral}`);
  }

  /**
   * 中断生成（支持指定 session）
   */
  async abort(sessionPath, options: any = {}) {
    const hasOptions = options && Object.keys(options).length > 0;
    return sessionPath
      ? (hasOptions ? this._engine.abortSession(sessionPath, options) : this._engine.abortSession(sessionPath))
      : (hasOptions ? this._engine.abort(options) : this._engine.abort());
  }

  // ──────────── 调度器管理 ────────────

  /**
   * 初始化所有调度器（Scheduler + ChannelRouter）
   * 在 engine.init() 完成后由 server/index.ts 调用
   */
  initSchedulers() {
    const engine = this._engine;

    // Scheduler（heartbeat + cron）
    this._scheduler.start();

    // ChannelRouter：仅在频道总开关为开时启动
    if (engine.isChannelsEnabled?.()) {
      this._channelRouter.start();
      this._channelRouter.setupPostHandler();
    }
  }

  /**
   * Agent 切换前暂停：停所有 heartbeat（cron 全 agent 并发，不中断），ChannelRouter 持续跑
   */
  async pauseForAgentSwitch() {
    await this._scheduler.stopHeartbeat();
  }

  /**
   * Agent 切换完成后恢复：重启所有 agent 的 heartbeat（幂等），重新注入 handler
   */
  resumeAfterAgentSwitch() {
    this._scheduler.startHeartbeat();
    this._setupDmHandler();
    this._channelRouter.setupPostHandler();
  }

  /**
   * 停止所有调度器（dispose 用）
   */
  async stopSchedulers() {
    await this._scheduler.stop();
    await this._channelRouter.stop();
  }

  // ──────────── 频道代理方法 ────────────

  triggerChannelDelivery(channelName, opts) {
    return this._channelRouter.triggerImmediate(channelName, opts);
  }

  triggerChannelTriage(channelName, opts) {
    return this.triggerChannelDelivery(channelName, opts);
  }

  async toggleChannels(enabled) {
    if (!enabled) this.abortAgentPhoneSessions("channels-disabled");
    return this._channelRouter.toggle(enabled);
  }

  refreshChannelProactiveSchedule() {
    return this._channelRouter.refreshProactiveSchedule();
  }

  // ──────────── 生命周期 ────────────

  async dispose() {
    for (const cleanup of this._sessionHandlerCleanups) cleanup();
    this._sessionHandlerCleanups = [];
    await this.stopSchedulers();
    await this._engine.dispose();
    this._eventBus.clear();
  }

  // ──────────── 内部 ────────────

  /** @returns {DmRouter} */
  get dmRouter() { return this._dmRouter; }

  _setupSessionHandlers() {
    const bus = this._eventBus;
    const engine = this._engine;

    // ── session:create ──
    this._sessionHandlerCleanups.push(bus.handle("session:create", async (payload: any = {}) => {
      const agentId = textOrNull(payload.agentId);
      const cwd = textOrNull(payload.cwd) || undefined;
      const memFlag = payload.memoryEnabled !== false;
      const model = resolveRequestedModel(engine, payload.model);
      const createOptions = {
        workspaceFolders: Array.isArray(payload.workspaceFolders)
          ? payload.workspaceFolders.filter((item) => typeof item === "string" && item.trim())
          : [],
        authorizedFolders: Array.isArray(payload.authorizedFolders)
          ? payload.authorizedFolders.filter((item) => typeof item === "string" && item.trim())
          : [],
        visibleInSessionList: payload.visibility !== "plugin_private" && payload.visibility !== "private",
        ...(payload.thinkingLevel != null ? { thinkingLevel: payload.thinkingLevel } : {}),
        ...(payload.permissionMode != null ? { permissionMode: payload.permissionMode } : {}),
        ownerPluginId: textOrNull(payload.ownerPluginId),
        sessionKind: textOrNull(payload.kind || payload.sessionKind),
        sessionVisibility: textOrNull(payload.visibility || payload.sessionVisibility) || "public",
      };
      if (typeof engine.createDetachedSession !== "function") {
        throw new Error("session detached creation unavailable");
      }
      const result = await engine.createDetachedSession({
        cwd,
        memoryEnabled: memFlag,
        model,
        ...(agentId ? { agentId } : {}),
        ...createOptions,
      });
      engine.persistSessionMeta?.(result.sessionPath);
      const sessionPath = result.sessionPath;
      const sessionId = sessionPath ? engine.getSessionIdForPath?.(sessionPath) || null : null;
      if (payload.permissionMode !== undefined && sessionPath) {
        engine.setSessionPermissionModeForSession?.(sessionPath, payload.permissionMode);
      }
      const response = {
        ok: true,
        ...(sessionId ? { sessionId, sessionRef: { sessionId, sessionPath } } : {}),
        sessionPath,
        path: sessionPath,
        agentId: result.agentId,
        agentName: engine.getAgent?.(result.agentId)?.agentName || result.agentId || null,
        cwd: engine.getSessionByPath?.(sessionPath)?.sessionManager?.getCwd?.() || cwd || null,
        workspaceFolders: engine.getSessionWorkspaceFolders?.(sessionPath) || [],
        authorizedFolders: engine.getSessionAuthorizedFolders?.(sessionPath) || [],
        thinkingLevel: engine.getSessionThinkingLevel?.(sessionPath) || null,
        permissionMode: engine.getSessionPermissionMode?.(sessionPath) || null,
        ownerPluginId: createOptions.ownerPluginId || null,
        kind: createOptions.sessionKind || null,
        visibility: createOptions.sessionVisibility || "public",
      };
      bus.emit({ type: "session_created", session: response }, sessionPath);
      return response;
    }));

    // ── session:get ──
    this._sessionHandlerCleanups.push(bus.handle("session:get", async (payload: any = {}) => {
      const target = resolvePluginSessionTarget(engine, payload, "session:get");
      const { sessionPath, sessionId } = target;
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      const sessions = await engine.listSessions({
        includePluginPrivate: true,
        ...(payload.ownerPluginId ? { ownerPluginId: payload.ownerPluginId } : {}),
      });
      const session = sessions.find((item) => (
        (sessionId && item.sessionId === sessionId) || item.path === sessionPath
      )) || null;
      if (!session) return { session: null };
      return { session: { ...session, ...(sessionId && !session.sessionId ? { sessionId } : {}) } };
    }));

    // ── session:update ──
    this._sessionHandlerCleanups.push(bus.handle("session:update", async (payload: any = {}) => {
      const {
      title,
      pinned,
      projectId,
      thinkingLevel,
      permissionMode,
      ownerPluginId,
      kind,
      sessionKind,
      visibility,
      sessionVisibility,
      } = payload;
      const target = resolvePluginSessionTarget(engine, payload, "session:update");
      const { sessionPath, sessionId } = target;
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      if (typeof title === "string") await engine.saveSessionTitle?.(sessionPath, title);
      if (pinned !== undefined) await engine.setSessionPinned?.(sessionPath, !!pinned);
      if (projectId !== undefined) {
        await engine.setSessionProjectAssignment?.({ sessionPath, projectId });
      }
      if (thinkingLevel !== undefined) {
        await engine.setSessionThinkingLevel?.(sessionPath, thinkingLevel);
      }
      if (permissionMode !== undefined) {
        engine.setSessionPermissionModeForSession?.(sessionPath, permissionMode);
      }
      if (
        ownerPluginId !== undefined
        || kind !== undefined
        || sessionKind !== undefined
        || visibility !== undefined
        || sessionVisibility !== undefined
      ) {
        await engine.setSessionPluginMeta?.(sessionPath, {
          ownerPluginId,
          kind: kind ?? sessionKind,
          visibility: visibility ?? sessionVisibility,
        });
      }
      const sessions = await engine.listSessions({ includePluginPrivate: true });
      const session = sessions.find((item) => (
        (sessionId && item.sessionId === sessionId) || item.path === sessionPath
      )) || null;
      return { ok: true, ...(sessionId ? { sessionId } : {}), session };
    }));

    // ── session:send ──
    this._sessionHandlerCleanups.push(bus.handle("session:send", async ({ text, ...opts }) => {
      if (!text || typeof text !== "string" || !text.trim()) {
        throw new Error("text is required");
      }
      const target = resolvePluginSessionTarget(engine, opts, "session:send");
      const sp = target.sessionPath;
      if (engine.isSessionStreaming(sp)) throw new Error("session_busy");
      if (opts.context !== undefined) {
        opts.context = normalizeSessionTurnContext(opts.context);
      }
      if (target.sessionId) {
        opts.sessionId = target.sessionId;
        opts.sessionRef = target.sessionRef;
      }
      engine.promptSession(sp, text, opts).catch(err => {
        log.error(`session:send promptSession error: ${err.message}`);
        bus.emit({ type: "error", error: err.message, source: "session:send" }, sp);
      });
      return {
        ...(target.sessionId ? { sessionId: target.sessionId, sessionRef: target.sessionRef } : {}),
        sessionPath: sp,
        accepted: true,
      };
    }));

    // ── session:abort ──
    this._sessionHandlerCleanups.push(bus.handle("session:abort", async (payload: any = {}) => {
      const target = resolvePluginSessionTarget(engine, payload, "session:abort", { required: false });
      const sp = target?.sessionPath;
      if (!sp) return { aborted: false };
      const { reason } = payload;
      const options = typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : null;
      const result = options ? await engine.abortSession(sp, options) : await engine.abortSession(sp);
      return { aborted: !!result, ...(target.sessionId ? { sessionId: target.sessionId, sessionRef: target.sessionRef } : {}) };
    }));

    // ── session:history ──
    this._sessionHandlerCleanups.push(bus.handle("session:history", async (payload: any = {}) => {
      const { limit: rawLimit } = payload;
      const target = resolvePluginSessionTarget(engine, payload, "session:history");
      const { sessionPath, sessionId } = target;
      if (!isValidSessionPath(sessionPath, engine.agentsDir)) {
        throw new Error("Invalid session path");
      }
      const limit = Math.min(Number(rawLimit) || 50, 200);
      const sourceMessages = await loadSessionHistoryMessages(engine, sessionPath);
      const messages = [];
      for (const m of sourceMessages) {
        if (m.role === "user") {
          const { text, images } = extractTextContent(m.content);
          const visibleImages = filterUnreferencedInlineImages(text, images);
          const visibleText = stripSessionReminderBlocks(text);
          if (visibleText || visibleImages.length) {
            messages.push({ role: "user", content: visibleText, images: visibleImages.length ? visibleImages : undefined });
          }
        } else if (m.role === "assistant") {
          const { text, thinking, toolUses } = extractTextContent(m.content, { stripThink: true });
          if (text || toolUses.length) {
            messages.push({
              role: "assistant",
              content: text,
              thinking: thinking || undefined,
              toolCalls: toolUses.length ? toolUses : undefined,
            });
          }
        }
        if (messages.length >= limit) break;
      }
      return { messages, ...(sessionId ? { sessionId, sessionRef: target.sessionRef } : {}) };
    }));

    // ── session:list ──
    this._sessionHandlerCleanups.push(bus.handle("session:list", async ({ agentId, ownerPluginId, includePluginPrivate }: any = {}) => {
      const all = await engine.listSessions({
        includePluginPrivate: includePluginPrivate === true || !!ownerPluginId,
        ...(ownerPluginId ? { ownerPluginId } : {}),
      });
      const filtered = agentId ? all.filter(s => s.agentId === agentId) : all;
      const sessions = filtered.map(s => ({
        path: s.path,
        title: s.title,
        firstMessage: s.firstMessage,
        agentId: s.agentId,
        agentName: s.agentName,
        modelId: s.modelId,
        messageCount: s.messageCount,
        cwd: s.cwd,
        modified: s.modified,
        ownerPluginId: s.ownerPluginId || null,
        kind: s.sessionKind || null,
        visibility: s.visibility || "public",
      }));
      return { sessions };
    }));

    // ── agent:list ──
    this._sessionHandlerCleanups.push(bus.handle("agent:list", async ({ ownerPluginId, includePluginPrivate }: any = {}) => {
      const all = engine.listAgents({
        includePluginPrivate: includePluginPrivate === true || !!ownerPluginId,
        ...(ownerPluginId ? { ownerPluginId } : {}),
      });
      const agents = all.map(a => ({
        id: a.id,
        name: a.name,
        yuan: a.yuan || null,
        identity: a.identity || "",
        ownerPluginId: a.plugin?.ownerPluginId || null,
        visibility: a.plugin?.visibility || "public",
        isCurrent: a.isCurrent,
        isPrimary: a.isPrimary,
      }));
      return { agents };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:profile", async ({ agentId }: any = {}) => {
      const { agent, error } = resolveAgentForBus(engine, agentId);
      if (error) throw new Error(error);
      return { profile: publicAgentProfile(agent) };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:create", async (payload: any = {}) => {
      const name = textOrNull(payload.name);
      if (!name) throw new Error("name is required");
      const ownerPluginId = textOrNull(payload.ownerPluginId);
      const visibility = textOrNull(payload.visibility) || "public";
      const result = await engine.createAgent({
        name,
        ...(textOrNull(payload.id) ? { id: textOrNull(payload.id) } : {}),
        ...(textOrNull(payload.yuan) ? { yuan: textOrNull(payload.yuan) } : {}),
        ...(payload.initialFiles && typeof payload.initialFiles === "object" ? { initialFiles: payload.initialFiles } : {}),
        ...(payload.initialMemory && typeof payload.initialMemory === "object" ? { initialMemory: payload.initialMemory } : {}),
      });
      if (ownerPluginId || visibility !== "public" || payload.kind) {
        await engine.updateConfig?.({
          plugin: {
            ownerPluginId: ownerPluginId || null,
            visibility,
            ...(textOrNull(payload.kind) ? { kind: textOrNull(payload.kind) } : {}),
          },
        }, { agentId: result.id });
        engine.invalidateAgentListCache?.();
      }
      if (payload.memoryPolicy && typeof payload.memoryPolicy === "object") {
        await engine.updateConfig?.({
          memory: { enabled: payload.memoryPolicy.enabled !== false },
        }, { agentId: result.id });
      }
      const createdAgent = engine.getAgent?.(result.id);
      return {
        agent: {
          id: result.id,
          name: result.name,
          ownerPluginId: ownerPluginId || null,
          visibility,
          profile: createdAgent ? publicAgentProfile(createdAgent) : null,
        },
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:update", async ({
      agentId,
      name,
      yuan,
      visibility,
      ownerPluginId,
      kind,
      memoryPolicy,
      toolPolicy,
      config,
    }: any = {}) => {
      if (!agentId) throw new Error("agentId is required");
      const partial: any = {};
      if (name !== undefined || yuan !== undefined) {
        partial.agent = {
          ...(name !== undefined ? { name } : {}),
          ...(yuan !== undefined ? { yuan } : {}),
        };
      }
      if (visibility !== undefined || ownerPluginId !== undefined || kind !== undefined) {
        partial.plugin = {
          ...(ownerPluginId !== undefined ? { ownerPluginId: textOrNull(ownerPluginId) } : {}),
          ...(visibility !== undefined ? { visibility: textOrNull(visibility) || "public" } : {}),
          ...(kind !== undefined ? { kind: textOrNull(kind) } : {}),
        };
      }
      if (memoryPolicy && typeof memoryPolicy === "object") {
        partial.memory = { enabled: memoryPolicy.enabled !== false };
      }
      if (toolPolicy && typeof toolPolicy === "object") {
        partial.tools = {
          ...(Array.isArray(toolPolicy.disabled) ? { disabled: toolPolicy.disabled } : {}),
        };
      }
      if (config && typeof config === "object") {
        Object.assign(partial, config);
      }
      await engine.updateConfig?.(partial, { agentId });
      engine.invalidateAgentListCache?.();
      const agent = engine.getAgent?.(agentId);
      return { ok: true, agent: agent ? publicAgentProfile(agent) : { id: agentId } };
    }));

    // ── provider & agent handlers ──

    this._sessionHandlerCleanups.push(bus.handle("provider:credentials", async ({ providerId, forceRefresh, staleApiKey }) => {
      if (typeof engine.resolveProviderCredentialsFresh !== "function") {
        return { error: "fresh_credentials_unavailable" };
      }
      let fresh;
      try {
        fresh = await engine.resolveProviderCredentialsFresh(providerId, {
          forceRefresh: !!forceRefresh,
          ...(staleApiKey ? { staleApiKey } : {}),
        });
      } catch {
        return { error: "credential_refresh_failed" };
      }
      const creds = {
        apiKey: fresh?.api_key,
        baseUrl: fresh?.base_url,
        api: fresh?.api,
        accountId: fresh?.accountId,
      };
      if (!creds?.apiKey) return { error: "no_credentials" };
      return {
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        api: creds.api,
        ...(creds.accountId ? { accountId: creds.accountId } : {}),
      };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:models-by-type", async ({ type, providerId }) => {
      if (providerId) {
        return { models: engine.providerRegistry.getModelsByType(providerId, type) };
      }
      return { models: engine.providerRegistry.getAllModelsByType(type) };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:media-providers", async ({ capability = "image_generation" }: any = {}) => {
      await engine.providerRegistry.refreshRuntimeMediaCapabilities?.({ capability });
      const mediaConfig = capability === "video_generation"
        ? engine.media?.getVideoConfig?.()
        : engine.media?.getImageConfig?.();
      const defaultModel = capability === "video_generation"
        ? mediaConfig?.defaultVideoModel
        : mediaConfig?.defaultImageModel;
      const defaultConfigured = Boolean(defaultModel?.provider && defaultModel?.id);
      const selection = {
        defaultConfigured,
        selectionPolicy: defaultConfigured ? "configured_default" : "first_available_fallback",
        overrideRequired: false,
        defaultInvocation: {
          provider: "omit",
          model: "omit",
          mode: "omit_unless_needed",
          options: "omit_unless_needed",
        },
        instruction: defaultConfigured
          ? "These providers and models are optional advanced overrides, not a required menu. For ordinary generation, omit provider and model so the host uses the configured default."
          : "These providers and models are optional advanced overrides, not a required menu. For ordinary generation, omit provider and model so the host uses its first available fallback.",
      };
      const providers: any = {};
      for (const provider of engine.providerRegistry.getMediaProviders(capability)) {
        const credentialStatus = engine.providerRegistry.getMediaProviderCredentialStatus(provider.providerId, capability);
        providers[provider.providerId] = {
          ...provider,
          hasCredentials: credentialStatus.hasCredentials,
          unavailableReason: credentialStatus.unavailableReason,
          credentialLanes: credentialStatus.lanes,
          activeCredentialLaneId: credentialStatus.activeLaneId || null,
          activeCredentialProviderId: credentialStatus.activeProviderId || null,
          unavailableMessage: credentialStatus.unavailableMessage || null,
          models: provider.models.map((model) => {
            const name = model.displayName || model.name || model.id;
            return {
              ...model,
              id: model.id,
              name,
              displayName: name,
              protocolId: model.protocolId,
              credentialLaneId: model.credentialLaneId,
            };
          }),
          availableModels: [],
        };
      }
      return { providers, selection };
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:resolve-media-model", async ({
      providerId,
      provider,
      modelId,
      model,
      capability = "image_generation",
      credentialLaneId,
    }: any = {}) => {
      try {
        await engine.providerRegistry.refreshRuntimeMediaCapabilities?.({
          providerId: providerId || provider,
          capability,
        });
        const resolved = engine.providerRegistry.resolveMediaModel({
          providerId: providerId || provider,
          modelId: modelId || model,
          capability,
          credentialLaneId,
        });
        const status = engine.providerRegistry.getMediaProviderCredentialStatus(resolved.providerId, capability);
        const lane = resolved.credentialLane || null;
        const credentialProviderId = lane?.providerId || status.activeProviderId || resolved.providerId;
        if (!status.hasCredentials && resolved.provider.authType !== "none") {
          return { error: status.unavailableReason || "no_credentials" };
        }
        return {
          providerId: resolved.providerId,
          modelId: resolved.model.id,
          model: resolved.model,
          protocolId: resolved.model.protocolId,
          capability: resolved.capability,
          credentialLaneId: lane?.id || status.activeLaneId || null,
          credentialProviderId,
        };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:register-runtime-media-capability-source", async ({
      providerId,
      source,
    }: any = {}, requestContext: any = null) => {
      try {
        const owner = assertRuntimeMediaCapabilityOwner(engine.providerRegistry, providerId, requestContext);
        engine.providerRegistry.registerRuntimeMediaCapabilitySource(providerId, source, owner);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:unregister-runtime-media-capability-source", async ({
      providerId,
    }: any = {}, requestContext: any = null) => {
      try {
        const owner = assertRuntimeMediaCapabilityOwner(engine.providerRegistry, providerId, requestContext);
        engine.providerRegistry.unregisterRuntimeMediaCapabilitySource(providerId, owner);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:add-media-model", async ({
      providerId,
      capability = "image_generation",
      model,
    }: any = {}) => {
      try {
        engine.providerRegistry.addMediaModel(providerId, capability, model);
        await engine.onProviderChanged?.();
        return { ok: true };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("provider:remove-media-model", async ({
      providerId,
      capability = "image_generation",
      modelId,
    }: any = {}) => {
      try {
        engine.providerRegistry.removeMediaModel(providerId, capability, modelId);
        await engine.onProviderChanged?.();
        return { ok: true };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:config", async ({ agentId }) => {
      const { agent, error } = resolveAgentForBus(engine, agentId);
      if (error) return { error };
      return { config: agent.config };
    }));

    this._sessionHandlerCleanups.push(bus.handle("agent:update-config", async ({ agentId, partial }) => {
      const { agent, error } = resolveAgentForBus(engine, agentId);
      if (error) return { error };
      if (typeof engine.updateConfig !== "function") return { error: "agent_update_unavailable" };
      await engine.updateConfig(partial || {}, { agentId });
      const { agent: fresh } = resolveAgentForBus(engine, agentId);
      return { config: fresh?.config || agent.config };
    }));

  }

  _setupDmHandler() {
    const engine = this._engine;
    // 给所有 agent 注入 DM 回调
    for (const [, agent] of engine.agents || []) {
      agent.setDmSentHandler((fromId, toId) =>
        this._dmRouter.handleNewDm(fromId, toId));
    }
  }

}

function matchesAgentPhoneAbortFilter( meta: any = {}, filter = null) {
  if (!filter) return true;
  if (typeof filter === "function") return filter(meta);
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    if (meta?.[key] !== value) return false;
  }
  return true;
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolvePluginSessionTarget(engine, payload: any = {}, operation = "session", options: any = {}) {
  const rawRef = payload?.sessionRef && typeof payload.sessionRef === "object"
    ? payload.sessionRef
    : null;
  const sessionId = textOrNull(payload?.sessionId) || textOrNull(rawRef?.sessionId);
  const inputPath =
    textOrNull(payload?.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const legacySessionPath =
    textOrNull(payload?.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && inputPath ? inputPath : null);

  let sessionPath = inputPath;
  if (sessionId) {
    const resolved = engine.resolveSessionRef?.({
      sessionId,
      sessionPath: inputPath,
      legacySessionPath,
    });
    sessionPath =
      textOrNull(resolved?.currentLocator?.path)
      || textOrNull(resolved?.sessionPath)
      || inputPath;
  }

  const resolvedSessionId = sessionId || (sessionPath ? engine.getSessionIdForPath?.(sessionPath) || null : null);
  if (!sessionPath) {
    if (options.required === false) return null;
    throw new Error(`${operation} requires sessionId or sessionPath`);
  }

  const sessionRef = resolvedSessionId
    ? {
      sessionId: resolvedSessionId,
      sessionPath,
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;

  return { sessionId: resolvedSessionId, sessionPath, sessionRef };
}

function resolveRequestedModel(engine, raw) {
  if (!raw) return undefined;
  const models = engine?.availableModels || engine?._models?.availableModels || engine?.models?.availableModels || [];
  if (typeof raw === "string") {
    const model = models.find((item) => item?.id === raw || item?.modelId === raw);
    if (!model) throw new Error(`model not found: ${raw}`);
    return model;
  }
  if (raw && typeof raw === "object") {
    const id = raw.id || raw.modelId || raw.model;
    const provider = raw.provider || raw.providerId;
    if (!id) throw new Error("model.id is required");
    const model = provider
      ? findModel(models, id, provider)
      : models.find((item) => item?.id === id || item?.modelId === id);
    if (!model) throw new Error(`model not found: ${provider ? `${provider}/` : ""}${id}`);
    return model;
  }
  throw new Error("model must be a string or { id, provider } object");
}

function publicAgentProfile(agent) {
  const config = agent?.config || {};
  const plugin = config.plugin && typeof config.plugin === "object" ? config.plugin : {};
  return {
    id: agent?.id || null,
    name: agent?.agentName || config.agent?.name || agent?.name || agent?.id || null,
    yuan: config.agent?.yuan || "luc",
    ownerPluginId: plugin.ownerPluginId || null,
    visibility: plugin.visibility || "public",
    identity: agent?.personality || agent?.identity || "",
    description: agent?.descriptionSource || "",
    memoryPolicy: {
      enabled: agent?.memoryMasterEnabled !== false,
    },
    experiencePolicy: {
      enabled: agent?.experienceEnabled === true,
    },
    toolPolicy: {
      disabled: Array.isArray(config.tools?.disabled) ? [...config.tools.disabled] : [],
    },
    models: config.models || {},
  };
}

function resolveAgentForBus(engine, agentId) {
  if (!agentId) return { error: "agent_id_required" };
  if (typeof engine?.getAgent !== "function") return { error: "agent_lookup_unavailable" };
  const agent = engine.getAgent(agentId);
  if (!agent) return { error: "not_found" };
  return { agent };
}

function hasDisplayImageAttachments(displayMessage) {
  const attachments = displayMessage?.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    if (!attachment?.path || attachment.isDir) return false;
    return inferFileKind({
      mime: attachment.mimeType,
      ext: extOfName(attachment.name || attachment.path),
      isDirectory: false,
    }) === "image";
  });
}

function hasDisplayVideoAttachments(displayMessage) {
  const attachments = displayMessage?.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    if (!attachment?.path || attachment.isDir) return false;
    return inferFileKind({
      mime: attachment.mimeType,
      ext: extOfName(attachment.name || attachment.path),
      isDirectory: false,
    }) === "video";
  });
}

function extensionForVideoMime(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "video/webm") return ".webm";
  if (normalized === "video/quicktime") return ".mov";
  return ".mp4";
}
