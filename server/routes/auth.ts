/**
 * OAuth 认证路由
 *
 * 支持两种 OAuth 流程：
 *   - 授权码流程 (Anthropic)：用户粘贴授权码
 *   - 设备码流程 (MiniMax)：服务端轮询，用户在浏览器授权
 *
 * 交互：
 *   1. POST /auth/oauth/start    → { sessionId, url, instructions? }
 *   2. POST /auth/oauth/callback → 提交授权码（授权码流程）
 *   3. GET  /auth/oauth/poll/:id → 轮询登录状态（设备码流程）
 */
import crypto from "crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createModuleLogger } from "../../lib/debug-log.ts";
import { t } from "../../lib/i18n.ts";
import {
  loginOAuthProvider,
  type OAuthLoginCallbacks,
} from "../../lib/pi-sdk/index.ts";
import {
  DEFAULT_OAUTH_LOGIN_METHOD,
  isOAuthLoginMethod,
} from "../../shared/oauth-login.ts";

const log = createModuleLogger("auth");

type OAuthFlowResult = { ok: true } | { ok: false; error: string };

interface OAuthStartResponse {
  sessionId: string;
  url: string;
  instructions?: string;
  polling?: true;
}

interface PendingOAuthFlow {
  authKey: string;
  abortController: AbortController;
  resolveCode: (code: string) => void;
  rejectCode: (reason?: unknown) => void;
  rejectUrl: (reason?: unknown) => void;
  loginPromise: Promise<void> | null;
  result: OAuthFlowResult | null;
  response: OAuthStartResponse | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  urlPromise: Promise<string>;
  authInstructions: string | null;
  usesCallbackServer: boolean;
  createdAt: number;
}

/** 将 OAuth 底层错误转为用户可理解的诊断信息 */
function diagnoseOAuthError(err) {
  const msg = err.message || String(err);
  const cause = err.cause?.message || err.cause?.code || "";
  const full = cause ? `${msg} (${cause})` : msg;

  // fetch 网络层失败（DNS/连接/超时）→ 代理没覆盖 Node 进程
  if (/fetch failed/i.test(msg)) {
    const detail = cause ? ` (${cause})` : "";
    return t("auth.oauthConnectFailed", { detail });
  }
  // 回调超时 → localhost 不通 / 端口问题
  if (/timed out/i.test(msg)) {
    return t("auth.oauthTimeout");
  }
  return full;
}

