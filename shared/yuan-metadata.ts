/**
 * yuan-metadata — 每一家 yuan 的结构性事实，与配色、头像等观感无关的那部分。
 *
 * 目前只有一条：这家 yuan 的「思考区块」在提示词模板里叫什么名字。
 * 界面要把这个名字标给用户看，必须从这里读，不许去扫模板正文找二级标题——
 * 模板是给模型看的散文，靠它的措辞反推结构等于把契约建在流沙上。
 *
 * kong 的 thinkingBlock 是 null：它本来就没有这个区块，模板是空的。
 * null 不是「查不到」的占位，是一条明确声明。
 *
 * tests/yuan-metadata.test.ts 双向锁住这张表和 lib/yuan/*.md：
 * 声明了名字模板里就必须有，没声明模板里就必须没有，任一侧漂移都会红。
 *
 * 观感相关的符号、配色、头像见 shared/yuan-visuals.ts（那张表不含 kong，
 * 因为 kong 没有独立形象，落到 luc 的默认视觉上）。
 */

export interface YuanMetadata {
  yuan: string;
  /** 提示词模板里那个二级标题的原文；null 表示这家 yuan 没有思考区块 */
  thinkingBlock: string | null;
}

export const YUAN_METADATA: Readonly<Record<string, Readonly<YuanMetadata>>> = Object.freeze({
  luc: Object.freeze({ yuan: "luc", thinkingBlock: "MOOD" }),
  butter: Object.freeze({ yuan: "butter", thinkingBlock: "PULSE" }),
  ming: Object.freeze({ yuan: "ming", thinkingBlock: "沉思" }),
  kong: Object.freeze({ yuan: "kong", thinkingBlock: null }),
});

/**
 * 查一家 yuan 的思考区块名。
 *
 * 表里没有的 yuan 同样返回 null——「没有声明过思考区块」和「声明了没有」在
 * 展示上是同一件事：不标 tag。这不是兜底猜测，因为表的完整性由一致性测试
 * 对着 lib/yuan/*.md 兜着，真实的 yuan 漂移会在测试里先红，轮不到运行时。
 */
export function getYuanThinkingBlock(yuan?: string | null): string | null {
  const key = String(yuan || "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(YUAN_METADATA, key)) return null;
  return YUAN_METADATA[key].thinkingBlock;
}
