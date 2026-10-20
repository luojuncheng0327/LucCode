// 文档转换库带原生扩展，加载它要付出真实的启动开销。绝大多数会话根本不会读办公文档，
// 所以这里不在模块顶层 import，而是等第一次真的要抽取时才动态加载，并把这次加载的 Promise
// 缓存下来给后续调用复用。这也是全仓库唯一引用这个包的地方，方便将来整块替换或删除。

/** 只声明我们真正调用的三个函数，其余上游 API 不在这里扩散。 */
export interface AnydocApi {
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): Promise<string>;
  formatFromBytes(bytes: Uint8Array): string | null;
  formatFromExtension(ext: string): string | null;
}

const REQUIRED_FUNCTIONS = ["toMarkdownBytes", "formatFromBytes", "formatFromExtension"] as const;

let cached: Promise<AnydocApi> | null = null;

function pickApi(mod: any): AnydocApi {
  // 包可能以 ESM 具名导出，也可能经 interop 塞在 default 里，两种形状都认。
  const candidate = mod && typeof mod.toMarkdownBytes === "function" ? mod : mod?.default;
  const missing = REQUIRED_FUNCTIONS.filter((name) => typeof candidate?.[name] !== "function");
  if (missing.length) {
    throw new Error(`document extraction library is missing expected functions: ${missing.join(", ")}`);
  }
  return candidate as AnydocApi;
}

export function loadAnydoc(): Promise<AnydocApi> {
  if (cached) return cached;
  const pending = import("@firecrawl/anydoc").then(pickApi);
  // 加载失败不做缓存，否则一次瞬时错误会把整个进程的文档抽取能力永久钉死。
  pending.catch(() => {
    if (cached === pending) cached = null;
  });
  cached = pending;
  return cached;
}
