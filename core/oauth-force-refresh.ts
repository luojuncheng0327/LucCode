/**
 * forceRefreshOAuthApiKey — 无视本地到期时间，立刻旋转 OAuth 凭证
 *
 * 为什么需要它：
 *   凭证存储（auth.json）里每条 OAuth 记录都带一个本地记下来的到期时间，
 *   常规取 token 的路径只在"本地时间已过期"时才去换新 token。但服务端可以
 *   在这个时间之前就把 access token 作废（换设备、撤销会话、服务端缩短有效
 *   期等），此时本地账本还认为 token 有效，常规路径会一直把已经被拒收的旧
 *   token 交出去，调用方只能一路撞 401。
 *
 *   这个原语表达的是另一件事：**服务端刚刚拒收了这个 token，现在就换**。
 *   它不看本地到期时间，只看"你手上那个 token 是不是仍然是存储里那个"。
 *
 * 为什么必须走 AuthStorage 实例上的 provider 列表 + 同一把文件锁：
 *   - OAuth provider 注册表是模块级单例，而依赖树里存在两份 SDK 拷贝，
 *     跨拷贝的注册表互相看不见。所以 provider 只能从传进来的 AuthStorage
 *     实例上取（authStorage.getOAuthProviders()），不能从包的顶层注册表取。
 *   - 换 token 是"读—改—写"，同一台机器上可能有多个进程同时在换。整个
 *     决策和写盘都放在存储自己的文件锁里，锁的是 auth.json 这个路径本身，
 *     所以和 SDK 自己的刷新路径天然互斥；后进锁的人会看到前一个人已经写好
 *     的新凭证，于是直接复用，不会把刚换来的 refresh token 再换一次作废掉。
 *
 * 失败一律上抛：解析不了、条目不存在、不是 OAuth、服务端拒绝换新，都直接报
 * 错，不写盘、不降级、不返回旧 token。
 */

interface ForceRefreshOptions {
  /** 与 backend 指向同一份存储的 AuthStorage 实例，用于取 provider 和刷新内存副本 */
  authStorage: any;
  /** 存储后端，提供 withLockAsync */
  backend: any;
  /** auth.json 里的凭证键，例如 "openai-codex" */
  authKey: string;
  /** 调用方手上那个被拒收的 token；用于判断别人是否已经换过 */
  staleApiKey?: string;
}

export async function forceRefreshOAuthApiKey({
  authStorage,
  backend,
  authKey,
  staleApiKey,
}: ForceRefreshOptions): Promise<string> {
  if (!authStorage || typeof authStorage.getOAuthProviders !== "function") {
    throw new Error(`Cannot rotate OAuth credential for "${authKey}": auth storage unavailable`);
  }
  if (!backend || typeof backend.withLockAsync !== "function") {
    throw new Error(`Cannot rotate OAuth credential for "${authKey}": auth storage backend unavailable`);
  }

  const apiKey = await backend.withLockAsync(async (current) => {
    // 解析失败必须抛：宁可这次刷新失败，也不能拿一个空对象覆盖掉用户的凭证文件。
    const data = current ? JSON.parse(current) : {};
    const cred = data[authKey];
    if (!cred || cred.type !== "oauth" || !cred.access || !cred.refresh) {
      throw new Error(`Cannot rotate OAuth credential for "${authKey}": no OAuth credential stored`);
    }

    const provider = authStorage.getOAuthProviders().find((p) => p?.id === authKey);
    if (!provider) {
      throw new Error(`Cannot rotate OAuth credential for "${authKey}": no OAuth provider registered`);
    }

    // 存储里的 token 已经不是调用方手上那个了，说明别的执行流刚换过。
    // 直接用新的，不再发一次刷新请求（那会把刚换来的 refresh token 作废）。
    if (staleApiKey && cred.access !== staleApiKey) {
      return { result: provider.getApiKey(cred) };
    }

    const refreshed = await provider.refreshToken(cred);
    const nextCred = { type: "oauth", ...refreshed };
    return {
      result: provider.getApiKey(nextCred),
      next: JSON.stringify({ ...data, [authKey]: nextCred }, null, 2),
    };
  });

  // 让同进程的内存副本立刻看到刚写下去的凭证。
  authStorage.reload?.();
  return apiKey;
}
