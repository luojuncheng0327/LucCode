/**
 * DeepSeek 请求缺少输出预算时的兜底
 *
 * **这里不决定已有预算的大小。** Pi SDK 的 clampMaxTokensToContext 已经按
 * `min(模型输出上限, 剩余窗口 - 安全余量)` 算好了，它掌握 payload 层拿不到的
 * 真实 token 数。兼容层只做协议翻译，不覆盖这个值 —— 覆盖只会在剩余窗口本来
 * 就紧张时把请求推过窗口边界。思考档位决定想多深，剩余窗口决定能多长，两个
 * 正交的维度不该互相绑定。
 *
 * 唯一保留的动作：请求完全没带预算时补一个值。官方文档没有公布 max_tokens 的
 * 默认值（取值范围一栏指向定价页，而定价页只写了最大 384K），只建议显式声明，
 * 所以不赌那个默认值。
 *
 * 官方文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
 */

/**
 * 请求完全没带输出预算时的兜底值。
 *
 * 给一个够用又不顶格的值：顶格需要知道剩余窗口，而走到这条分支恰恰说明上游
 * 没算过。
 */
const DEEPSEEK_MISSING_BUDGET_FALLBACK = 65536;

function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 请求没带输出预算时该补上的值。已有预算的请求不该调用这里。
 *
 * @param {object|null|undefined} model
 * @returns {number}
 */
export function resolveMissingOutputBudget(model) {
  const modelLimit = positiveInteger(model?.maxTokens || model?.maxOutput);
  return modelLimit
    ? Math.min(modelLimit, DEEPSEEK_MISSING_BUDGET_FALLBACK)
    : DEEPSEEK_MISSING_BUDGET_FALLBACK;
}
