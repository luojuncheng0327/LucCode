#!/usr/bin/env node
/**
 * sync-known-models-from-pi.mjs — 用 pi-ai 携带的 models.dev 目录对表刷新
 * lib/known-models.json（Luc 策展的模型参考词典）。
 *
 * 行为：
 *   - 只做交集对表：遍历 Luc 词典每个 (provider, modelId)，在 pi 目录里找
 *     同 provider 同 id 的条目；provider key 字面比对，不做模糊映射。
 *   - 字段白名单（只碰这四项）：
 *       pi.contextWindow      → luc.context
 *       pi.maxTokens          → luc.maxOutput
 *       pi.input 含 "image"   → luc.image（词典缺省 false）
 *       pi.reasoning          → luc.reasoning（词典缺省 false）
 *   - 明确不做：引入 pi 的新模型；改 compat/quirks/toolUse/visionCapabilities/
 *     xhigh/name；引入 cost 字段。
 *   - 默认 dry-run，只输出三段式报告（值不同 / pi 无此模型 / 统计）；
 *     仅 --write 落盘。落盘用行级手术而非整文件重序列化：词典存在
 *     单行数组与多行数组混排（如 quirks），JSON.stringify 会重排无关行；
 *     手术只改白名单字段所在行（缺失字段追加在该模型对象末尾），
 *     _comment 与其余格式原样保留。写后重新 parse 并与预期语义深比对，
 *     不一致即抛错拒写，杜绝静默损坏。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 0.80.3 实际导出名即 MODELS（已核对 dist/models.generated.js:38）
import { MODELS } from "../node_modules/@earendil-works/pi-ai/dist/models.generated.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DICT_PATH = path.join(__dirname, "..", "lib", "known-models.json");

const writeMode = process.argv.includes("--write");

const raw = fs.readFileSync(DICT_PATH, "utf8");
const dict = JSON.parse(raw);

// 白名单字段映射：pi 条目 → Luc 词典字段。
// image/reasoning 在词典中缺省为 false（见 known-models.json 的 _comment）；
// context/maxOutput 无缺省，词典里缺失时按 undefined 对待并在报告中标注。
const FIELD_MAP = [
  {
    lucKey: "context",
    read: entry => entry.contextWindow,
    lucDefault: undefined,
  },
  {
    lucKey: "maxOutput",
    read: entry => entry.maxTokens,
    lucDefault: undefined,
  },
  {
    lucKey: "image",
    read: entry => Array.isArray(entry.input) && entry.input.includes("image"),
    lucDefault: false,
  },
  {
    lucKey: "reasoning",
    read: entry => entry.reasoning === true,
    lucDefault: false,
  },
];

// 显式排除表：记录已经人工审核、必须保留 Luc 现值的上游差异。
// 键格式与报告行一致（provider/modelId.field）。命中的差异保持 Luc 现值，
// 报告中单列 excluded 段，不落盘。
// 大意：anthropic 两条为 1M beta 口径（会拉高压缩阈值致溢出）；
// openrouter/mistral 系 maxOutput 为 models.dev 保守默认 4096（会硬截长输出）；
// grok-code-fast-1 三条与 mistral-small reasoning 为方向存疑的能力翻转。
// minimax/MiniMax-M3.context 为用户策展值（2026-07-08）：实测 500k 以上
// 基本不可用，词典取 500000，不取官方 1M；known-model-fallbacks.json 同值。
const EXCLUDED_UPDATES = new Set([
  "minimax/MiniMax-M3.context",
  "anthropic/claude-opus-4-6.context",
  "anthropic/claude-sonnet-4-6.context",
  "mistral/codestral-latest.maxOutput",
  "mistral/mistral-small-latest.reasoning",
  "xai/grok-code-fast-1.context",
  "xai/grok-code-fast-1.maxOutput",
  "xai/grok-code-fast-1.reasoning",
  "openrouter/mistralai/devstral-2512.maxOutput",
  "openrouter/mistralai/ministral-3b-2512.maxOutput",
  "openrouter/mistralai/ministral-8b-2512.maxOutput",
  "openrouter/mistralai/ministral-14b-2512.maxOutput",
  "openrouter/mistralai/mistral-large-2512.maxOutput",
  "openrouter/moonshotai/kimi-k2.5.maxOutput",
  "openrouter/openai/gpt-4.1.maxOutput",
  "openrouter/openai/gpt-5-nano.maxOutput",
  "openrouter/openai/gpt-oss-20b.maxOutput",
  "openrouter/qwen/qwen3-235b-a22b-thinking-2507.maxOutput",
  "openrouter/qwen/qwen3.5-397b-a17b.maxOutput",
  "openrouter/z-ai/glm-5.maxOutput",
]);

const diffs = [];      // { provider, modelId, field, oldValue, newValue } — 将应用
const excludedHits = []; // 同结构 — 命中排除表，保持 Luc 现值
const missing = [];    // "provider/modelId"
let lucTotal = 0;
let matched = 0;

for (const [provider, models] of Object.entries(dict)) {
  if (provider === "_comment") continue;
  for (const [modelId, lucEntry] of Object.entries(models)) {
    lucTotal += 1;
    const piEntry = MODELS?.[provider]?.[modelId];
    if (!piEntry) {
      missing.push(`${provider}/${modelId}`);
      continue;
    }
    matched += 1;
    for (const { lucKey, read, lucDefault } of FIELD_MAP) {
      const piValue = read(piEntry);
      if (piValue === undefined || piValue === null) continue; // pi 侧无数据，不动
      const lucValue = Object.prototype.hasOwnProperty.call(lucEntry, lucKey)
        ? lucEntry[lucKey]
        : lucDefault;
      if (lucValue !== piValue) {
        const entry = { provider, modelId, field: lucKey, oldValue: lucValue, newValue: piValue };
        if (EXCLUDED_UPDATES.has(`${provider}/${modelId}.${lucKey}`)) {
          excludedHits.push(entry);
        } else {
          diffs.push(entry);
        }
      }
    }
  }
}

function fmt(value) {
  if (value === undefined) return "(missing)";
  return JSON.stringify(value);
}

console.log("═══ 值不同 ═══");
if (diffs.length === 0) {
  console.log("(无)");
} else {
  for (const d of diffs) {
    console.log(`${d.provider}/${d.modelId}.${d.field}: ${fmt(d.oldValue)} → ${fmt(d.newValue)}`);
  }
}

console.log("");
console.log("═══ excluded（用户审核口径，保持 Luc 现值）═══");
if (excludedHits.length === 0) {
  console.log("(无)");
} else {
  for (const d of excludedHits) {
    console.log(`${d.provider}/${d.modelId}.${d.field}: ${fmt(d.oldValue)} →✗ ${fmt(d.newValue)}`);
  }
}

console.log("");
console.log("═══ pi 无此模型 ═══");
if (missing.length === 0) {
  console.log("(无)");
} else {
  for (const key of missing) console.log(key);
}

console.log("");
console.log("═══ 统计 ═══");
console.log(`Luc 词典条目: ${lucTotal}`);
console.log(`pi 目录对上: ${matched}`);
console.log(`pi 无此模型: ${missing.length}`);
console.log(`字段差异: 应用 ${diffs.length} 处（涉及 ${new Set(diffs.map(d => `${d.provider}/${d.modelId}`)).size} 个模型）+ 排除 ${excludedHits.length} 处 = 共 ${diffs.length + excludedHits.length} 处`);
console.log(`模式: ${writeMode ? "write（已落盘）" : "dry-run（未落盘；--write 才写入）"}`);

if (writeMode) {
  const updated = applyDiffsToText(raw, diffs);

  // 写前校验：手术结果 parse 后必须与"内存中按 diff 更新的词典"语义一致
  const expected = JSON.parse(raw);
  for (const d of diffs) {
    expected[d.provider][d.modelId][d.field] = d.newValue;
  }
  const actual = JSON.parse(updated);
  if (!deepEqual(actual, expected)) {
    throw new Error("行级手术结果与预期不一致，拒绝写入（词典未被修改）");
  }

  fs.writeFileSync(DICT_PATH, updated);
  console.log(`已写入: ${DICT_PATH}`);
}

// ── 行级手术实现 ──

/**
 * 数一行里的括号净深度变化（忽略字符串字面量内部的括号）。
 */
