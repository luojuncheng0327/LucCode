/**
 * browser-tool.js — 浏览器控制工具
 *
 * 单一 tool，通过 action 字段选择子命令。
 * 感知主要基于 AXTree snapshot（文本，便宜），截图为辅助。
 *
 * 每个动作的 details 都包含 { running, url, thumbnail? } 状态字段，
 * 供 chat.js 拦截后推送 browser_status WS 事件给前端。
 *
 * 操作：
 * - start    启动浏览器
 * - stop     关闭浏览器
 * - navigate 导航到 URL
 * - snapshot  获取当前页面的无障碍树
 * - screenshot 截取当前页面截图
 * - click    点击元素（by ref）
 * - type     输入文本
 * - scroll   滚动页面
 * - select   选择下拉选项
 * - key      按键
 * - wait     等待页面加载
 * - evaluate 执行页面 JavaScript
 * - show     将浏览器窗口置前
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { BrowserManager } from "../browser/browser-manager.ts";
import { t } from "../i18n.ts";
import { toolOk } from "./tool-result.ts";
import { getToolSessionPath } from "./tool-session.ts";
import {
  browserScreenshotMediaItem,
  persistBrowserScreenshotFile,
} from "../session-files/browser-screenshot-file.ts";
import { redactLogText } from "../log-redactor.ts";
import { summarizeBrowserActionParams } from "./browser-action-log.ts";
import { modelSupportsDirectImageInput } from "../../shared/model-capabilities.ts";

const BROWSER_ACTIONS = [
  "start", "stop", "navigate", "snapshot", "screenshot", "click", "type",
  "scroll", "select", "key", "wait", "evaluate", "show",
];

const BROWSER_READ_ACTIONS = new Set([
  "snapshot", "screenshot", "scroll", "wait", "show",
]);

const BROWSER_ROUTINE_ACTIONS = new Set(["start", "stop"]);

const BROWSER_TAB_REVIEW_ACTIONS = new Set([
  "click", "type", "select", "key", "evaluate",
]);

const MAX_BROWSER_TAB_TARGET_LENGTH = 4096;
const MAX_BROWSER_PERMISSION_URL_LENGTH = 4096;

// This is a stable review target, not a navigation policy. The desktop host
// still performs the authoritative protocol check immediately before loadURL().
function normalizeBrowserPermissionUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const normalized = parsed.href;
    return normalized.length <= MAX_BROWSER_PERMISSION_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

function exactBrowserTabId(value: unknown) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_BROWSER_TAB_TARGET_LENGTH
    || value.includes("*")
    || value.includes("?")
  ) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return value;
}

/** Browser 专用错误：content 显示格式化文本，details.error 保留原始消息 */
function browserError(rawMsg: any, details: Record<string, any> = {}) {
  return {
    content: [{ type: "text", text: t("error.browserError", { msg: rawMsg }) }],
    details: { ...details, error: rawMsg },
  };
}

/**
 * 创建浏览器工具
 * @param {(() => string|null)|undefined} getSessionPath - 返回当前 sessionPath 的回调
 * @param {object} [options]
 * @param {(sessionPath:string|null) => object|null} [options.getSessionModel] - 返回执行 session 的模型对象
 * @param {() => { prepare?: Function }|null} [options.getVisionBridge] - 视觉辅助桥
 * @param {() => boolean} [options.isVisionAuxiliaryEnabled] - 视觉辅助总开关
 * @param {() => string|null} [options.getLucHome] - 返回 LUC_HOME
 * @param {(sessionPath:string|null) => string|null} [options.getSessionIdForPath] - 返回 sessionId
 * @param {(entry: object) => object} [options.registerSessionFile] - 注册 session 文件
 * @param {boolean} [options.screenshotEnabled] - false 时从 schema 屏蔽 screenshot
 * @returns {import('../pi-sdk/index.ts').ToolDefinition}
 */
