/**
 * rolling-summary-format.ts — rolling summary ⇄ compileEditableFacts 的格式契约单一源头 (#1628)
 *
 * 契约内容：
 *   - 摘要必须包含 重要事实 / Key Facts 与 事情经过 / Timeline 两个标题段，
 *     facts 段必须能被 compileEditableFacts 的标题段提取规则切出来；
 *   - prompt 端的输出格式要求（buildRollingSummaryFormatRequirements）、
 *     写入前结构校验（validateRollingSummaryFormat）、格式修复指令
 *     （buildRollingSummaryRepairPrompt / buildRollingSummaryRepairInput）、
 *     facts 段提取规则（extractFactSection / isEmptyFactSection）全部住在这里。
 *
 * 使用方：
 *   - lib/memory/session-summary.ts（legacy utility 产出路径）
 *   - lib/memory/memory-reflection-runner.ts（cache snapshot reflection 产出路径）
 *   - lib/memory/memory-ticker.ts（write 模式落盘前的最终守门）
 *   - lib/memory/compile.ts（compileEditableFacts 消费侧提取）
 *   - lib/memory/prompts/rolling-summary.ts（prompt 模板）
 *
 * 禁止任何调用方再各自维护一份标题名、提取规则或输出格式文案。
 *
 * 注意校验比 prompt 要求宽松是有意的：prompt 要求规范的两个三级标题，
 * 校验只拦截会破坏 compileEditableFacts 提取假设的结构（标题缺失、facts 段空体、
 * facts 段无法收尾），任意标题层级（含旧 H2 摘要）都接受。
 */

/** compileEditableFacts 提取 facts 段时接受的标题（任意 1-6 级，大小写不敏感）。约定 [0] 中文、[1] 英文 */
export const FACT_SECTION_TITLES = ["重要事实", "Key Facts"];

/** 事情经过段标题，用于界定 facts 段结束位置。约定 [0] 中文、[1] 英文 */
export const TIMELINE_SECTION_TITLES = ["事情经过", "Timeline"];

/**
 * prompt 文案中按 locale 引用 facts 段标题文本的单一来源。
 * 调用方禁止再硬编码标题字面量（标题改名时字面量会漂移，#1628 审查）。
 * @param {string} locale
 * @returns {string}
 */
export function getFactSectionTitle(locale = "zh-CN") {
  return isZhLocale(locale) ? FACT_SECTION_TITLES[0] : FACT_SECTION_TITLES[1];
}

/**
 * prompt 文案中按 locale 引用 timeline 段标题文本的单一来源。
 * @param {string} locale
 * @returns {string}
 */
export function getTimelineSectionTitle(locale = "zh-CN") {
  return isZhLocale(locale) ? TIMELINE_SECTION_TITLES[0] : TIMELINE_SECTION_TITLES[1];
}

/**
 * 写入前结构校验失败后允许的 LLM 格式修复次数上限（初次生成之外的额外调用数）。
 * 修复带着校验失败反馈重发，一次修不好通常说明模型/配置有更深的问题，
 * 继续盲试只会烧 token，所以收紧为 1。
 */
export const MAX_ROLLING_SUMMARY_FORMAT_REPAIRS = 1;

function isZhLocale(locale) {
  return String(locale || "").startsWith("zh");
}

/**
 * 输出格式要求 prompt 块。两条产出路径（legacy utility prompt 与
 * memory reflection suffix）以及 prompts/rolling-summary.ts 模板共用。
 * @param {string} locale
 * @returns {string}
 */
export function buildRollingSummaryFormatRequirements(locale = "zh-CN") {
  if (!isZhLocale(locale)) {
    return `## Output Format
The final answer must contain exactly two third-level headings, with fixed text and order:
1. The first line must be \`### Key Facts\`
2. The second heading must be \`### Timeline\`

The body under both headings must use unordered lists. Each list item must start with \`- \`.
If a section has no content, output one list item: \`- None\`.
Do not output any preamble, conclusion, XML tags, or code fences outside those headings.`;
  }

  return `## 输出格式
最终答案必须只包含两个三级标题，标题文本和顺序固定：
1. 第一行必须是 \`### 重要事实\`
2. 第二个标题必须是 \`### 事情经过\`

两个标题下的正文都必须使用无序列表。列表项必须以 \`- \` 开头。
如果某一节没有内容，也要输出一个列表项：\`- 无\`。
标题之外不要输出前言、后记、XML 标签或代码块。`;
}

/**
 * 格式修复调用的稳定 system 指令（utility 路径放 systemPrompt，
 * reflection 路径拼进修复 suffix）。
 * @param {string} locale
 * @returns {string}
 */
export function buildRollingSummaryRepairPrompt(locale = "zh-CN") {
  const requirements = buildRollingSummaryFormatRequirements(locale);
  if (!isZhLocale(locale)) {
    return `You are the format repairer for the memory system's rolling summaries. The previous summary draft violates the required fixed structure and cannot be parsed by the memory system. Rearrange the information in the given draft into the required structure: do not add, remove, or rewrite any factual content, do not explain, and output only the full repaired summary.

${requirements}`;
  }

  return `你是记忆系统滚动摘要的格式修复器。上一步生成的摘要草稿不符合要求的固定结构，记忆系统无法解析。请把给定草稿中的信息原样重排进规定结构：不要新增、删除或改写事实内容，不要解释，直接输出修复后的摘要全文。

${requirements}`;
}

