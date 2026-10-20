/**
 * browser-manager.js — 浏览器生命周期管理
 *
 * 单例模式。运行在 server 进程中，通过可插拔的 transport 层与
 * 浏览器宿主通信（IPC for fork 模式 / WS for spawn 模式）。
 *
 * 好处：
 * - 浏览器直接嵌在 Electron 窗口里，用户可以实时看到并交互
 * - Cookies / localStorage 由 Electron session 持久化
 * - 不依赖 Playwright（不需要下载 Chromium 二进制）
 *
 * session 绑定：
 * - 每个 chat session 可以独立拥有自己的浏览器实例
 * - 切换 session 时，浏览器被挂起（不销毁），切回来直接恢复
 * - 页面状态（表单、滚动位置等）完全保留
 * - 重启后保留冷保存的 URL，等待用户显式打开浏览器时恢复
 *
 * 多实例支持：
 * - 内部状态通过 Map 管理，每个 session identity 独立维护 running/url/headless
 * - 最多 MAX_INSTANCES 个并发浏览器，超出时 LRU 淘汰最久未用的
 *
 * snapshot 实现：主进程通过 webContents.executeJavaScript() 遍历 DOM，
 * 给交互元素注入 data-luc-ref 属性。
 */
import crypto from "crypto";
import os from "os";
import path from "path";
import fs from "fs";
import { atomicWriteSync } from "../../shared/safe-fs.ts";
import { t } from "../i18n.ts";
import { IpcTransport, WsTransport } from "./browser-transport.ts";
import { createModuleLogger } from "../debug-log.ts";
import {
  mergeBrowserPreferences,
  normalizeBrowserPreferences,
} from "../../shared/browser-preferences.ts";

const log = createModuleLogger("browser");

// ── 单例 ──
let _instance = null;

// 冷保存文件：重启后恢复浏览器状态（由 setLucHome 注入路径）
let _lucHome = null;
const _coldStatePath = () => path.join(_lucHome, "user", "browser-sessions.json");

// 最大并发浏览器实例数
const MAX_INSTANCES = 5;

// 双闲置回收：agent 最后一次操作与用户最后一次相关交互都超过这个时长，才把浏览器冷保存挂起
const IDLE_RECLAIM_MS = 30 * 60_000;
// 闲置巡检间隔
const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;

const FATAL_BROWSER_ERROR_PATTERNS = [
  /object has been destroyed/i,
  /no browser instance/i,
  /render process gone/i,
  /webcontents?.*destroy/i,
  /web contents?.*destroy/i,
  /target closed/i,
];

function _errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