function lineDepthDelta(line) {
  let delta = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{" || ch === "[") delta += 1;
    else if (ch === "}" || ch === "]") delta -= 1;
  }
  return delta;
}

/**
 * 在 lines 中定位一个对象块：`startPattern` 所在行为块首（含 `{`），
 * 返回 [startIndex, endIndex]（endIndex 为块的闭合行）。
 */
function findBlock(lines, startIndex, startPattern, limitIndex) {
  for (let i = startIndex; i < limitIndex; i++) {
    if (lines[i] === startPattern) {
      let depth = 0;
      for (let j = i; j < limitIndex; j++) {
        depth += lineDepthDelta(lines[j]);
        if (j > i || depth <= 0) {
          if (depth <= 0) return [i, j];
        }
      }
      throw new Error(`块未闭合: ${startPattern}`);
    }
  }
  return null;
}

function applyDiffsToText(text, pending) {
  let lines = text.split("\n");
  for (const d of pending) {
    lines = applyOneDiff(lines, d);
  }
  return lines.join("\n");
}

function applyOneDiff(lines, d) {
  const providerBlock = findBlock(lines, 0, `  "${d.provider}": {`, lines.length);
  if (!providerBlock) throw new Error(`未找到 provider 块: ${d.provider}`);
  const modelBlock = findBlock(lines, providerBlock[0] + 1, `    "${d.modelId}": {`, providerBlock[1] + 1);
  if (!modelBlock) throw new Error(`未找到 model 块: ${d.provider}/${d.modelId}`);
  const [mStart, mEnd] = modelBlock;

  // 只匹配模型对象顶层（相对深度 1）的字段行，避免误改 toolUse/compat 等嵌套同名键
  let depth = 0;
  for (let i = mStart; i <= mEnd; i++) {
    const atTopLevel = depth === 1;
    depth += lineDepthDelta(lines[i]);
    if (i === mStart || !atTopLevel) continue;
    const m = lines[i].match(new RegExp(`^(\\s*"${d.field}":\\s*)(.*?)(,?)$`));
    if (m) {
      if (m[2].endsWith("{") || m[2].endsWith("[")) {
        throw new Error(`${d.provider}/${d.modelId}.${d.field} 不是标量行，拒绝手术`);
      }
      lines[i] = `${m[1]}${JSON.stringify(d.newValue)}${m[3]}`;
      return lines;
    }
  }

  // 字段缺失：追加到模型对象末尾（闭合行之前），为前一行补逗号
  const prevIndex = mEnd - 1;
  if (prevIndex <= mStart) {
    // 空对象块 `"id": {}` 不在词典形态内，遇到即停
    throw new Error(`${d.provider}/${d.modelId} 模型块为空，无法追加字段`);
  }
  if (!lines[prevIndex].trimEnd().endsWith(",")) {
    lines[prevIndex] = `${lines[prevIndex].trimEnd()},`;
  }
  lines.splice(mEnd, 0, `      "${d.field}": ${JSON.stringify(d.newValue)}`);
  return lines;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}
