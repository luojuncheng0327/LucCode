export function buildCompileTodayPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-today.v2",
    cacheGroup: "memory.compile.today",
    systemPrompt: isZh
      ? `你会收到「上一版今日草稿」和「新增或修订的时间线条目（delta）」，请据此更新出一份新的"用户近况与大主题清单"草稿。

处理原则：
- 上一版草稿是今天已经沉淀的内容，默认保留；delta 里标注"取代先前相关记述"的条目，说明对应的旧内容已经过时或不准确，请用它更新/替换草稿里的相关部分，而不是并列保留新旧两种说法
- delta 里没有标注"取代"的条目是今天新发生的事，正常并入
- 把同一主题/项目的多次往返归并为一件事，不要逐条流水账
- 每条输出必须保留粗时间锚点，例如"上午"、"07:20 左右"、"傍晚"；不要把时间完全删掉
- 记忆的核心职责是维护用户模型，优先记录用户是谁、喜欢什么、在意什么、最近关注什么
- 工作相关内容只允许保留到大主题层级：只写用户最近关注的领域/项目/主题，不写该主题里的细节

可以记录：
- 用户的身份、人格特质、审美、兴趣、喜欢或讨厌的事物
- 用户最近关注的大主题，例如"记忆系统""Project Luc""AI Agent"
- 用户生活、创作、关系或长期关注方向的变化

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 任务过程中的方法论选择、工具偏好、格式要求、术语规则
- 具体子问题、具体方案、具体改法、具体测试或发布流程
- 助手具体产出的内容（"生成了一篇关于 X 的文章"够了，不要摘录文章内容）
- 来回修改、重试、被打断又恢复这类过程波动

输出 3-5 条粗颗粒事件，每条 1-2 句。最多 300 字。一天平淡就写得短。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `You will receive the "previous today draft" and "new or revised timeline entries (delta)". Update them into a new "user-current-state and broad-theme list" draft.

Processing principles:
- The previous draft is what today has already settled; keep it by default. Delta entries marked "supersedes prior mention" mean the corresponding old content is outdated or inaccurate — use them to update/replace the related part of the draft rather than keeping both the old and new statements side by side
- Delta entries without a "supersedes" marker are new things that happened today; merge them in normally
- Merge multiple back-and-forth on the same topic/project into ONE event; do not enumerate line by line
- Each output item must keep a coarse time anchor, such as "morning", "around 07:20", or "evening"; do not remove time entirely
- Memory's core job is to maintain a user model: prioritize who the user is, what they like, what they care about, and what they are broadly focused on recently
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme

May record:
- The user's identity, personality traits, aesthetics, interests, likes, and dislikes
- Broad themes the user is currently focused on, such as "memory systems", "Project Luc", or "AI Agent"
- Changes in the user's life, creative work, relationships, or long-term areas of attention

Do NOT record:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Task-level methodology choices, tool preferences, format requirements, terminology rules
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Specific content of assistant's output ("wrote an article about X" is enough; do not excerpt the article)
- Revisions, retries, interruptions and resumptions — these are process noise

Output 3-5 coarse events, 1-2 sentences each. Max 180 words. Keep it short on quiet days. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileDailyPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-daily.v2",
    cacheGroup: "memory.compile.daily",
    systemPrompt: isZh
      ? `你会收到这一天的时间线条目或最终版"今日草稿"（当天结束时对用户近况的整理稿），请把它蒸馏成两三句话的简短日记条目。

关键定位：这是给一周概览用的一条记录，不是详细日志。读的人只需要一眼看出这一天大致发生了什么、用户在关注什么。

提炼原则：
- 把同一主题/项目的多次往返归并为一件事，不要逐条流水账
- 保留这一天的粗时间感，例如"上午"、"傍晚"或一个代表性 HH:MM；不要写成无时间锚点的主题标签
- 记忆的核心职责是维护用户模型：优先记录用户是谁、喜欢什么、在意什么、这天关注什么
- 工作相关内容只允许保留到大主题层级：只写用户这天关注的领域/项目/主题，不写该主题里的细节

不要记录：
- 不要记录执行步骤、文件名、工具、命令、检查顺序、协作偏好、工作细节
- 任务过程中的方法论选择、工具偏好、格式要求、术语规则
- 具体子问题、具体方案、具体改法、具体测试或发布流程
- 助手具体产出的内容
- 来回修改、重试、被打断又恢复这类过程波动

只输出两三句话，最多 60 字。这天平淡就写得更短。不要输出日期抬头（调用方会自行加上日期），不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文。`
      : `You will receive that day's timeline entries or final "today draft" (the end-of-day writeup of the user's current state). Distill it into a short two-to-three sentence diary entry.

Positioning: this is one entry feeding a weekly overview, not a detailed log. The reader only needs a glance at what broadly happened that day and what the user was focused on.

Principles:
- Merge multiple back-and-forth on the same topic/project into ONE event; do not enumerate line by line
- Preserve the day's coarse sense of time, such as "morning", "evening", or one representative HH:MM; do not turn it into timeless topic labels
- Memory's core job is to maintain a user model: prioritize who the user is, what they like, what they care about, and what they focused on that day
- Work-related content may only be kept at the broad-theme level: record the domain/project/theme, not details inside that theme

Do NOT record:
- Execution steps, filenames, tools, commands, validation order, collaboration preferences, or work details
- Task-level methodology choices, tool preferences, format requirements, terminology rules
- Specific subproblems, concrete solutions, concrete code changes, tests, or release flows
- Specific content of assistant's output
- Revisions, retries, interruptions and resumptions — these are process noise

Output only two to three sentences, max 30 words. Keep it shorter on quiet days. Do not output a date heading (the caller adds the date). Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileLongtermPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-longterm.v1",
    cacheGroup: "memory.compile.longterm",
    systemPrompt: isZh
      ? `请综合「上一份长期情况」和「新沉淀内容」，重写成一份新的长期情况。必须控制在 400 字以内。