/**
 * 格式修复调用的动态输入：校验失败原因 + 待修复草稿。
 * @param {{ locale?: string, issues?: string[], summaryText?: string }} opts
 * @returns {string}
 */
export function buildRollingSummaryRepairInput({ locale = "zh-CN", issues = [], summaryText = "" } = {}) {
  const isZh = isZhLocale(locale);
  const issuesLabel = isZh ? "## 校验失败原因" : "## Validation Failures";
  const draftLabel = isZh ? "## 待修复草稿" : "## Draft To Repair";
  const issueLines = (Array.isArray(issues) ? issues : [])
    .map((issue) => `- ${String(issue || "").trim()}`)
    .filter((line) => line !== "- ")
    .join("\n");

  return `${issuesLabel}

${issueLines || (isZh ? "- 未知" : "- unknown")}

${draftLabel}

<draft-summary>
${String(summaryText || "")}
</draft-summary>`;
}

/**
 * 解析 markdown 标题行（1-6 级）。
 * @param {string} line
 * @returns {{ level: number, title: string } | null}
 */
export function parseMarkdownHeading(line) {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(String(line || ""));
  if (!match) return null;
  return {
    level: match[1].length,
    title: match[2].replace(/[ \t]+#+[ \t]*$/, "").trim(),
  };
}

function normalizeHeadingTitle(title) {
  return String(title || "").trim().toLowerCase();
}

/**
 * 提取 markdown 中第一个命中标题段的正文（到下一个同级或更高级标题为止）。
 * 这是 compileEditableFacts 的提取规则本体：标题任意层级、大小写不敏感。
 * @param {string} markdown
 * @param {string[]} titles
 * @returns {string}
 */
export function extractMarkdownSection(markdown, titles) {
  if (!markdown) return "";
  const wanted = new Set(titles.map(normalizeHeadingTitle));
  const lines = String(markdown).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const heading = parseMarkdownHeading(lines[i]);
    if (!heading || !wanted.has(normalizeHeadingTitle(heading.title))) continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const nextHeading = parseMarkdownHeading(lines[j]);
      if (nextHeading && nextHeading.level <= heading.level) break;
      body.push(lines[j]);
    }
    return body.join("\n").trim();
  }

  return "";
}

/**
 * 摘要里是否存在 facts 段标题（不要求正文非空）。
 * 读取侧用它区分"旧自由格式摘要（显式跳过并记录）"和
 * "合规摘要但本次没有新事实（正常静默）"。
 * @param {string} markdown
 * @returns {boolean}
 */
export function hasFactSectionHeading(markdown) {
  if (!markdown) return false;
  const wanted = new Set(FACT_SECTION_TITLES.map(normalizeHeadingTitle));
  for (const line of String(markdown).split(/\r?\n/)) {
    const heading = parseMarkdownHeading(line);
    if (heading && wanted.has(normalizeHeadingTitle(heading.title))) return true;
  }
  return false;
}

/**
 * 提取摘要中的 facts 段正文。
 * @param {string} markdown
 * @returns {string}
 */
export function extractFactSection(markdown) {
  return extractMarkdownSection(markdown, FACT_SECTION_TITLES);
}

/**
 * facts 段正文是否是显式空标记（- 无 / - None）。
 * @param {string} text
 * @returns {boolean}
 */
export function isEmptyFactSection(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return true;
  return lines.every((line) => {
    const itemText = line.replace(/^[-*+][ \t]+/, "").trim().toLowerCase();
    return itemText === "无" || itemText === "none";
  });
}

function findHeading(lines, titles) {
  const wanted = new Set(titles.map(normalizeHeadingTitle));
  for (let i = 0; i < lines.length; i++) {
    const heading = parseMarkdownHeading(lines[i]);
    if (heading && wanted.has(normalizeHeadingTitle(heading.title))) {
      return { index: i, level: heading.level };
    }
  }
  return null;
}

/**
 * 写入前结构校验：摘要是否满足 compileEditableFacts 的提取假设。
 *
 * 拦截四类破坏提取的结构问题：
 *   1. 缺 facts 段标题（compileEditableFacts 抽不到任何内容）
 *   2. 缺 timeline 段标题（facts 段无法和叙事内容区分）
 *   3. timeline 标题比 facts 标题层级更深且在其后（facts 段收不了尾，
 *      叙事内容会整段灌进 facts）
 *   4. facts 段正文为空（契约要求空时显式写 - 无 / - None）
 *
 * @param {string} text
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateRollingSummaryFormat(text) {
  const issues = [];
  const lines = String(text || "").split(/\r?\n/);

  const fact = findHeading(lines, FACT_SECTION_TITLES);
  const timeline = findHeading(lines, TIMELINE_SECTION_TITLES);

  if (!fact) {
    issues.push('missing fact section heading ("### 重要事实" / "### Key Facts")');
  }
  if (!timeline) {
    issues.push('missing timeline section heading ("### 事情经过" / "### Timeline")');
  }
  if (fact && timeline && timeline.index > fact.index && timeline.level > fact.level) {
    issues.push("timeline heading is nested deeper than the fact heading, so the fact section cannot be delimited");
  }
  if (fact) {
    const body = extractFactSection(text);
    if (!body) {
      issues.push('fact section body is empty; write "- 无" / "- None" when there are no facts');
    }
  }

  return { ok: issues.length === 0, issues };
}
