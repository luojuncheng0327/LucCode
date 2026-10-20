// 工作区文件历史的采集准入策略：只对代码/文本存全量快照，噪音目录整棵排除。
// 与前端 EXT_TO_KIND（呈现分类）语义不同，这里回答"值不值得存全量历史"，两表独立维护。

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "mdx", "rst", "tex",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
  "xml", "html", "htm", "xhtml", "css", "scss", "less", "svg",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "scala", "clj",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "php", "lua", "pl", "r",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "csv", "tsv", "env",
]);

// 无扩展名但公认是文本的文件名（按 basename 原名匹配）
const KNOWN_TEXT_FILENAMES = new Set([
  ".gitignore", ".gitattributes", ".editorconfig", ".env", ".npmrc", ".nvmrc",
  "Makefile", "Dockerfile", "LICENSE", "README", "CHANGELOG",
]);

// 高频膨胀、历史价值低的文件：单独黑名单（优先级高于扩展名白名单）
const CHURN_FILENAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"]);
const CHURN_EXTENSIONS = new Set(["log", "lock", "tmp", "temp", "swp"]);

const IGNORED_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "coverage", "target",
  "__pycache__", "venv", ".venv",
]);

function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

function extOf(name: string): string | null {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

/** relPath 使用 POSIX 分隔符（"/"）。任一目录段命中忽略表或以 "." 开头即整棵排除。 */
export function isIgnoredRelPath(relPath: string): boolean {
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!seg) continue;
    if (IGNORED_DIR_NAMES.has(seg) || seg.startsWith(".")) return true;
  }
  return false;
}

/** 是否值得为该文件存全量文本快照（不含大小判断，大小由调用方 stat 后配合 MAX_SNAPSHOT_BYTES 把关）。 */
export function isTrackedFile(relPath: string): boolean {
  const name = basenameOf(relPath);
  if (CHURN_FILENAMES.has(name)) return false;
  const ext = extOf(name);
  if (ext && CHURN_EXTENSIONS.has(ext)) return false;
  if (KNOWN_TEXT_FILENAMES.has(name)) return true;
  return ext != null && TEXT_EXTENSIONS.has(ext);
}