记忆不是工作日志，也不是协作手册。到 longterm 这一层，记录已经是最稳定的用户画像核心。只保留"如果一年后回看仍然适合用来理解用户这个人"的内容：
- 用户的身份、人格特质、审美、兴趣、价值取向
- 用户长期喜欢或讨厌的事物
- 用户长期关系和稳定生活背景
- 用户持续关注或投入的长期关注方向

去掉这些"单次性内容"：
- 某天/某周完成的具体任务
- 用户偏好的工作方式、协作流程、工程纪律
- 工具使用习惯、检查顺序、汇报格式
- 某类任务的处理方法
- 助手的具体产出内容
- 任何"这周/那周"级别的细节

处理方式：
- 不要追加，不要把旧内容和新内容分开复述
- 必须做取舍、抽象、合并，把重复或过细的信息压成更高层概括
- 如果上一份长期情况已经很长，优先概括旧内容，再吸收真正重要的新内容

不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。`
      : `Synthesize "Previous long-term context" and "Newly settled content", then rewrite them into one new long-term context. You must keep the result under 240 words.

Memory is not a work log or collaboration manual. At the longterm layer, the record is the most stable user-profile core. Keep only what would still help understand the user as a person "if reviewed a year from now":
- The user's identity, personality traits, aesthetics, interests, and values
- Things the user has long liked or disliked
- Long-term relationships and stable life background
- Persistent long-term focus directions

Remove these "one-off" contents:
- Specific tasks completed on a particular day or week
- User-preferred work style, collaboration process, or engineering discipline
- Tool habits, validation order, report format
- How to handle a class of task
- Specific content of assistant's output
- Any "this week / that week" level details

How to process:
- Do not append; do not restate old and new content separately
- Make tradeoffs, abstract, and merge; compress repeated or overly specific details into higher-level facts
- If the previous long-term context is already long, summarize it first, then absorb only genuinely important new content

Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.`,
  };
}

export function buildCompileEditableFactsPrompt(locale = "zh-CN") {
  const isZh = String(locale || "").startsWith("zh");
  return {
    templateVersion: "compile-editable-facts.v1",
    cacheGroup: "memory.compile.editable_facts",
    systemPrompt: isZh
      ? "请综合「当前可信 Facts」和「新增候选 Facts」，重写成一份新的重要事实。必须控制在 200 字以内，宁可概括合并，也不要堆叠罗列。当前可信 Facts 代表用户或 Agent 已确认过的稳定信息，默认作为基础，但如果过长，必须压成更高层概括；新增候选 Facts 只在能纠正、补充或更新稳定用户画像时吸收。只保留稳定的、跨时间有效的用户画像：身份、人格特质、审美、兴趣、喜欢或讨厌的事物、长期关系、长期关注方向。新增候选 Facts 与当前可信 Facts 冲突时，以新增候选 Facts 修正当前事实。不要追加，不要把两部分分别复述。不要保留工作方式、协作流程、工具偏好、执行细节。不要输出 Markdown 标题，不要以 #、##、### 开头；直接输出正文列表或段落。"
      : "Synthesize \"Current Trusted Facts\" and \"New Candidate Facts\", then rewrite them into one new Key Facts section. You must keep the result under 120 words; prefer concise abstraction and merging over stacked lists. Current Trusted Facts are stable information confirmed by the user or agent and are the base, but if they are too long, compress them into higher-level facts. Absorb New Candidate Facts only when they correct, supplement, or update stable user-profile information. Keep only stable, time-persistent user-profile facts: identity, personality traits, aesthetics, interests, likes/dislikes, long-term relationships, and long-term focus directions. When New Candidate Facts conflict with Current Trusted Facts, use them to correct the current facts. Do not append. Do not restate the two inputs separately. Do not keep work style, collaboration process, tool preferences, or execution details. Do not output Markdown headings. Do not start with #, ##, or ###; output body text only.",
  };
}