function _isFatalBrowserHostError(error) {
  const msg = _errorMessage(error);
  return FATAL_BROWSER_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

function assertBrowserImageBase64(base64, action) {
  if (typeof base64 === "string" && base64.length > 0) return base64;
  throw new Error(`[browser] ${action} returned no image data. The browser capture produced an empty image.`);
}

function createBrowserTab(seed: any = {}) {
  const now = Date.now();
  return {
    tabId: String(seed.tabId || crypto.randomUUID()),
    title: typeof seed.title === "string" && seed.title.trim() ? seed.title : "New Tab",
    url: typeof seed.url === "string" && seed.url.length > 0 ? seed.url : null,
    canGoBack: seed.canGoBack === true,
    canGoForward: seed.canGoForward === true,
    createdAt: Number.isFinite(Number(seed.createdAt)) ? Number(seed.createdAt) : now,
    updatedAt: Number.isFinite(Number(seed.updatedAt)) ? Number(seed.updatedAt) : now,
  };
}

function cloneBrowserTab(tab: any) {
  return createBrowserTab(tab);
}

function normalizeBrowserTabs(value: any, fallbackUrl: any = null) {
  const tabs = Array.isArray(value)
    ? value.map(tab => createBrowserTab(tab)).filter(tab => tab.tabId)
    : [];
  if (tabs.length > 0) return tabs;
  return [createBrowserTab({ url: fallbackUrl })];
}

function activeBrowserTab(entry: any) {
  if (!entry || !Array.isArray(entry.tabs) || entry.tabs.length === 0) return null;
  return entry.tabs.find((tab) => tab.tabId === entry.activeTabId) || entry.tabs[0] || null;
}

function activeBrowserUrl(entry: any) {
  return activeBrowserTab(entry)?.url || entry?.url || null;
}

function workspaceHasRestorableUrl(workspace: any) {
  if (typeof workspace?.url === "string" && workspace.url.length > 0) return true;
  return Array.isArray(workspace?.tabs)
    && workspace.tabs.some((tab) => typeof tab?.url === "string" && tab.url.length > 0);
}

function normalizeColdWorkspace(raw: any) {
  if (typeof raw === "string") {
    const tabs = raw ? [createBrowserTab({ url: raw })] : [];
    return { activeTabId: tabs[0]?.tabId || null, tabs, url: raw || null };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const tabs = normalizeBrowserTabs(raw.tabs, raw.url || null);
    const activeTabId = typeof raw.activeTabId === "string" && tabs.some(tab => tab.tabId === raw.activeTabId)
      ? raw.activeTabId
      : tabs[0]?.tabId || null;
    const active = tabs.find(tab => tab.tabId === activeTabId) || tabs[0] || null;
    return {
      activeTabId,
      tabs,
      url: active?.url || tabs.find(tab => tab.url)?.url || raw.url || null,
    };
  }
  return { activeTabId: null, tabs: [], url: null };
}

function serializeColdWorkspace(entry: any) {
  const tabs = Array.isArray(entry?.tabs) ? entry.tabs.map(cloneBrowserTab) : [];
  const activeTabId = entry?.activeTabId && tabs.some(tab => tab.tabId === entry.activeTabId)
    ? entry.activeTabId
    : tabs[0]?.tabId || null;
  const active = tabs.find(tab => tab.tabId === activeTabId) || tabs[0] || null;
  return {
    activeTabId,
    tabs,
    url: active?.url || null,
  };
}

export class BrowserManager {
  declare _headless: any;
  declare _lruOrder: any;
  declare _pending: any;
  declare _browserPreferences: any;
  declare _getSessionIdForPath: any;
  declare _sessions: any;
  declare _transport: any;
  declare _revokedSessions: any;
  declare _userActivityAt: any;
  declare _idleSweepTimer: any;
  constructor({ getSessionIdForPath = null }: any = {}) {
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : null;
    this._sessions = new Map(); // session identity key → { sessionPath, running, url, headless }
    this._lruOrder = [];        // session identity key[], 最近使用的在末尾
    this._headless = false;     // 全局后台模式标记
    this._pending = new Map();  // id → { resolve, reject, timer }
    this._revokedSessions = new Set(); // session identity key，用户急停后拒绝 agent 再次使用浏览器
    this._userActivityAt = new Map();  // session identity key → 用户最后一次相关交互时间戳
    this._idleSweepTimer = null;       // 双闲置回收巡检定时器（无 running 浏览器时自停）
    this._browserPreferences = normalizeBrowserPreferences({});

    // 根据环境选择 transport：fork 模式用 IPC，spawn 模式用 WS
    this._transport = process.send ? new IpcTransport() : new WsTransport();

    // 注册消息处理器（IPC 立即生效，WS 在 attach 时生效）
    this._transport.onMessage((msg) => {
      // viewer 直连主进程的标签页增删会绕过 server，主进程把快照推回来防止状态漂移。
      // 空 tabs 是合法状态（空标签组仍是活着的 workspace），不改 running。
      if (msg?.type === "browser-workspace-sync" && msg.sessionPath) {
        const entry = this._getSessionEntry(msg.sessionPath);
        if (!entry) return;
        const tabs = Array.isArray(msg.workspace?.tabs) ? msg.workspace.tabs : [];
        entry.tabs = tabs.map((tab) => createBrowserTab(tab));
        entry.activeTabId = msg.workspace?.activeTabId || entry.tabs[0]?.tabId || null;
        // 空标签组没有 url（徽章因此隐藏），不保留上一个标签页的地址
        entry.url = activeBrowserTab(entry)?.url || null;
        return;
      }
      // 用户在 viewer 里的交互（打开窗口、聚焦、工具栏操作）：刷新用户侧闲置计时
      if (msg?.type === "browser-user-activity" && msg.sessionPath) {
        this._touchUserActivity(msg.sessionPath);
        return;
      }
      if (msg?.type === "browser-result" && this._pending.has(msg.id)) {
        const entry = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });
  }

  /** 获取单例 */
  static instance() {
    if (!_instance) _instance = new BrowserManager();
    return _instance;
  }

  /**
   * 注入用户数据根目录（由入口在启动时调用）
   * @param {string} home - engine.luccodeHome
   */
  static setLucHome(home) {
    _lucHome = home;
  }

  static setSessionIdResolver(resolver) {
    BrowserManager.instance().setSessionIdResolver(resolver);
  }

  setSessionIdResolver(resolver) {
    this._getSessionIdForPath = typeof resolver === "function" ? resolver : null;
  }

  _sessionKeyForPath(sessionPath) {
    if (!sessionPath) return sessionPath;
    try {
      const sessionId = this._getSessionIdForPath?.(sessionPath);
      return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : sessionPath;
    } catch (err) {
      log.warn(`browser session identity lookup failed for ${path.basename(sessionPath)}: ${_errorMessage(err)}`);
      return sessionPath;
    }
  }

  _coldStateLookupKeys(sessionPath, coldState: any = null) {
    if (!sessionPath) return [];
    const identityKey = this._sessionKeyForPath(sessionPath);
    const keys = new Set([identityKey, sessionPath].filter(Boolean));

    if (!coldState || typeof coldState !== "object") return [...keys];

    for (const [storedKey, raw] of Object.entries(coldState)) {
      const storedPath = typeof (raw as any)?.sessionPath === "string" && (raw as any).sessionPath
        ? (raw as any).sessionPath
        : storedKey;
      const storedIdentityKey = this._sessionKeyForPath(storedPath);
      const storedMapKeyIdentity = this._sessionKeyForPath(storedKey);
      if (storedIdentityKey === identityKey || storedMapKeyIdentity === identityKey) {
        keys.add(storedKey);
        if (storedPath) keys.add(storedPath);
      }
    }

    return [...keys];
  }

  _coldStateRecordForSession(coldState, sessionPath) {
    if (!coldState || typeof coldState !== "object") return null;
    for (const key of this._coldStateLookupKeys(sessionPath, coldState)) {
      if (Object.prototype.hasOwnProperty.call(coldState, key)) {
        return { key, raw: coldState[key] };
      }
    }
    return null;
  }

  _deleteColdStateKeysForSession(coldState, sessionPath, keepKey = null) {
    if (!coldState || typeof coldState !== "object") return;
    for (const key of this._coldStateLookupKeys(sessionPath, coldState)) {
      if (key !== keepKey) delete coldState[key];
    }
  }

  _getSessionEntry(sessionPath) {
    const key = this._sessionKeyForPath(sessionPath);
    return this._sessions.get(key) || (key !== sessionPath ? this._sessions.get(sessionPath) : null) || null;
  }

  _setSessionEntry(sessionPath, entry) {
    const key = this._sessionKeyForPath(sessionPath);
    this._sessions.set(key, { ...entry, sessionPath });
    if (key !== sessionPath) this._sessions.delete(sessionPath);
    return key;
  }

  _deleteSessionEntry(sessionPath) {
    const key = this._sessionKeyForPath(sessionPath);
    const deleted = this._sessions.delete(key);
    const legacyDeleted = key !== sessionPath ? this._sessions.delete(sessionPath) : false;
    return deleted || legacyDeleted;
  }

  // ════════════════════════════
  //  per-session 状态查询
  // ════════════════════════════

  /**
   * 指定 session 是否正在运行
   * @param {string} sessionPath
   * @returns {boolean}
   */
  isRunning(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    return !!(entry && entry.running && entry.health !== "unhealthy");
  }

  /**
   * 指定 session 当前页面 URL
   * @param {string} sessionPath
   * @returns {string|null}
   */
  currentUrl(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    return activeBrowserUrl(entry);
  }

  /** 任意 session 是否在运行 */
  get hasAnyRunning() {
    for (const sp of this._sessions.keys()) {
      if (this.isRunning(sp)) return true;
    }
    return false;
  }

  /** 返回所有 running session 的 sessionPath 数组 */
  get runningSessions() {
    const result = [];
    for (const [key, entry] of this._sessions) {
      const sessionPath = entry?.sessionPath || key;
      if (this.isRunning(sessionPath)) result.push(sessionPath);
    }
    return result;
  }

  sessionUnavailableReason(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    return entry?.health === "unhealthy" ? entry.unavailableReason || null : null;
  }

  _browserUnavailableError(sessionPath) {
    const reason = this.sessionUnavailableReason(sessionPath);
    const msg = t("error.browserSessionUnavailable", { reason: reason ? `: ${reason}` : "" });
    const error: any = new Error(msg);
    error.code = "BROWSER_SESSION_UNAVAILABLE";
    error.browserFatal = true;
    error.sessionPath = sessionPath;
    return error;
  }

  _assertSessionUsable(sessionPath) {
    if (this.sessionUnavailableReason(sessionPath)) {
      throw this._browserUnavailableError(sessionPath);
    }
  }

  _markSessionUnavailable(sessionPath, error) {
    if (!sessionPath) return;
    const existing = this._getSessionEntry(sessionPath) || {
      running: false,
      url: null,
      activeTabId: null,
      tabs: [],
      headless: this._headless,
    };
    this._setSessionEntry(sessionPath, {
      ...existing,
      running: false,
      health: "unhealthy",
      unavailableReason: _errorMessage(error),
      unavailableAt: new Date().toISOString(),
    });
    this._removeLru(sessionPath);
  }

  _clearSessionUnavailable(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    if (!entry) return;
    delete entry.health;
    delete entry.unavailableReason;
    delete entry.unavailableAt;
  }

  async _sendSessionCmd(cmd, params: any = {}, timeoutMs?): Promise<any> {
    const sessionPath = params.sessionPath || null;
    this._assertSessionUsable(sessionPath);
    try {
      return timeoutMs == null
        ? await this._sendCmd(cmd, params)
        : await this._sendCmd(cmd, params, timeoutMs);
    } catch (error) {
      if (_isFatalBrowserHostError(error)) {
        this._markSessionUnavailable(sessionPath, error);
      }
      throw error;
    }
  }

  /** 是否后台模式 */
  get isHeadless() {
    return this._headless;
  }

  /** 设置后台模式（后台任务调用前设 true，结束后设 false） */
  setHeadless(val) {
    this._headless = !!val;
  }

  // ════════════════════════════
  //  LRU 管理
  // ════════════════════════════

  /** 将 sessionPath 移到 LRU 末尾（最近使用） */
  _touchLru(sessionPath) {
    const key = this._sessionKeyForPath(sessionPath);
    const idx = this._lruOrder.indexOf(key);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
    this._lruOrder.push(key);
    // agent 的每次浏览器操作都过这里：盖上 agent 侧闲置计时的时间戳
    const entry = this._sessions.get(key);
    if (entry) entry.lastAgentOpAt = Date.now();
  }

  /** 记录用户侧的浏览器相关交互时间（viewer 打开/聚焦/工具栏操作、切到该 session） */
  _touchUserActivity(sessionPath) {
    if (!sessionPath) return;
    this._userActivityAt.set(this._sessionKeyForPath(sessionPath), Date.now());
  }

  // ════════════════════════════
  //  双闲置回收
  // ════════════════════════════

  /** 确保闲置巡检定时器在跑（有 running 浏览器时才需要） */
  _ensureIdleSweep() {
    if (this._idleSweepTimer) return;
    this._idleSweepTimer = setInterval(() => { void this._sweepIdleSessions(); }, IDLE_SWEEP_INTERVAL_MS);
    this._idleSweepTimer.unref?.();
  }

  /**
   * 巡检一轮：agent 与用户都超过 IDLE_RECLAIM_MS 没碰过的 running 浏览器，
   * suspend 冷保存（写盘 + view 进程退出），不销毁标签组。
   * viewer 当前可见展示的 session 豁免——用户可能正在读页面。
   */
  async _sweepIdleSessions() {
    const running = this.runningSessions;
    if (running.length === 0) {
      clearInterval(this._idleSweepTimer);
      this._idleSweepTimer = null;
      return;
    }
    let viewer: any = { visible: false, sessionPath: null };
    // 查不到 viewer 状态（无 host / 超时）按不可见处理，不因此跳过回收
    try { viewer = await this._sendCmd("viewerVisibility", {}, 10000); } catch {}
    const now = Date.now();
    for (const sp of running) {
      const key = this._sessionKeyForPath(sp);
      const entry = this._sessions.get(key);
      if (!entry) continue;
      if (viewer?.visible && viewer.sessionPath && this._sessionKeyForPath(viewer.sessionPath) === key) continue;
      const lastAgent = entry.lastAgentOpAt || 0;
      const lastUser = this._userActivityAt.get(key) || 0;
      if (now - Math.max(lastAgent, lastUser) < IDLE_RECLAIM_MS) continue;
      log.log(`双闲置回收（suspend 冷保存）: ${sp}`);
      try { await this.suspendForSession(sp); } catch (err) { log.warn(`idle suspend failed: ${_errorMessage(err)}`); }
    }
  }

  /** 移除 sessionPath 从 LRU 列表 */
  _removeLru(sessionPath) {
    const key = this._sessionKeyForPath(sessionPath);
    const idx = this._lruOrder.indexOf(key);
    if (idx !== -1) this._lruOrder.splice(idx, 1);
    if (key !== sessionPath) {
      const legacyIdx = this._lruOrder.indexOf(sessionPath);
      if (legacyIdx !== -1) this._lruOrder.splice(legacyIdx, 1);
    }
  }

  /** 淘汰最久未用的 running session（挂起它），返回是否成功 */
  async _evictLru() {
    // 从 LRU 头部找第一个 running 的 session 淘汰
    for (const key of this._lruOrder) {
      const entry = this._sessions.get(key);
      const sp = entry?.sessionPath || key;
      if (this.isRunning(sp)) {
        log.log(`LRU 淘汰: ${sp}`);
        await this.suspendForSession(sp);
        return true;
      }
    }
    log.warn("LRU eviction found no running session to evict");
    return false;
  }

  // ════════════════════════════
  //  冷保存（磁盘持久化）
  // ════════════════════════════

  _loadColdState() {
    try {
      return JSON.parse(fs.readFileSync(_coldStatePath(), "utf-8"));
    } catch {
      return {};
    }
  }

  _saveColdState(state) {
    try {
      atomicWriteSync(_coldStatePath(), JSON.stringify(state, null, 2) + "\n");
    } catch {}
  }

  _saveColdUrl(sessionPath, url) {
    if (!sessionPath || !url) return;
    const key = this._sessionKeyForPath(sessionPath);
    const state = this._loadColdState();
    const liveEntry = this._getSessionEntry(sessionPath);
    if (liveEntry && Array.isArray(liveEntry.tabs) && liveEntry.tabs.length > 0) {
      state[key] = { ...serializeColdWorkspace(liveEntry), sessionPath };
      this._deleteColdStateKeysForSession(state, sessionPath, key);
      this._saveColdState(state);
      return;
    }
    const coldRecord = this._coldStateRecordForSession(state, sessionPath);
    const existing = normalizeColdWorkspace(coldRecord?.raw);
    const tabs = existing.tabs.length > 0 ? existing.tabs : [createBrowserTab({ url })];
    const activeTabId = existing.activeTabId || tabs[0]?.tabId || null;
    const active = tabs.find(tab => tab.tabId === activeTabId) || tabs[0];
    if (active) {
      active.url = url;
      active.updatedAt = Date.now();
    }
    state[key] = { ...serializeColdWorkspace({ activeTabId, tabs }), sessionPath };
    this._deleteColdStateKeysForSession(state, sessionPath, key);
    this._saveColdState(state);
  }

  _saveColdWorkspace(sessionPath, entry) {
    if (!sessionPath) return;
    const key = this._sessionKeyForPath(sessionPath);
    const state = this._loadColdState();
    const workspace = serializeColdWorkspace(entry);
    if (!workspaceHasRestorableUrl(workspace)) {
      delete state[key];
      this._deleteColdStateKeysForSession(state, sessionPath);
    } else {
      state[key] = { ...workspace, sessionPath };
      this._deleteColdStateKeysForSession(state, sessionPath, key);
    }
    this._saveColdState(state);
  }

  _removeColdUrl(sessionPath) {
    if (!sessionPath) return;
    const state = this._loadColdState();
    this._deleteColdStateKeysForSession(state, sessionPath);
    this._saveColdState(state);
  }

  /**
   * Copy the source tab workspace into an independent cold-resume record.
   * A live browser view/process is never shared with the child session.
   */
  forkSessionState({
    sourceSessionPath,
    targetSessionPath,
    includeSourceState = true,
  }: Record<string, any> = {}) {
    if (!sourceSessionPath) throw new Error("browser session fork requires sourceSessionPath");
    if (!targetSessionPath) throw new Error("browser session fork requires targetSessionPath");
    if (sourceSessionPath === targetSessionPath) {
      throw new Error("browser session fork requires distinct source and target paths");
    }

    // The browser workspace is a current-state projection, not an event-sourced
    // snapshot. A historical fork must not copy tabs opened after its boundary.
    if (includeSourceState !== true) {
      return { copied: false, tabs: 0, url: null, reason: "historical_boundary" };
    }

    const state = this._loadColdState();
    if (this._getSessionEntry(targetSessionPath) || this._coldStateRecordForSession(state, targetSessionPath)) {
      throw new Error("browser session fork target state already exists");
    }
    const sourceLive = this._getSessionEntry(sourceSessionPath);
    const sourceCold = this._coldStateRecordForSession(state, sourceSessionPath);
    const workspace = sourceLive && Array.isArray(sourceLive.tabs) && sourceLive.tabs.length > 0
      ? serializeColdWorkspace(sourceLive)
      : normalizeColdWorkspace(sourceCold?.raw);
    if (!workspaceHasRestorableUrl(workspace)) {
      return { copied: false, tabs: 0, url: null };
    }

    const targetKey = this._sessionKeyForPath(targetSessionPath);
    state[targetKey] = {
      ...serializeColdWorkspace(workspace),
      sessionPath: targetSessionPath,
    };
    this._deleteColdStateKeysForSession(state, targetSessionPath, targetKey);
    this._saveColdState(state);
    if (!this._coldStateRecordForSession(this._loadColdState(), targetSessionPath)) {
      throw new Error("browser session fork target state could not be persisted");
    }
    return {
      copied: true,
      tabs: workspace.tabs.length,
      url: workspace.url,
    };
  }

  discardForkedSessionState({ sessionPath }: Record<string, any> = {}) {
    if (!sessionPath) throw new Error("browser session fork cleanup requires sessionPath");
    if (this.isRunning(sessionPath)) {
      throw new Error("cannot discard a running forked browser session");
    }
    const state = this._loadColdState();
    const existing = this._coldStateRecordForSession(state, sessionPath);
    this._deleteColdStateKeysForSession(state, sessionPath);
    if (existing) this._saveColdState(state);
    this._deleteSessionEntry(sessionPath);
    this._removeLru(sessionPath);
    return { discarded: !!existing };
  }

  /**
   * 获取所有有浏览器的 session（活跃 + 冷保存）
   * @returns {{ [sessionPath: string]: string }} sessionPath → url
   */
  getBrowserSessions() {
    const states = this.getBrowserSessionStates();
    return Object.fromEntries(
      Object.entries(states)
        .filter(([, state]: [string, any]) => typeof state.url === "string" && state.url.length > 0)
        .map(([sessionPath, state]: [string, any]) => [sessionPath, state.url]),
    );
  }

  /**
   * 获取所有有浏览器痕迹的 session 状态（活跃 + 可恢复冷状态 + 不可用状态）。
   * @returns {{ [sessionPath: string]: { url: string|null, running: boolean, resumable: boolean, unavailableReason: string|null } }}
   */
  getBrowserSessionStates() {
    const coldState = this._loadColdState();
    const result: any = {};
    const liveIdentityKeys = new Set();

    for (const [identityKey, entry] of this._sessions) {
      liveIdentityKeys.add(identityKey);
      const sessionPath = entry?.sessionPath || identityKey;
      liveIdentityKeys.add(this._sessionKeyForPath(sessionPath));
    }

    for (const [identityKey, raw] of Object.entries(coldState)) {
      const cold = normalizeColdWorkspace(raw);
      if (!workspaceHasRestorableUrl(cold)) continue;
      const sessionPath = typeof (raw as any)?.sessionPath === "string" && (raw as any).sessionPath
        ? (raw as any).sessionPath
        : identityKey;
      if (liveIdentityKeys.has(this._sessionKeyForPath(sessionPath))) continue;
      result[sessionPath] = {
        url: cold.url,
        running: false,
        resumable: true,
        unavailableReason: null,
      };
    }

    for (const [identityKey, entry] of this._sessions) {
      const sessionPath = entry?.sessionPath || identityKey;
      const coldRecord = this._coldStateRecordForSession(coldState, sessionPath);
      const cold = normalizeColdWorkspace(coldRecord?.raw);
      const url = activeBrowserUrl(entry) || cold.url || null;
      if (entry.health === "unhealthy") {
        result[sessionPath] = {
          url,
          running: false,
          resumable: false,
          unavailableReason: entry.unavailableReason || null,
        };
        continue;
      }
      if (!url) continue;
      result[sessionPath] = {
        url,
        running: this.isRunning(sessionPath),
        resumable: true,
        unavailableReason: null,
      };
    }

    return result;
  }

  // ════════════════════════════
  //  Transport
  // ════════════════════════════

  /**
   * 注入 WS transport（server 启动时调用）
   * @param {import("ws").WebSocket|null} ws
   */
  setWsTransport(ws) {
    const transport = this._transport;
    if (transport instanceof WsTransport) {
      if (ws) {
        transport.attach(ws);
        this.syncBrowserPreferences().catch((err) => {
          log.warn(`failed to sync browser preferences: ${_errorMessage(err)}`);
        });
      } else {
        transport.detach();
      }
    }
  }

  getBrowserPreferences() {
    return normalizeBrowserPreferences(this._browserPreferences);
  }

  setBrowserPreferences(partial) {
    this._browserPreferences = mergeBrowserPreferences(this._browserPreferences, partial || {});
    if (this._transport.connected) {
      this._sendCmd("setAcceptCookies", { enabled: this._browserPreferences.acceptCookies }, 10000)
        .catch((err) => log.warn(`failed to apply browser Cookie setting: ${_errorMessage(err)}`));
    }
    return this.getBrowserPreferences();
  }

  async syncBrowserPreferences() {
    if (!this._transport.connected) return this.getBrowserPreferences();
    await this._sendCmd("setAcceptCookies", { enabled: this._browserPreferences.acceptCookies }, 10000);
    return this.getBrowserPreferences();
  }

  async clearBrowserCookiesAndSiteData() {
    await this._sendCmd("clearBrowserCookiesAndSiteData", {}, 30000);
    return { ok: true };
  }

  get browserHostConnected() {
    return this._transport.connected === true;
  }

  resumeReadinessForSession(sessionPath) {
    const hostConnected = this.browserHostConnected;
    if (!sessionPath) {
      return {
        canResume: false,
        reason: "missing_session_path",
        hostConnected,
        hasResumeState: false,
        running: false,
        url: null,
      };
    }

    const existing = this._getSessionEntry(sessionPath);
    const running = this.isRunning(sessionPath);
    const coldState = this._loadColdState();
    const coldRecord = this._coldStateRecordForSession(coldState, sessionPath);
    const cold = normalizeColdWorkspace(coldRecord?.raw);
    const url = activeBrowserUrl(existing) || cold.url || null;
    const hasResumeState = !!existing || workspaceHasRestorableUrl(cold);

    if (running) {
      return {
        canResume: false,
        reason: "already_running",
        hostConnected,
        hasResumeState: true,
        running: true,
        url,
      };
    }
    if (existing?.health === "unhealthy") {
      return {
        canResume: false,
        reason: "browser_session_unavailable",
        hostConnected,
        hasResumeState: true,
        running: false,
        url,
        unavailableReason: existing.unavailableReason || null,
      };
    }
    if (!hasResumeState) {
      return {
        canResume: false,
        reason: "no_browser_state",
        hostConnected,
        hasResumeState: false,
        running: false,
        url: null,
      };
    }
    if (!hostConnected) {
      return {
        canResume: false,
        reason: "browser_host_unavailable",
        hostConnected,
        hasResumeState: true,
        running: false,
        url,
      };
    }
    return {
      canResume: true,
      reason: null,
      hostConnected,
      hasResumeState: true,
      running: false,
      url,
    };
  }

  async resumeForSessionIfAvailable(sessionPath) {
    const readiness = this.resumeReadinessForSession(sessionPath);
    if (!readiness.canResume) {
      return { status: "skipped", ...readiness };
    }

    if (this.runningSessions.length >= MAX_INSTANCES) {
      await this._evictLru();
    }

    const result = await this._sendCmd("resume", { sessionPath });
    if (!result?.found) {
      return {
        status: "skipped",
        ...readiness,
        canResume: false,
        reason: "cold_resume_deferred",
        running: false,
      };
    }

    const entry = this._applyWorkspaceResult(sessionPath, result, { running: true });
    entry.headless = this._headless;
    this._saveColdWorkspace(sessionPath, entry);
    this._touchLru(sessionPath);
    this._touchUserActivity(sessionPath);
    this._ensureIdleSweep();
    log.log(`热恢复成功 ${sessionPath}`);

    return {
      status: "resumed",
      ...this.resumeReadinessForSession(sessionPath),
      running: this.isRunning(sessionPath),
      url: this.currentUrl(sessionPath),
    };
  }

  /**
   * 向浏览器宿主发送命令并等待结果
   * @param {string} cmd - 命令名
   * @param {object} params - 参数
   * @param {number} timeoutMs - 超时（默认 30s）
   * @returns {Promise<any>}
   */
  _sendCmd(cmd, params: any = {}, timeoutMs = 30000): Promise<any> {
    if (!this._transport.connected) {
      throw new Error(t("error.browserDesktopOnly"));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(t("error.browserCmdTimeout", { cmd })));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._transport.send({ type: "browser-cmd", id, cmd, params });
    });
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  async launch(sessionPath) {
    // 已在运行 → 直接返回
    const existing = this._getSessionEntry(sessionPath);
    if (this.isRunning(sessionPath)) {
      this._touchLru(sessionPath);
      return;
    }

    if (existing?.health === "unhealthy") {
      try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
    }

    // 并发数检查：running 数量 ≥ MAX_INSTANCES → LRU 淘汰
    if (this.runningSessions.length >= MAX_INSTANCES) {
      const evicted = await this._evictLru();
      if (!evicted && this.runningSessions.length >= MAX_INSTANCES) {
        throw new Error(`Browser limit reached: max ${MAX_INSTANCES} concurrent instances`);
      }
    }

    const result = await this._sendCmd("launch", {
      sessionPath,
      headless: this._headless,
      acceptCookies: this._browserPreferences.acceptCookies,
    });

    const entry = this._applyWorkspaceResult(sessionPath, result, { running: true });
    entry.headless = this._headless;
    this._clearSessionUnavailable(sessionPath);
    this._touchLru(sessionPath);

    log.log(`浏览器已启动 ${sessionPath} ${this._headless ? "(headless)" : ""}`);
    this._ensureIdleSweep();
  }

  async close(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    if (!entry) return;

    if (!this.isRunning(sessionPath)) {
      try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
      this._deleteSessionEntry(sessionPath);
      this._removeLru(sessionPath);
      this._removeColdUrl(sessionPath);
      log.log(`浏览器已关闭 ${sessionPath}`);
      return;
    }

    try { await this._sendCmd("close", { sessionPath }); } catch {}

    // 从 Map 和 LRU 中移除
    this._deleteSessionEntry(sessionPath);
    this._removeLru(sessionPath);
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);

    log.log(`浏览器已关闭 ${sessionPath}`);
  }

  /**
   * 挂起浏览器：从窗口上摘下来，但不销毁（页面状态完全保留）
   * 同时写入冷保存，确保重启后也能恢复
   * @param {string} sessionPath - 目标 session 路径
   * @param {object} [options]
   * @param {boolean} [options.keepViewerVisible] - 挂起后不隐藏 viewer 窗口。
   *   会话切换用：窗口保持可见，由随后的 notifyViewerSession 重绘目标 session。
   */
  async suspendForSession(sessionPath, { keepViewerVisible = false } = {}) {
    const entry = this._getSessionEntry(sessionPath);
    if (!entry || !this.isRunning(sessionPath)) return;

    this._saveColdWorkspace(sessionPath, entry);
    log.log(`挂起浏览器 ${sessionPath}`);
    try { await this._sendCmd("suspend", { sessionPath, keepViewerVisible }); } catch {}

    // 挂起完成，冷状态已写磁盘，从 Map 中移除避免僵尸条目累积
    this._deleteSessionEntry(sessionPath);
    this._removeLru(sessionPath);
  }

  /**
   * 通知 viewer 现在展示哪个 session 的标签页组（不改变窗口可见性）。
   * 没有 browser host 的环境（server / PWA）里 transport 未连接，静默跳过。
   * @param {string} sessionPath - 目标 session 路径
   * @param {string|null} [title] - 会话标题，显示在 viewer 工具栏
   */
  async notifyViewerSession(sessionPath, title = null) {
    if (!sessionPath) return;
    try {
      await this._sendCmd("viewerShowSession", { sessionPath, title }, 10000);
    } catch (err) {
      log.warn(`viewerShowSession failed: ${_errorMessage(err)}`);
    }
  }

  /**
   * 恢复浏览器：先尝试热恢复（view 还活着），失败则冷恢复（launch + navigate）
   * @param {string} sessionPath - 目标 session 路径
   */
  async resumeForSession(sessionPath) {
    if (!sessionPath) return;

    // 已经在运行 → 刷新 LRU 即可
    const existing = this._getSessionEntry(sessionPath);
    if (this.isRunning(sessionPath)) {
      this._touchLru(sessionPath);
      this._touchUserActivity(sessionPath);
      this._ensureIdleSweep();
      return;
    }
    if (existing?.health === "unhealthy") return;

    // 没有运行中的浏览器时，检查冷状态；无冷状态则跳过
    const coldState = this._loadColdState();
    const coldRecord = this._coldStateRecordForSession(coldState, sessionPath);
    if (!existing && !coldRecord) return;

    // 并发数检查
    const runningCount = this.runningSessions.length;
    if (runningCount >= MAX_INSTANCES) {
      await this._evictLru();
    }

    // 1. 热恢复：view 还在内存中
    const result = await this._sendCmd("resume", { sessionPath });
    if (result.found) {
      const entry = this._applyWorkspaceResult(sessionPath, result, { running: true });
      entry.headless = this._headless;
      this._saveColdWorkspace(sessionPath, entry);
      this._touchLru(sessionPath);
      this._touchUserActivity(sessionPath);
      this._ensureIdleSweep();
      log.log(`热恢复成功 ${sessionPath}`);
      return;
    }

    // 2. 冷恢复：从磁盘读 workspace，重新 launch
    const savedWorkspace = normalizeColdWorkspace(coldRecord?.raw);
    if (!workspaceHasRestorableUrl(savedWorkspace)) return;

    log.log(`冷恢复 ${sessionPath}`);
    const launchResult = await this._sendCmd("launch", {
      sessionPath,
      tabs: savedWorkspace.tabs,
      activeTabId: savedWorkspace.activeTabId,
      acceptCookies: this._browserPreferences.acceptCookies,
    });
    const entry = this._applyWorkspaceResult(sessionPath, Array.isArray(launchResult?.tabs) ? launchResult : savedWorkspace, { running: true });
    entry.headless = this._headless;
    this._saveColdWorkspace(sessionPath, entry);
    this._touchLru(sessionPath);
    this._touchUserActivity(sessionPath);
    this._ensureIdleSweep();
  }

  /**
   * 关闭指定 session 的浏览器（从卡片上的关闭按钮调用）
   * @param {string} sessionPath - 目标 session 路径
   */
  async closeBrowserForSession(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);

    // 如果是当前活跃的浏览器
    if (entry && this.isRunning(sessionPath)) {
      await this.close(sessionPath);
      return;
    }

    // 销毁挂起的 view
    try { await this._sendCmd("destroyView", { sessionPath }); } catch {}
    // 从 Map 和 LRU 中清理
    this._deleteSessionEntry(sessionPath);
    this._removeLru(sessionPath);
    // 从冷保存中移除
    this._removeColdUrl(sessionPath);
    log.log(`已关闭 session 浏览器 ${sessionPath}`);
  }

  /**
   * 用户急停后，标记该 session 的浏览器授权已被撤销（per-session，键为 session identity）。
   * 撤销期间 agent 的 browser 工具调用直接返回"用户已停止授权"，不再触碰浏览器。
   * @param {string} sessionPath - 目标 session 路径
   */
  revokeBrowserAuthorization(sessionPath) {
    if (!sessionPath) return;
    this._revokedSessions.add(this._sessionKeyForPath(sessionPath));
  }

  /** 解除该 session 的浏览器授权拒绝标记 */
  clearBrowserAuthorizationRevocation(sessionPath) {
    if (!sessionPath) return;
    const key = this._sessionKeyForPath(sessionPath);
    this._revokedSessions.delete(key);
    if (key !== sessionPath) this._revokedSessions.delete(sessionPath);
  }

  /** 该 session 的浏览器授权是否已被用户撤销 */
  isBrowserAuthorizationRevoked(sessionPath) {
    if (!sessionPath) return false;
    return this._revokedSessions.has(this._sessionKeyForPath(sessionPath));
  }

  _applyWorkspaceResult(sessionPath, result: any = {}, options: any = {}) {
    const existing = this._getSessionEntry(sessionPath) || {
      running: options.running !== false,
      url: null,
      activeTabId: null,
      tabs: [],
      headless: this._headless,
    };
    const sourceTabs = Array.isArray(result.tabs) ? result.tabs : existing.tabs;
    const tabs = normalizeBrowserTabs(sourceTabs, result.url || existing.url || null);
    const activeTabId = typeof result.activeTabId === "string" && tabs.some(tab => tab.tabId === result.activeTabId)
      ? result.activeTabId
      : typeof result.tabId === "string" && tabs.some(tab => tab.tabId === result.tabId)
        ? result.tabId
        : existing.activeTabId && tabs.some(tab => tab.tabId === existing.activeTabId)
          ? existing.activeTabId
          : tabs[0]?.tabId || null;
    const active = tabs.find(tab => tab.tabId === activeTabId) || tabs[0] || null;
    const entry = {
      ...existing,
      running: options.running ?? existing.running ?? true,
      headless: existing.headless ?? this._headless,
      activeTabId,
      tabs,
      url: active?.url || result.url || null,
    };
    this._setSessionEntry(sessionPath, entry);
    return entry;
  }

  _updateActiveTabFromResult(sessionPath, result: any = {}, tabId: string | null = null) {
    const existing = this._getSessionEntry(sessionPath);
    if (!existing) return null;
    if (Array.isArray(result.tabs)) {
      return this._applyWorkspaceResult(sessionPath, result);
    }
    const targetTabId = result.tabId || tabId || existing.activeTabId;
    const tabs = normalizeBrowserTabs(existing.tabs, existing.url);
    const target = tabs.find(tab => tab.tabId === targetTabId) || tabs[0] || null;
    if (target) {
      if (typeof result.url === "string") target.url = result.url;
      if (typeof result.currentUrl === "string") target.url = result.currentUrl;
      if (typeof result.title === "string" && result.title.trim()) target.title = result.title;
      if (typeof result.canGoBack === "boolean") target.canGoBack = result.canGoBack;
      if (typeof result.canGoForward === "boolean") target.canGoForward = result.canGoForward;
      target.updatedAt = Date.now();
    }
    const activeTabId = target?.tabId || existing.activeTabId || null;
    const entry = {
      ...existing,
      activeTabId,
      tabs,
      url: target?.url || existing.url || null,
    };
    this._setSessionEntry(sessionPath, entry);
    return entry;
  }

  getTabs(sessionPath) {
    const entry = this._getSessionEntry(sessionPath);
    if (!entry) return [];
    return (entry.tabs || []).map(cloneBrowserTab);
  }

  activeTab(sessionPath) {
    const tab = activeBrowserTab(this._getSessionEntry(sessionPath));
    return tab ? cloneBrowserTab(tab) : null;
  }

  async newTab(sessionPath, url = undefined) {
    if (!this.isRunning(sessionPath)) await this.launch(sessionPath);
    const params: any = { sessionPath, url };
    const result = await this._sendSessionCmd("newTab", params);
    const entry = this._applyWorkspaceResult(sessionPath, result);
    this._saveColdWorkspace(sessionPath, entry);
    this._touchLru(sessionPath);
    return this.activeTab(sessionPath);
  }

  async switchTab(sessionPath, tabId) {
    if (!tabId) throw new Error("browser switchTab requires tabId");
    const result = await this._sendSessionCmd("switchTab", { sessionPath, tabId });
    const entry = this._applyWorkspaceResult(sessionPath, result);
    this._saveColdWorkspace(sessionPath, entry);
    this._touchLru(sessionPath);
    return this.activeTab(sessionPath);
  }

  async closeTab(sessionPath, tabId) {
    if (!tabId) throw new Error("browser closeTab requires tabId");
    const result = await this._sendSessionCmd("closeTab", { sessionPath, tabId });
    if (Array.isArray(result?.tabs) && result.tabs.length === 0) {
      // 空标签组仍是活 workspace：保留 running 与 LRU 位置，等待新 tab；
      // 不能走 _applyWorkspaceResult（normalizeBrowserTabs 会给空列表捏造一个空白 tab）。
      const entry = this._getSessionEntry(sessionPath);
      const next = {
        ...(entry || {}),
        running: entry ? entry.running : true,
        url: null,
        activeTabId: null,
        tabs: [],
        headless: entry?.headless ?? this._headless,
      };
      this._setSessionEntry(sessionPath, next);
      // 空组没有可恢复 URL，_saveColdWorkspace 会顺带清掉冷记录
      this._saveColdWorkspace(sessionPath, next);
      this._touchLru(sessionPath);
      return null;
    }
    const entry = this._applyWorkspaceResult(sessionPath, result);
    this._saveColdWorkspace(sessionPath, entry);
    this._touchLru(sessionPath);
    return this.activeTab(sessionPath);
  }

  // ════════════════════════════
  //  导航
  // ════════════════════════════

  /**
   * @param {string} url
   * @param {string} sessionPath
   * @returns {Promise<{ url: string, title: string, snapshot: string }>}
   */
  async navigate(url, sessionPath, options: any = {}) {
    let tabId = typeof options.tabId === "string" && options.tabId ? options.tabId : null;
    if (!tabId && this._browserPreferences.agentOpenBehavior === "new_tab" && this.isRunning(sessionPath)) {
      const tab = await this.newTab(sessionPath);
      tabId = tab?.tabId || null;
    }
    const params: any = { url, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("navigate", params);
    const entry = this._updateActiveTabFromResult(sessionPath, result, tabId);
    this._saveColdUrl(sessionPath, result.url);
    this._touchLru(sessionPath);
    return {
      ...result,
      tabId: result.tabId || activeBrowserTab(entry)?.tabId || tabId || null,
    }; // { url, title, snapshot, tabId }
  }

  /**
   * Run a one-shot browser-backed search without registering a user-visible
   * browser session. This keeps web_search from stealing the normal browser
   * view or consuming the chat browser instance pool.
   * @param {{provider:string, query:string, maxResults?:number, locale?:string}} params
   */
  async searchWeb({ provider, query, maxResults = 5, locale }) {
    const payload: any = {
      provider,
      query,
      maxResults,
    };
    if (locale) payload.locale = locale;
    return await this._sendCmd("browserSearch", payload, 45000);
  }

  // ════════════════════════════
  //  感知
  // ════════════════════════════

  /**
   * @param {string} sessionPath
   * @returns {Promise<string>} 文本格式的页面树
   */
  async snapshot(sessionPath, tabId = null) {
    const params: any = { sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("snapshot", params);
    this._touchLru(sessionPath);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {string} sessionPath
   * @returns {Promise<{ base64: string, mimeType: string }>}
   */
  async screenshot(sessionPath, tabId = null) {
    const params: any = { sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("screenshot", params);
    return {
      base64: assertBrowserImageBase64(result?.base64, "screenshot"),
      mimeType: "image/jpeg",
    };
  }

  /**
   * @param {string} sessionPath
   * @returns {Promise<string|null>} 缩略图 base64
   */
  async thumbnail(sessionPath) {
    if (!this.isRunning(sessionPath)) return null;
    // 空标签组没有可截图的 tab：直接返回 null，别让 "No browser instance" 把 session 标成 unhealthy
    if (!activeBrowserTab(this._getSessionEntry(sessionPath))) return null;
    try {
      const result = await this._sendSessionCmd("thumbnail", { sessionPath });
      return assertBrowserImageBase64(result?.base64, "thumbnail");
    } catch {
      return null;
    }
  }

  // ════════════════════════════
  //  交互（每个操作后自动 snapshot）
  // ════════════════════════════

  /**
   * @param {number} ref
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async click(ref, sessionPath, tabId = null) {
    const params: any = { ref, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("click", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {string} text
   * @param {number} ref
   * @param {{ pressEnter?: boolean }} opts
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async type(text, ref, { pressEnter = false } = {}, sessionPath, tabId = null) {
    const params: any = { text, ref, pressEnter, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("type", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {string} direction
   * @param {number} amount
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async scroll(direction, amount = 3, sessionPath, tabId = null) {
    const params: any = { direction, amount, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("scroll", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {number} ref
   * @param {string} value
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async select(ref, value, sessionPath, tabId = null) {
    const params: any = { ref, value, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("select", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {string} key
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async pressKey(key, sessionPath, tabId = null) {
    const params: any = { key, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("pressKey", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  // ════════════════════════════
  //  辅助
  // ════════════════════════════

  /**
   * @param {object} opts
   * @param {string} sessionPath
   * @returns {Promise<string>} 新的 snapshot
   */
  async wait( opts: any = {}, sessionPath, tabId = null) {
    const params: any = { ...opts, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("wait", params);
    this._updateActiveTabFromResult(sessionPath, result, tabId);
    return result.text;
  }

  /**
   * @param {string} expression
   * @param {string} sessionPath
   * @returns {Promise<string>} 序列化的执行结果
   */
  async evaluate(expression, sessionPath, tabId = null) {
    const params: any = { expression, sessionPath };
    if (tabId) params.tabId = tabId;
    const result = await this._sendSessionCmd("evaluate", params);
    return result.value;
  }

  /**
   * 将浏览器 viewer 窗口置前
   * @param {string} sessionPath
   */
  async show(sessionPath, tabId = null) {
    const params: any = { sessionPath };
    if (tabId) params.tabId = tabId;
    await this._sendSessionCmd("show", params);
  }
}
