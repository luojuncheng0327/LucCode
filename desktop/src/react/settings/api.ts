/**
 * Settings window API utilities
 * 从 settings store 读 port/token，独立于主窗口
 */
import { useSettingsStore } from './store';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';
import { errorWithCode } from '../errors/error-presenter';
import { normalizeSessionRouteError } from '../../../../shared/error-user-messages.ts';

const DEFAULT_TIMEOUT = 30_000;

export function lucUrl(path: string): string {
  const connection = requireServerConnection(
    useSettingsStore.getState(),
    `settings lucUrl ${path}: server connection not ready`,
  );
  return buildConnectionUrl(connection, path, { includeTokenQuery: true });
}

export async function lucFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const connection = requireServerConnection(
    useSettingsStore.getState(),
    `settings lucFetch ${path}: server connection not ready`,
  );
  const headers = appendConnectionAuth(connection, opts.headers);

  const { timeout = DEFAULT_TIMEOUT, signal: callerSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // If caller provided a signal, forward its abort to our controller
  if (callerSignal) {
    if (callerSignal.aborted) { controller.abort(); }
    else { callerSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
  }

  try {
    const res = await fetch(buildConnectionUrl(connection, path), {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      // 错误码在这里就得挂到异常上。调用方拿到的是抛出来的 Error，不是响应体——
      // 一旦这里只带走那句英文，后面再想把失败翻成人话就没有依据了。
      const { message, code } = await readErrorResponse(res);
      throw errorWithCode(message || `lucFetch ${path}: ${res.status} ${res.statusText}`, code);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读错误响应：给调用方一句话，外加一个错误码。
 *
 * 同一个失败会有两种响应形状：route handler 自己应答的是扁平的 `{error, code}`，
 * 而没被 route 接住、冒到服务端顶层错误处理器的异常会被包成嵌套的
 * `{error: {code, message, traceId}}`。只认扁平形状的话，嵌套那种会把整段 JSON
 * 文本当成"错误消息"显示出来，错误码也一并丢掉。归一交给 shared 的
 * normalizeSessionRouteError——它两种都认，跟其它消费点用的是同一个归一器。
 *
 * 归一取不到消息时才往下退：先看 `{message}` 这种不带 error 字段的写法，
 * 最后退回整段响应文本。body 读不出来或根本不是 JSON 时没有码，文案跟以前一样。
 */
async function readErrorResponse(res: Response): Promise<{ message: string | null; code: string | null }> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { message: null, code: null };
  }
  if (!text) return { message: null, code: null };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // try 只围 JSON.parse：底下的字段读取若有缺陷，应该原地炸出来让人看见，
    // 而不是被这个 catch 收编成"body 不是 JSON"，把 bug 伪装成正常分支。
    return { message: text.trim() || null, code: null };
  }

  const routeError = normalizeSessionRouteError(data);
  if (routeError.message) return { message: routeError.message, code: routeError.code };

  const legacyMessage = (data as { message?: unknown } | null)?.message;
  if (typeof legacyMessage === 'string' && legacyMessage.trim()) {
    return { message: legacyMessage.trim(), code: routeError.code };
  }
  return { message: text.trim() || null, code: routeError.code };
}

/** 根据 yuan 类型返回 fallback 头像路径 */
export function yuanFallbackAvatar(yuan?: string): string {
  const t = window.t || ((k: string) => k);
  const types = (t('yuan.types') || {}) as Record<string, { avatar?: string }>;
  const entry = types[yuan || 'luc'];
  return `assets/${entry?.avatar || 'Luc.png'}`;
}
