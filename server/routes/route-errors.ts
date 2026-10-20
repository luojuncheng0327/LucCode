/**
 * route 层错误 → HTTP 响应的统一构造。
 *
 * 分工是固定的：抛错点负责判断"这是什么错、该回什么状态码"，把 code 和 status 挂在
 * Error 上（唯一正道，见 routeError）；这里只负责忠实透传，不猜、不兜底、不按文案正则
 * 反推语义。少了 code，前端就只能把一切失败糊成同一句不可行动的英文原文。
 *
 * 新写的路由 catch 一律用 bodyFromRouteError + statusFromRouteError，
 * 不要手写 `c.json({ error: err.message }, 500)`——那会把抛错点已经表达清楚的语义压平。
 *
 * "忠实透传"只针对我们自己的抛错点。catch 到的东西不全是我们造的：文件系统、SQLite、
 * 子进程的异常也会走同一个出口，它们的 status 字段语义完全不同。所以状态码在发布前
 * 先验范围——用不了的值按"没带"处理，而不是照单全收交给 Response 构造。
 *
 * code 则原样透传、不设形状门：现役错误码里既有小写蛇形也有大写常量
 * （压缩重放不可处理那类），先给形状设门会把后者误杀；漏出去的 errno 类杂音
 * 由消费端查表落空后安全忽略，表现与无码一致。等存量大写码统一规范化之后，
 * 这里才轮得到形状校验。
 *
 * 同名提醒：server/http/route-errors.ts 是另一套契约——HttpRouteError 走嵌套
 * `{error:{code,message,traceId}}` 形状，服务 app.onError 一族；这里是路由层的
 * 扁平 `{error, code, ...}` 形状。两者各有消费方，别互相替换。
 */

/** 造一个带 code 和 status 的错误，供路由内部 throw，最终被下面两个函数透传。 */
export function routeError(message, code, status) {
  const err: any = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * 只承认能当错误响应状态码用的整数。
 *
 * status 是个开放字段，谁都能往 Error 上挂：Node 子进程把退出码也叫 status，
 * 外部库挂个 0 或 999 并不稀奇。这类值传给 Response 构造会抛 RangeError，异常从 catch
 * 里穿出去，客户端最后拿到的是框架兜底的纯文本——原始错误连同它的 code 一起被毁掉。
 * 所以宁可回 500 也不能让它越界。
 *
 * 范围收敛到 4xx/5xx 是因为这里是错误响应边界：2xx 会把失败说成成功，3xx 更糟，
 * 302 会让客户端真的去跟一次重定向。注意：status 是整数但越界时直接判 500，
 * 不会回落到 statusCode 或 fallback——错误已经把话说明白了，只是说了个用不了的值，
 * 再去找下一个来源等于替它改主意。
 *
 * statusCode 是待迁移的 legacy 键：agents.ts 其余路由和 core/yuan-registry.ts 用的是它。
 * 认它是为了让那些故意的 400 别在收编时被静默改成 500；新代码一律写 status。
 *
 * fallback 是"错误什么都没说"时该用哪个状态码。默认 500；少数路由有自己的历史默认值
 * （retry 无码回 400、fork 无码回 500），收编时把它显式写在调用处，而不是各自在 catch
 * 里重算一遍状态码——重算就会绕开上面这道范围门。
 */
export function statusFromRouteError(err, fallback = 500) {
  const declared = Number.isInteger(err?.status)
    ? err.status
    : Number.isInteger(err?.statusCode)
      ? err.statusCode
      : null;
  const status = declared ?? fallback;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

export function bodyFromRouteError(err) {
  return {
    error: err?.message || String(err),
    ...(err?.code ? { code: err.code } : {}),
    ...(err?.sessionId ? { sessionId: err.sessionId } : {}),
    ...(err?.currentPath ? { currentPath: err.currentPath } : {}),
    ...(err?.requestedPath ? { requestedPath: err.requestedPath } : {}),
    ...(err?.lifecycle ? { lifecycle: err.lifecycle } : {}),
  };
}
