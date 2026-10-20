import {
  buildRollingSummaryFormatRequirements,
  getFactSectionTitle,
  getTimelineSectionTitle,
} from "../rolling-summary-format.ts";

export function buildRollingSummaryPrompt({
  locale = "zh-CN",
  agentName = "",
  userName = "",
  identityAndPersonality = "",
  userProfile = "",
  existingMemory = "",
  roster = "",
} = {}) {
  const isZh = String(locale || "").startsWith("zh");
  const resolvedAgentName = agentName || (isZh ? "这个 Agent" : "this agent");
  const resolvedUserName = userName || (isZh ? "主人" : "the user");
  // 标题文本统一从格式契约取，prompt 文案禁止硬编码标题字面量
  const factTitle = getFactSectionTitle(locale);
  const timelineTitle = getTimelineSectionTitle(locale);

  if (!isZh) {
    return {
      templateVersion: "rolling-summary.v1",
      cacheGroup: "memory.rolling_summary",
      systemPrompt: `You are ${resolvedAgentName}. You are reviewing a conversation you just experienced.

Review the new conversation from your own perspective and decide what deserves long-term memory.

## Your Identity And Personality
${identityAndPersonality || "(Not provided)"}

## Owner / User Settings
${userProfile || "(Not provided)"}

## Your Existing Long-Term Memory
This is the memory you already had before this conversation began. Do not rewrite it merely because it appears here; record only what this conversation updates, contradicts, or reinforces.

${existingMemory || "(No existing long-term memory)"}

## Roster
${roster || "(No other agents)"}

${buildRollingSummaryFormatRequirements(locale)}

## Timeline Requirements
In the ${timelineTitle} section, record what happened in this session in chronological order. Every non-empty list item must include a YYYY-MM-DD HH:MM timestamp copied from the message timestamps; do not use date-less HH:MM only. Work-related content may only be kept at the broad-theme level.

Do not extract work-style preferences, collaboration-process preferences, tool preferences, engineering rules, or task details. When in doubt, skip. Better miss than mis-record.`,
    };
  }

  return {
    templateVersion: "rolling-summary.v1",
    cacheGroup: "memory.rolling_summary",
    systemPrompt: `你是 ${resolvedAgentName}。你正在整理自己刚刚经历的一段对话。

下面是你在本次对话开始前已经拥有的设定和记忆。它们是背景，不是新增事实。请从自己的视角审视本次对话，判断哪些新信息值得进入长期记忆。

## 你的身份与人格
${identityAndPersonality || "（未提供）"}

## 主人设定
${userProfile || "（未提供）"}

## 你已有的长期记忆
这是你在本次对话开始前已经拥有的记忆。不要因为它出现在这里就重复写入；只有本次对话更新、反驳、强化它时才记录变化。

${existingMemory || "（暂无已有长期记忆）"}

## 花名册
花名册告诉你同处于这个系统里的别的 Agent。它只用于理解对话中的 Agent 名字和协作语境，不要把花名册本身当作新增记忆。

${roster || "（没有其他 Agent）"}

## 核心原则
记忆的核心职责是维护你对${resolvedUserName}的理解，让你以后更自然地理解这个人、你们的关系、长期项目和共同语境。摘要仍然以用户侧为中心：优先记录${resolvedUserName}是谁、喜欢什么、在意什么、最近关注什么大主题。

${buildRollingSummaryFormatRequirements(locale)}

## 内容要求

**${factTitle}一节**
只记录用户画像类信息：身份属性、人格特质、审美和兴趣、喜欢或讨厌的事物、长期关系、生活或创作取向、近期正在关注/投入的大主题。没有则写 \`- 无\`。

不要抽：
- 工作方式偏好：用户希望助手怎样审查、规划、调研、实现、测试、汇报、commit、push
- 协作流程偏好：用户要求的步骤、确认点、验证顺序、上下文管理方式
- 工具和平台偏好：某次任务中使用什么工具、命令、文件、模型、目录
- 工程纪律和项目规则：这些属于项目文档或系统规则，不属于用户画像记忆
- 一次任务里的格式、标准、临时判断

判别标准：
- 如果这条信息回答的是“用户是谁、喜欢什么、在意什么”，可以抽。
- 如果这条信息回答的是“和用户工作时该怎么做”，不要抽。
- 如果这条信息回答的是“用户最近在关注哪个领域/项目/主题”，只保留大主题，不保留该主题里的细节。
- 拿不准一律不抽。宁可漏，不可错。

**${timelineTitle}一节**
按时间顺序记录本 session 发生了什么，每个非空条目都必须从消息时间戳提取 YYYY-MM-DD HH:MM 时间标注，不要只写 HH:MM。工作相关内容只允许保留到大主题层级。

## 规则
1. 有已有摘要时：新旧内容合并，同一件事以新信息为准，不要重复
2. 时间标注从消息时间戳提取（YYYY-MM-DD HH:MM 格式）
3. 只记录客观事实，不记录 MOOD 或助手内心想法
4. 用户提供的文件/附件：只记录文件名和用途，忽略文件的具体内容
5. 助手的长篇输出（文章、代码、分析等）：只记录产出了什么，不摘录内容
6. 宁短勿长：摘要长度应与对话的实际信息密度成正比，闲聊几句只需一两行`,
  };
}
