import vm from "node:vm";

/**
 * 静态提取并校验 workflow 脚本开头的 `export const meta = {...}` 字面量，
 * 返回 meta 对象与剥离 export 后可在 async function 里执行的 body。
 * meta 必须是纯对象字面量（spec 约束：无变量 / 函数调用 / 模板插值）。
 * @param {string} script
 * @returns {{ meta: { name: string, description: string, phases?: any[] }, body: string }}
 */
export function extractMeta(script) {
  if (typeof script !== "string" || !script.trim()) {
    throw new Error("workflow script 不能为空");
  }
  const marker = /export\s+const\s+meta\s*=/.exec(script);
  if (!marker) {
    throw new Error("workflow script 必须以 export const meta = {...} 开头");
  }
  const braceStart = script.indexOf("{", marker.index + marker[0].length);
  if (braceStart === -1) throw new Error("workflow meta 必须是对象字面量");
  const braceEnd = matchBrace(script, braceStart);
  if (braceEnd === -1) throw new Error("workflow meta 对象字面量未闭合");

  const literal = script.slice(braceStart, braceEnd + 1);
  let meta;
  try {
    // 在纯净 context 求值字面量：不暴露任何宿主能力。
    meta = vm.runInNewContext("(" + literal + ")", Object.create(null), { timeout: 50 });
  } catch (err) {
    throw new Error("workflow meta 不是合法对象字面量: " + err.message);
  }
  if (!meta || typeof meta !== "object" ||
      typeof meta.name !== "string" || typeof meta.description !== "string") {
    throw new Error("workflow meta 必须含 name 和 description 字符串");
  }

  const strippedMeta =
    script.slice(0, marker.index) +
    script.slice(marker.index).replace(/export\s+const\s+meta/, "const meta");
  return { meta, body: normalizeExports(strippedMeta) };
}

/**
 * 归一化 meta 之外的 export，使脚本能在 vm 非模块上下文执行（vm 不认 export，
 * 否则报 "Unexpected token 'export'"）。模型常把 workflow 写成
 * `export default async function(api){...}`（合法且自然），必须支持：
 * - `export default <expr>` → `const __wf_default = <expr>`，并在末尾
 *   `return await __wf_default(__wf_api)`（__wf_api 由 sandbox 注入完整 host API；
 *   入口是函数则用 host API 调用，非函数则直接作结果）。
 * - 其余 `export const/let/var/function/class/async` → 剥掉 export 前缀成局部声明。
 * @param {string} body
 * @returns {string}
 */
function normalizeExports(body) {
  let hasDefault = false;
  let out = body.replace(/export\s+default\s+/, () => {
    hasDefault = true;
    return "const __wf_default = ";
  });
  out = out.replace(/export\s+(?=(?:const|let|var|function|class|async)\b)/g, "");
  if (hasDefault) {
    out += "\n;return await (typeof __wf_default === 'function' ? __wf_default(__wf_api) : __wf_default);";
  }
  return out;
}

/**
 * 从 start 处的 `{` 找到配对的 `}`（跳过字符串字面量内的花括号）。
 * @param {string} s
 * @param {number} start
 * @returns {number} 配对 `}` 的下标，未闭合返回 -1
 */
function matchBrace(s, start) {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