export function createBrowserTool(getSessionPath: any, options: {
  screenshotEnabled?: boolean;
  getSessionModel?: (sessionPath: string | null) => any;
  getVisionBridge?: () => any;
  isVisionAuxiliaryEnabled?: () => boolean;
  getLucHome?: () => string | null;
  getSessionIdForPath?: (sessionPath: string | null) => string | null;
  registerSessionFile?: (entry: any) => any;
} = {}) {
  const browser = BrowserManager.instance();
  const screenshotEnabled = options.screenshotEnabled !== false;
  const actionValues = screenshotEnabled
    ? BROWSER_ACTIONS
    : BROWSER_ACTIONS.filter((action) => action !== "screenshot");

  /** 操作日志 per-session（每次 start 时清空，记录所有操作供回看纠错） */
  const _actionLogs = new Map(); // sessionId || legacy sessionPath → action[]
  const ACTION_LOG_MAX_SESSIONS = 20;  // 最多保留 20 个 session 的日志
  const ACTION_LOG_MAX_PER_SESSION = 200; // 每个 session 最多 200 条

  function actionLogKey(sessionPath: any) {
    return options.getSessionIdForPath?.(sessionPath) || sessionPath;
  }

  function getActionLog(sessionPath: any) {
    return _actionLogs.get(actionLogKey(sessionPath)) || [];
  }

  function logAction(sessionPath: any, action: any, params: any, resultSummary: any, error?: any) {
    const key = actionLogKey(sessionPath);
    if (!_actionLogs.has(key)) {
      _actionLogs.set(key, []);
      // 淘汰最早的 session 日志
      if (_actionLogs.size > ACTION_LOG_MAX_SESSIONS) {
        _actionLogs.delete(_actionLogs.keys().next().value);
      }
    }
    const log = _actionLogs.get(key);
    log.push({
      ts: new Date().toISOString(),
      action,
      params: summarizeBrowserActionParams(action, params),
      result: error ? `ERROR: ${redactLogText(error)}` : redactLogText(resultSummary),
      url: redactLogText(browser.currentUrl(sessionPath)),
    });
    // 截断过长的单 session 日志
    if (log.length > ACTION_LOG_MAX_PER_SESSION) {
      log.splice(0, log.length - ACTION_LOG_MAX_PER_SESSION);
    }
  }

  /** 当前状态快照（附加到每个 action 的 details），运行时自动带缩略图 */
  async function statusFields(sessionPath: any) {
    const running = browser.isRunning(sessionPath);
    const url = browser.currentUrl(sessionPath);
    const activeTab = browser.activeTab?.(sessionPath) || null;
    const tabs = browser.getTabs?.(sessionPath) || [];
    const fields: Record<string, any> = {
      running,
      url,
      tabId: activeTab?.tabId || null,
      title: activeTab?.title || "",
      tabs,
    };
    if (running) {
      const thumbnail = await browser.thumbnail(sessionPath);
      if (thumbnail) {
        fields.thumbnail = thumbnail;
        fields.thumbnailCapturedAt = Date.now();
        fields.thumbnailUrl = url;
      }
    }
    return fields;
  }

  async function safeStatusFields(sessionPath: any) {
    try {
      return await statusFields(sessionPath);
    } catch {
      return {
        running: browser.isRunning(sessionPath),
        url: browser.currentUrl(sessionPath),
      };
    }
  }

  function resolveSessionPath(ctx: any) {
    return getToolSessionPath(ctx) || getSessionPath?.() || null;
  }

  function snapshotWithTabIdentity(snapshot: any, sessionPath: any, preferredTabId: any = null) {
    const tabId = exactBrowserTabId(preferredTabId)
      || exactBrowserTabId(browser.activeTab?.(sessionPath)?.tabId);
    return tabId
      ? `Browser tabId (copy exactly): ${JSON.stringify(tabId)}\n\n${snapshot}`
      : snapshot;
  }

  function isExplicitTextOnlyModel(model: any) {
    return Array.isArray(model?.input) && !modelSupportsDirectImageInput(model);
  }

  return {
    name: "browser",
    label: "Browser",
    description: "Control a headless browser (navigate, click, type, scroll, screenshot, evaluate JS). Element [ref] ids from snapshot become stale after page changes; always use refs from the latest snapshot.",
    sessionPermission: {
      resolveInvocation: (input: any = {}) => {
        const action = typeof input?.action === "string" ? input.action : "";
        if (!actionValues.includes(action)) return null;
        const descriptor: Record<string, any> = {
          action,
          kind: BROWSER_READ_ACTIONS.has(action)
            ? "read"
            : BROWSER_ROUTINE_ACTIONS.has(action)
              ? "routine"
              : "review",
          capability: `browser.${action}`,
        };

        if (action === "navigate") {
          const destinationUrl = normalizeBrowserPermissionUrl(input?.url);
          if (!destinationUrl) return descriptor;
          descriptor.target = { type: "url", id: destinationUrl };
          descriptor.sideEffect = { destinationUrl };
          return descriptor;
        }

        if (BROWSER_TAB_REVIEW_ACTIONS.has(action)) {
          const tabId = exactBrowserTabId(input?.tabId);
          if (!tabId) return null;
          descriptor.target = {
            type: "browser_tab",
            id: tabId,
          };
        }

        return descriptor;
      },
    },
    parameters: Type.Object({
      action: StringEnum(actionValues, { description: "Which operation to run. Required params per action: navigate→url; click→tabId+ref; type→tabId+text (optional ref, pressEnter); scroll→direction (optional amount); select→tabId+ref+value; key→tabId+key; wait→(optional timeout, state); evaluate→tabId+expression. Use the exact tabId returned by the latest snapshot before click, type, select, key, or evaluate. start, stop, snapshot, screenshot, show take no extra params." }),
      url: Type.Optional(Type.String({ description: "URL (required for navigate)" })),
      tabId: Type.Optional(Type.String({ description: "Browser tab id. Required for click, type, select, key, and evaluate; use the exact id returned by the latest snapshot. Optional for other actions, which default to the active tab." })),
      ref: Type.Optional(Type.Number({ description: "Element ref number (used for click/type/select)" })),
      text: Type.Optional(Type.String({ description: "Input text (required for type)" })),
      direction: Type.Optional(StringEnum(
        ["up", "down"],
        { description: "Scroll direction (required for scroll)" },
      )),
      amount: Type.Optional(Type.Number({ description: "Scroll amount (optional for scroll, default 3)" })),
      value: Type.Optional(Type.String({ description: "Option value (required for select)" })),
      key: Type.Optional(Type.String({ description: "Key name (required for key), e.g. Enter, Escape, Tab, Control+a" })),
      expression: Type.Optional(Type.String({ description: "JavaScript expression (required for evaluate)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (optional for wait, default 5000)" })),
      state: Type.Optional(Type.String({ description: "Wait state (optional for wait): domcontentloaded / load / stable / networkidle (idle is accepted)" })),
      pressEnter: Type.Optional(Type.Boolean({ description: "Press Enter after typing (optional for type)" })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const sessionPath = resolveSessionPath(ctx);

        // 用户急停后，本 session 的浏览器授权被撤销：返回正常结果告知模型停手，不再触碰浏览器。
        if (browser.isBrowserAuthorizationRevoked?.(sessionPath)) {
          return toolOk(t("error.browserAuthorizationRevoked"), {
            status: "authorization_revoked",
            running: false,
            url: null,
          });
        }

        switch (params.action) {

          // ── start ──
          case "start": {
            if (browser.isRunning(sessionPath)) {
              logAction(sessionPath, "start", null, "already_running");
              return toolOk(t("error.browserAlreadyRunning"), { status: "already_running", ...await statusFields(sessionPath) });
            }
            _actionLogs.delete(actionLogKey(sessionPath));
            await browser.launch(sessionPath);
            logAction(sessionPath, "start", null, "launched");
            return toolOk(t("error.browserLaunched"), { status: "launched", ...await statusFields(sessionPath) });
          }

          // ── stop ──
          case "stop": {
            if (!browser.isRunning(sessionPath)) {
              return toolOk(t("error.browserNotRunning"), { status: "not_running", running: false, url: null });
            }
            logAction(sessionPath, "stop", null, "closed");
            const sessionLog = [...getActionLog(sessionPath)];
            await browser.close(sessionPath);
            _actionLogs.delete(actionLogKey(sessionPath));
            return toolOk(t("error.browserClosed"), { status: "closed", running: false, url: null, actionLog: sessionLog });
          }

          // ── navigate ──
          case "navigate": {
            if (!params.url) return browserError(t("error.browserNavigateNeedUrl"));
            const result = await browser.navigate(params.url, sessionPath, { tabId: params.tabId });
            logAction(sessionPath, "navigate", { url: params.url }, result.title);
            return toolOk(
              t("error.browserNavigated", {
                title: result.title,
                url: result.url,
                snapshot: snapshotWithTabIdentity(
                  result.snapshot,
                  sessionPath,
                  result.tabId || params.tabId,
                ),
              }),
              { action: "navigate", ...await statusFields(sessionPath), title: result.title },
            );
          }

          // ── snapshot ──
          case "snapshot": {
            const snapshot = await browser.snapshot(sessionPath, params.tabId || null);
            const text = snapshotWithTabIdentity(snapshot, sessionPath, params.tabId);
            return toolOk(text, { action: "snapshot", ...await statusFields(sessionPath) });
          }

          // ── screenshot ──
          case "screenshot": {
            const model = ctx?.model || options.getSessionModel?.(sessionPath) || null;
            const textOnlyNeedsAuxiliary = isExplicitTextOnlyModel(model);
            const auxiliaryAvailable = options.isVisionAuxiliaryEnabled?.() === true;
            if (!screenshotEnabled || (textOnlyNeedsAuxiliary && !auxiliaryAvailable)) {
              const msg = "browser screenshot is unavailable because the current model does not support image input";
              return {
                content: [{ type: "text", text: t("error.browserError", { msg }) }],
                details: { action: "screenshot", visionAdapted: false, visionError: msg, error: msg },
              };
            }
            const { base64, mimeType } = await browser.screenshot(sessionPath, params.tabId || null);
            const screenshotFile = await persistBrowserScreenshotFile({
              lucHome: options.getLucHome?.(),
              sessionId: options.getSessionIdForPath?.(sessionPath) || null,
              sessionPath,
              base64,
              mimeType,
              registerSessionFile: options.registerSessionFile,
            } as any);
            const mediaItem = browserScreenshotMediaItem(screenshotFile);
            const details = {
              action: "screenshot",
              mimeType,
              ...await statusFields(sessionPath),
              ...(screenshotFile || {}),
              screenshotFile,
              ...(mediaItem ? { media: { items: [mediaItem] } } : {}),
            };
            const image = { type: "image", mimeType, data: base64 };
            return { content: [image], details };
          }

          // ── click ──
          case "click": {
            if (params.ref == null) return browserError(t("error.browserClickNeedRef"));
            const snapshot = await browser.click(params.ref, sessionPath, params.tabId || null);
            logAction(sessionPath, "click", { ref: params.ref }, `clicked [${params.ref}]`);
            return toolOk(t("error.browserClicked", {
              ref: params.ref,
              snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
            }), { action: "click", ref: params.ref, ...await statusFields(sessionPath) });
          }

          // ── type ──
          case "type": {
            if (params.text == null) return browserError(t("error.browserTypeNeedText"));
            const snapshot = await browser.type(params.text, params.ref, { pressEnter: params.pressEnter ?? false }, sessionPath, params.tabId || null);
            logAction(sessionPath, "type", { ref: params.ref, text: params.text, pressEnter: params.pressEnter ?? false }, "typed");
            return toolOk(
              t("error.browserTyped", {
                target: params.ref != null ? ` to [${params.ref}]` : "",
                snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
              }),
              { action: "type", ref: params.ref, ...await statusFields(sessionPath) },
            );
          }

          // ── scroll ──
          case "scroll": {
            if (!params.direction) return browserError(t("error.browserScrollNeedDir"));
            const snapshot = await browser.scroll(params.direction, params.amount ?? 3, sessionPath, params.tabId || null);
            logAction(sessionPath, "scroll", { direction: params.direction, amount: params.amount }, "scrolled");
            return toolOk(
              t("error.browserScrolled", {
                dir: params.direction,
                snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
              }),
              { action: "scroll", direction: params.direction, ...await statusFields(sessionPath) },
            );
          }

          // ── select ──
          case "select": {
            if (params.ref == null) return browserError(t("error.browserSelectNeedRef"));
            if (!params.value) return browserError(t("error.browserSelectNeedValue"));
            const snapshot = await browser.select(params.ref, params.value, sessionPath, params.tabId || null);
            return toolOk(
              t("error.browserSelected", {
                ref: params.ref,
                value: params.value,
                snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
              }),
              { action: "select", ref: params.ref, value: params.value, ...await statusFields(sessionPath) },
            );
          }

          // ── key ──
          case "key": {
            if (!params.key) return browserError(t("error.browserKeyNeedKey"));
            const snapshot = await browser.pressKey(params.key, sessionPath, params.tabId || null);
            return toolOk(t("error.browserKeyPressed", {
              key: params.key,
              snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
            }), { action: "key", key: params.key, ...await statusFields(sessionPath) });
          }

          // ── wait ──
          case "wait": {
            const snapshot = await browser.wait({
              timeout: params.timeout ?? 5000,
              state: params.state ?? "domcontentloaded",
            }, sessionPath, params.tabId || null);
            return toolOk(t("error.browserWaitDone", {
              snapshot: snapshotWithTabIdentity(snapshot, sessionPath, params.tabId),
            }), { action: "wait", ...await statusFields(sessionPath) });
          }

          // ── evaluate ──
          case "evaluate": {
            if (!params.expression) return browserError(t("error.browserEvalNeedExpr"));
            const result = await browser.evaluate(params.expression, sessionPath, params.tabId || null);
            const truncated = result.length > 30000
              ? result.slice(0, 30000) + t("error.browserOutputTruncated")
              : result;
            return toolOk(truncated, { action: "evaluate", ...await statusFields(sessionPath) });
          }

          // ── show ──
          case "show": {
            await browser.show(sessionPath, params.tabId || null);
            return toolOk(t("error.browserShown"), { action: "show", ...await statusFields(sessionPath) });
          }

          default:
            return browserError(t("error.browserUnknownAction", { action: params.action }));
        }
      } catch (error) {
        const sessionPath = resolveSessionPath(ctx);
        // 用户在操作飞行途中急停：失败源于授权被撤销，返回拒绝通知而非报错，模型不应重试。
        if (browser.isBrowserAuthorizationRevoked?.(sessionPath)) {
          logAction(sessionPath, params.action, params, "authorization_revoked");
          return toolOk(t("error.browserAuthorizationRevoked"), {
            status: "authorization_revoked",
            running: false,
            url: null,
          });
        }
        logAction(sessionPath, params.action, params, null, error.message);
        return browserError(t("error.browserActionFailed", { msg: error.message }), {
          action: params.action,
          ...await safeStatusFields(sessionPath),
          ...(error.browserFatal || error.code === "BROWSER_SESSION_UNAVAILABLE" ? { fatal: true } : {}),
        });
      }
    },
  };
}
