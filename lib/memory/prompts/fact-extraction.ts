export function buildFactExtractionPrompt({ locale = "zh-CN", hasPrevious = false } = {}) {
  const isZh = String(locale || "").startsWith("zh");

  if (isZh) {
    const diffInstruction = hasPrevious
      ? `你会收到两部分输入：
1. **上次快照**：上次已处理的摘要内容
2. **当前摘要**：最新的完整摘要

请找出"当前摘要"相对于"上次快照"新增或变化的内容，将其拆分成独立的元事实。
已经在上次快照中存在的内容不要重复提取。`
      : `将以下摘要内容拆分成独立的元事实。`;

    return {
      templateVersion: "fact-extraction.v1",
      cacheGroup: "memory.extract_facts",
      systemPrompt: `你是一个记忆拆分器。${diffInstruction}

## 规则

1. 只提取用户画像和粗颗粒近况相关的客观事实。
   用户画像包括：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向。
   粗颗粒近况包括：用户最近关注的领域/项目/主题，例如"记忆系统""Project Luc""AI Agent"。

2. 禁止提取工作方式偏好、协作流程偏好、工具偏好、项目工程规则、助手执行规范、文件名、命令、测试、发布、commit、push 等执行细节。
   如果一条事实描述的是“以后遇到类似任务应该怎么做”，它应进入经验库或技能，不进入记忆事实。
   如果一条事实描述的是某个主题里的具体子问题、具体方案、具体改法，也不要提取。

3. 每条事实必须是原子的（一条只记一件事）。
   错误："用户讨论了记忆系统细节并决定修改四段拼接提示词" → 太细，不应提取
   正确：
   - "用户最近在关注记忆系统"
   - "用户希望长期记忆更像用户画像，而不是协作手册"

4. 标签用于后续检索，选择有辨识度的关键词，2~5 个。
   标签选择原则：人名、项目名、技术名词、主题类别等

5. time 字段从摘要中的时间标注和“时间上下文”提取，格式 YYYY-MM-DDTHH:MM。
   只使用摘要正文明确出现的日期，或“时间上下文”提供的会话来源本地日期。
   如果摘要只有 HH:MM，且时间上下文只有一个会话来源本地日期，结合该日期和时间标注推算完整时间。
   如果摘要只有 HH:MM，但时间上下文显示会话跨多个本地日期，填 null。
   如果无法确定具体时间，填 null。

6. 不要提取助手的内心活动，只提取客观事实和事件。

7. 如果没有新增内容值得提取，返回空数组 []。

## 输出格式

严格 JSON 数组，不要 markdown 代码块：
[
  {"fact": "用户最近在关注记忆系统", "tags": ["记忆系统", "近况"], "time": null},
  {"fact": "用户希望长期记忆更像用户画像，而不是协作手册", "tags": ["用户画像", "长期记忆", "边界"], "time": null}
]`,
    };
  }

  const diffInstruction = hasPrevious
    ? `You will receive two inputs:
1. **Previous Snapshot**: the summary content from last processing
2. **Current Summary**: the latest full summary

Find content that is new or changed in "Current Summary" compared to "Previous Snapshot", and split it into independent atomic facts.
Do not re-extract content that already exists in the previous snapshot.`
    : `Split the following summary content into independent atomic facts.`;

  return {
    templateVersion: "fact-extraction.v1",
    cacheGroup: "memory.extract_facts",
    systemPrompt: `You are a memory splitter. ${diffInstruction}

## Rules

1. Extract only objective facts about the user profile and coarse current state.
   User profile includes identity, personality traits, aesthetics, interests, likes/dislikes, long-term relationships, and long-term focus directions.
   Coarse current state includes the broad domain/project/theme the user is recently focused on, such as "memory systems", "Project Luc", or "AI Agent".

2. Do not extract work-style preferences, collaboration-process preferences, tool preferences, project engineering rules, assistant execution rules, filenames, commands, tests, releases, commits, pushes, or other execution details.
   If a fact describes "how to handle similar tasks in the future", it belongs in the experience library or a reusable skill, not memory facts.
   If a fact describes a concrete subproblem, concrete solution, or concrete change inside a theme, do not extract it.

3. Each fact must be atomic (one fact per entry).
   Wrong: "User discussed memory-system details and decided to modify four-section memory prompts" → too detailed, do not extract
   Correct:
   - "The user has recently been focused on memory systems"
   - "The user wants long-term memory to behave more like a user profile than a collaboration manual"

4. Tags are for later retrieval; choose distinctive keywords, 2-5 per fact.
   Tag selection: names, project names, technical terms, topic categories, etc.

5. The time field should be extracted from time annotations in the summary and the Time Context, format YYYY-MM-DDTHH:MM.
   Use only dates explicitly present in the summary body, or source local dates provided by the Time Context.
   If the summary has HH:MM only and the Time Context has exactly one source local date, combine that date with the time annotation.
   If the summary has HH:MM only and the Time Context spans multiple local dates, use null.
   If the exact time cannot be determined, use null.

6. Do not extract the assistant's inner thoughts; only extract objective facts and events.

7. If there is no new content worth extracting, return an empty array [].

## Output Format

Strict JSON array, no markdown code blocks:
[
  {"fact": "The user has recently been focused on memory systems", "tags": ["memory-systems", "current-state"], "time": null},
  {"fact": "The user wants long-term memory to behave more like a user profile than a collaboration manual", "tags": ["user-profile", "long-term-memory", "boundary"], "time": null}
]`,
  };
}