export function createAuthRoute(engine) {
  const route = new Hono();

  /** 进行中的 OAuth 流程 */
  const pendingFlows = new Map<string, PendingOAuthFlow>();
  const pendingFlowByAuthKey = new Map<string, string>();

  function clearFlowTimer(flow?: PendingOAuthFlow) {
    if (flow?.timeoutTimer) {
      clearTimeout(flow.timeoutTimer);
      flow.timeoutTimer = null;
    }
  }

  function deletePendingFlow(sessionId: string) {
    const flow = pendingFlows.get(sessionId);
    clearFlowTimer(flow);
    if (flow?.authKey && pendingFlowByAuthKey.get(flow.authKey) === sessionId) {
      pendingFlowByAuthKey.delete(flow.authKey);
    }
    pendingFlows.delete(sessionId);
  }

  function abortPendingFlow(sessionId: string, reason: unknown) {
    const flow = pendingFlows.get(sessionId);
    if (!flow) return;
    flow.abortController.abort(reason);
    flow.rejectCode(reason);
    flow.rejectUrl(reason);
    deletePendingFlow(sessionId);
  }

  function buildStartResponse(
    sessionId: string,
    url: string,
    authInstructions: string | null,
    usesCallbackServer: boolean,
  ): OAuthStartResponse {
    const resp: OAuthStartResponse = { sessionId, url };
    if (authInstructions) resp.instructions = authInstructions;
    if (usesCallbackServer) resp.polling = true;
    return resp;
  }

  // 定时清理超时的 pending flow（10 分钟未完成视为超时）
  const _flowCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of pendingFlows) {
      if (v.createdAt >= cutoff) continue;
      if (v.result) deletePendingFlow(k);
      else abortPendingFlow(k, new Error("OAuth flow timed out"));
    }
  }, 60_000);
  _flowCleanupTimer.unref();

  /**
   * 启动 OAuth 登录
   * body: { provider, loginMethod? }
   * → { sessionId, url, instructions? }
   *   instructions 存在时为设备码流程（值为 user_code）
   */
  route.post("/auth/oauth/start", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
    }
    const loginMethod = body.loginMethod ?? DEFAULT_OAUTH_LOGIN_METHOD;
    if (!isOAuthLoginMethod(loginMethod)) {
      return c.json({ error: `Unsupported OAuth login method: ${String(loginMethod)}` }, 400);
    }

    // ProviderRegistry 的 plugin ID 可能和 Pi SDK 的 provider ID 不同（如 "openai-codex-oauth" → "openai-codex"）
    const authKey = engine.providerRegistry?.getAuthJsonKey(provider) || provider;
    const existingSessionId = pendingFlowByAuthKey.get(authKey);
    const existingFlow = existingSessionId ? pendingFlows.get(existingSessionId) : null;
    if (existingFlow?.result) {
      deletePendingFlow(existingSessionId);
    } else if (existingFlow) {
      try {
        const url = await existingFlow.urlPromise;
        if (!existingFlow.response) {
          existingFlow.response = buildStartResponse(
            existingSessionId,
            url,
            existingFlow.authInstructions,
            existingFlow.usesCallbackServer,
          );
        }
        return c.json(existingFlow.response);
      } catch (err) {
        return c.json({ error: err.message }, 500);
      }
    }

    const sessionId = crypto.randomUUID();

    // onAuth 回调会把 URL 和 instructions 交给我们
    let resolveUrl: (url: string) => void;
    let rejectUrl: (reason?: unknown) => void;
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });

    // onPrompt 回调等待用户粘贴授权码（仅授权码流程使用）
    let resolveCode: (code: string) => void;
    let rejectCode: (reason?: unknown) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // A provider may use only one waiter. Keep cancellation of the unused one
    // from becoming an unhandled rejection while preserving rejection for SDK awaiters.
    void urlPromise.catch(() => {});
    void codePromise.catch(() => {});

    let authInstructions: string | null = null;
    let usesCallbackServer = false;

    // 检查 provider 是否使用本地回调服务器（如 OpenAI Codex）
    const providerObj = engine.authStorage.getOAuthProviders().find(p => p.id === authKey);
    if (providerObj?.usesCallbackServer) usesCallbackServer = true;

    const flow: PendingOAuthFlow = {
      authKey,
      abortController: new AbortController(),
      resolveCode,
      rejectCode,
      rejectUrl,
      loginPromise: null,
      result: null,
      response: null,
      timeoutTimer: null,
      urlPromise,
      authInstructions,
      usesCallbackServer,
      createdAt: Date.now(),
    };
    pendingFlows.set(sessionId, flow);
    pendingFlowByAuthKey.set(authKey, sessionId);

    const loginOptions: OAuthLoginCallbacks = {
      onAuth: (info) => {
        // callback server 流程不需要给前端显示 instructions（那只是提示文本，不是 user_code）
        // 只有设备码流程才需要（instructions 是 user_code）
        if (usesCallbackServer) {
          authInstructions = null;
        } else {
          authInstructions = info.instructions || null;
        }
        flow.authInstructions = authInstructions;
        resolveUrl(info.url);
      },
      onDeviceCode: (info) => {
        authInstructions = info.userCode;
        flow.authInstructions = authInstructions;
        resolveUrl(info.verificationUri);
      },
      onPrompt: () => codePromise,
      onSelect: async (prompt) => {
        const selected = prompt.options.find(option => option.id === loginMethod);
        if (!selected) {
          throw new Error(`OAuth provider does not support login method: ${loginMethod}`);
        }
        return selected.id;
      },
      signal: flow.abortController.signal,
    };
    if (usesCallbackServer) {
      // Pi SDK 的 callback-server provider 会把 onManualCodeInput 与浏览器回调 race。
      // Luc 的 timeout 通过 rejectCode 拒绝这个 promise，SDK 随后 cancelWait 并关闭本地 server。
      loginOptions.onManualCodeInput = () => codePromise;
    }

    // 启动 OAuth（不 await，loginPromise 会异步 resolve）
    const loginPromise = loginOAuthProvider(engine.authStorage, authKey, loginOptions).catch(err => {
      rejectUrl(err);
      throw err;
    });
    flow.loginPromise = loginPromise;

    // 追踪 loginPromise 的结果（供 poll 端点使用）
    loginPromise.then(() => {
      flow.result = { ok: true };
      clearFlowTimer(flow);
    }).catch(err => {
      const cause = err.cause?.message || err.cause?.code || "";
      log.error(`OAuth login failed (${provider}): ${err.message}${cause ? ` [${cause}]` : ""}`);
      flow.result = { ok: false, error: diagnoseOAuthError(err) };
      clearFlowTimer(flow);
    });

    try {
      const url = await urlPromise;

      // 5 分钟超时
      flow.timeoutTimer = setTimeout(() => {
        const f = pendingFlows.get(sessionId);
        if (f) {
          abortPendingFlow(sessionId, new Error("OAuth flow timed out"));
        }
      }, 5 * 60 * 1000);
      flow.timeoutTimer.unref();
      if (flow.result) clearFlowTimer(flow);

      const resp = buildStartResponse(sessionId, url, authInstructions, usesCallbackServer);
      flow.response = resp;
      return c.json(resp);
    } catch (err) {
      deletePendingFlow(sessionId);
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * 提交授权码（授权码流程）
   * body: { sessionId, code }
   */
  route.post("/auth/oauth/callback", async (c) => {
    const body = await safeJson(c);
    const { sessionId, code } = body;
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ error: "No pending login flow" }, 400);
    }

    flow.resolveCode(code);

    try {
      await flow.loginPromise;
      deletePendingFlow(sessionId);

      try {
        await engine.onProviderChanged();
      } catch (err) {
        log.error(`post-login model sync failed: ${err.message}`);
      }

      return c.json({ ok: true });
    } catch (err) {
      deletePendingFlow(sessionId);
      return c.json({ error: err.message }, 500);
    }
  });

  /**
   * 轮询登录状态（设备码流程）
   * → { status: "pending" | "done" | "error", error? }
   */
  route.get("/auth/oauth/poll/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const flow = pendingFlows.get(sessionId);
    if (!flow) {
      return c.json({ status: "error", error: "No pending login flow" }, 400);
    }

    if (!flow.result) {
      return c.json({ status: "pending" });
    }

    deletePendingFlow(sessionId);

    if ("error" in flow.result) {
      return c.json({ status: "error", error: flow.result.error });
    }

    try {
      await engine.onProviderChanged();
    } catch (err) {
      log.error(`post-login model sync failed: ${err.message}`);
    }
    return c.json({ status: "done" });
  });

  /**
   * 查询 OAuth 状态
   * → { anthropic: { name, loggedIn }, minimax: { name, loggedIn }, ... }
   */
  route.get("/auth/oauth/status", async (c) => {
    const providers = engine.authStorage.getOAuthProviders();
    const status = {};
    for (const p of providers) {
      const cred = engine.authStorage.get(p.id);
      const modelCount = cred?.type === "oauth"
        ? engine.availableModels.filter(m => m.provider === p.id).length
        : 0;
      status[p.id] = {
        name: p.name,
        loggedIn: cred?.type === "oauth",
        modelCount,
      };
    }
    return c.json(status);
  });

  /**
   * 登出
   * body: { provider }
   */
  route.post("/auth/oauth/logout", async (c) => {
    const body = await safeJson(c);
    const { provider } = body;
    if (!provider) {
      return c.json({ error: "provider is required" }, 400);
    }
    const authKey = engine.providerRegistry?.getAuthJsonKey(provider) || provider;
    engine.authStorage.logout(authKey);
    engine.providerRegistry?.clearAuthCache?.();
    await engine.onProviderChanged?.();
    return c.json({ ok: true });
  });

  // ── OAuth 自定义模型 ──

  /** 获取某个 OAuth provider 的自定义模型列表 */
  route.get("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const resolved = engine.providerRegistry.resolveChatProvider?.(provider);
    if (!resolved || resolved.entry?.authType !== "oauth") {
      return c.json({ error: `OAuth provider "${provider}" not found` }, 404);
    }
    return c.json({ models: engine.providerRegistry.getChatModelIds(resolved.sourceProviderId) });
  });

  /** 添加自定义模型到 OAuth provider */
  route.post("/auth/oauth/:provider/custom-models", async (c) => {
    const provider = c.req.param("provider");
    const body = await safeJson(c);
    const { modelId } = body;
    if (!modelId || typeof modelId !== "string" || !modelId.trim()) {
      return c.json({ error: "modelId is required" }, 400);
    }
    const id = modelId.trim();
    const resolved = engine.providerRegistry.resolveChatProvider?.(provider);
    if (!resolved || resolved.entry?.authType !== "oauth") {
      return c.json({ error: `OAuth provider "${provider}" not found` }, 404);
    }
    engine.providerRegistry.addModel(resolved.sourceProviderId, id);
    await engine.onProviderChanged();
    return c.json({ ok: true, models: engine.providerRegistry.getChatModelIds(resolved.sourceProviderId) });
  });

  /** 删除 OAuth provider 的某个自定义模型 */
  route.delete("/auth/oauth/:provider/custom-models/:modelId", async (c) => {
    const provider = c.req.param("provider");
    const modelId = c.req.param("modelId");
    const resolved = engine.providerRegistry.resolveChatProvider?.(provider);
    if (!resolved || resolved.entry?.authType !== "oauth") {
      return c.json({ error: `OAuth provider "${provider}" not found` }, 404);
    }
    engine.providerRegistry.removeModel(resolved.sourceProviderId, modelId);
    await engine.onProviderChanged();
    return c.json({ ok: true, models: engine.providerRegistry.getChatModelIds(resolved.sourceProviderId) });
  });

  return route;
}
