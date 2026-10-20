# 社区插件开发指南

> 本文档面向社区开发者，描述如何开发用户可安装的插件。
> 系统插件（内嵌到 app 的内置功能）使用相同的插件格式，放在项目 `plugins/` 目录下随 app 打包分发。

## 快速开始

1. 创建一个文件夹，放入一个工具文件：

```text
my-plugin/
└── tools/
    └── hello.js
```

```js
// tools/hello.js
export const name = "hello";
export const description = "Say hello to someone";
export const parameters = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};
export async function execute(input) {
  return `Hello, ${input.name}!`;
}
```

2. 打开 LucCode → 设置 → 插件，把文件夹拖进安装区（或压缩成 .zip 拖入）
3. 安装后 Agent 立即可以调用 `my-plugin_hello` 工具
4. 卸载：在插件页面点删除按钮

## 从想法到插件

开发时先选插件形态，再按本页后续章节配置清单、运行时能力与界面：

| 形态 | 适合什么 | 权限 |
|------|----------|------|
| Tool-only | 没有 UI，只给 Agent 增加工具能力 | `restricted` |
| Runtime | 需要生命周期、EventBus、后台任务、动态工具 | `full-access` |
| UI | 需要 page / widget / WebView/iframe card / `chat.surface` | `full-access` |
| Marketplace entry | 让插件出现在插件市场 | 写入 `luccode-plugins/plugins/<id>.yaml` |

推荐先用 `luc-plugin-creator` 脚手架生成，再按需求删减：

```bash
python3 skills2set/luc-plugin-creator/scripts/create_luc_plugin.py "My Plugin" --path examples/plugins --kind full
```

调试顺序：本地文件夹安装 → 设置页诊断 → 补 README/manifest → 需要公开时再写 `luccode-plugins` 市场条目。

### Agent 辅助开发循环

当 Luc / Codex 这类 Agent 直接帮用户开发插件时，优先走 dev loop，而不是把半成品复制到正式插件目录：

1. 插件源码放在当前工作区，或 `${LUC_HOME}/plugin-dev-sources/`。
2. 调用 EventBus `plugin.dev.install` 或 HTTP `POST /api/plugins/dev/install`，把源码复制到 `${LUC_HOME}/plugins-dev/<pluginId>` 并加载。
3. 修改源码后调用 `plugin.dev.reload` 或 `POST /api/plugins/dev/:id/reload`。
4. 需要控制生命周期时调用 `plugin.dev.disable`、`plugin.dev.enable`、`plugin.dev.reset`、`plugin.dev.uninstall`，或对应 HTTP：`PUT /api/plugins/dev/:id/enabled`、`POST /api/plugins/dev/:id/reset`、`DELETE /api/plugins/dev/:id`。
5. 工具插件用 `plugin.dev.invokeTool` 或 `POST /api/plugins/dev/:id/tools/:toolName/invoke` 做 smoke test。调用体优先传 `sessionId` 或 `sessionRef`；`sessionPath` 只作为旧插件兼容 locator。
6. 诊断用 `plugin.dev.diagnostics` 或 `GET /api/plugins/dev/diagnostics`。

Agent 可见的 dev 工具默认关闭。用户需要在设置 → 插件 → 权限中开启"允许 Agent 插件开发工具"，开启后 Agent 才会看到 `plugin_dev_install`、`plugin_dev_reload`、`plugin_dev_disable`、`plugin_dev_enable`、`plugin_dev_reset`、`plugin_dev_uninstall`、`plugin_dev_invoke_tool`、`plugin_dev_diagnostics`、`plugin_dev_list_surfaces`、`plugin_dev_describe_surface`、`plugin_dev_run_scenario`。

开发态权限来自 Luc 记住的 dev slot，而不是 manifest 自己声明。`devRunId` 是一次 dev install/reload 的运行护栏，调用 enable/disable/reset/uninstall 时建议带上，避免旧上下文误操作新的开发槽。dev 操作只允许作用于 `${LUC_HOME}/plugins-dev/` 中的 runtime copy，不会写入 `${LUC_HOME}/plugins/`，也不会污染正式插件的禁用偏好。

`full-access` dev 插件必须显式传 `allowFullAccess: true`，全局社区插件开关不会自动授权开发态插件。

UI 插件调试时，先用 `plugin.dev.listSurfaces` 找到 page / widget，再用 `plugin.dev.describeSurfaceDebug` 获取 element-first 调试说明。Agent 应先读取可访问性树、文本、role、label 等语义元素并直接点击/输入，截图只用于视觉确认、布局检查，或语义信息不足时兜底。

#### Dev Scenarios

`manifest.json` 可以声明 `dev.scenarios`，只供本地开发和 Agent smoke test 使用，生产运行时会忽略这组字段。

```json
{
  "dev": {
    "scenarios": [
      {
        "id": "hello-tool",
        "steps": [
          { "invokeTool": { "name": "hello", "input": { "name": "Luc" } } },
          { "expectToolText": "hello Luc" }
        ]
      }
    ]
  }
}
```

`invokeTool` 步骤可以包含 `sessionId`、`sessionRef`、`sessionPath` 和 `agentId`，其中 `sessionId/sessionRef` 是当前推荐的 session 身份；`sessionPath` 只保留给旧插件和 locator 兼容。第一阶段支持 `invokeTool`、`expectToolText` 和 `openSurface`。会改外部状态的场景必须声明 `"destructive": true`，运行时还要显式传 `allowDestructive: true`。

## 安装与管理

### 安装方式

- **拖拽安装**：将插件文件夹或 .zip 拖入设置 → 插件页面的安装区
- **文件选择器**：点击安装区，通过文件选择器选择插件文件夹或 .zip
- **手动安装**：将插件目录放到 `${LUC_HOME}/plugins/`。实际目录可在设置 → 插件页面或 `/api/plugins/settings` 的 `plugins_dir` 查看

### 管理操作

所有操作即时生效，无需重启：

- **启用/禁用**：每个插件有独立开关
- **删除**：移除插件代码，插件数据（`plugin-data/{pluginId}/`）保留
- **升级**：拖入同名新版本会自动 unload 旧版并加载新版；生命周期资源由 `onunload` / disposables 清理

### 插件数据

插件私有数据自动存放在 `${LUC_HOME}/plugin-data/{pluginId}/`。删除插件时此目录保留，重新安装后配置还在。

## 目录结构

```text
my-plugin/
├── manifest.json          # 可选，复杂声明才需要
├── tools/                 # 工具（Agent 调用）
│   └── *.js
├── skills/                # 知识注入（Markdown）
│   └── my-skill/
│       └── SKILL.md
├── commands/              # 用户命令（斜杠触发）
│   └── *.js
├── agents/                # Agent 模板（JSON）
│   └── *.json
├── routes/                # HTTP 路由（需要 full-access）
│   └── *.js
├── providers/             # Provider 声明：聊天/媒体能力（需要 full-access）
│   └── *.js
├── extensions/            # Pi SDK extension 工厂（需要 full-access）
│   └── *.js
└── index.js               # 可选，有状态 plugin 入口，最后加载（需要 full-access）
```

标注"需要 full-access"的贡献类型，仅在 manifest 声明 `"trust": "full-access"` 且用户开启全权开关后才生效。

## 权限模型

社区插件分两级权限。这个划分决定了插件能使用哪些系统能力。

### Restricted（默认）

不需要在 manifest 里声明，社区插件默认就是 restricted。

**可以做的事：**

| 能力 | 说明 |
|------|------|
| `tools/*.js` | 声明工具供 Agent 调用 |
| `skills/` | Markdown 知识注入 |
| `commands/*.js` | 用户命令 |
| `agents/*.json` | Agent 模板（JSON 声明） |
| `ctx.config` | 读写自己的配置 |
| `ctx.dataDir` | 自己的数据目录 |
| `bus.emit / subscribe / request` | 发布事件、订阅事件、调用别人的能力 |
| `contributes.configuration` | JSON Schema 配置声明 |

**不能做的事：** `bus.handle`、routes、extensions、providers、`registerTool`、lifecycle（onload/onunload）。

restricted 插件的 tool/command 代码在主进程运行，有完整的 Node.js API 访问能力。权限模型管的是"系统给你什么扩展接口"，不是代码级沙盒。

### Full-access

在 manifest 中声明 `"trust": "full-access"`：

```json
{
  "id": "my-advanced-plugin",
  "trust": "full-access",
  "minAppVersion": "1.0.0"
}
```

`minAppVersion`（可选）声明插件运行所需的最低 LucCode 版本。如果当前 app 版本低于该值，插件不会加载，状态标记为 `incompatible`。建议所有插件都声明此字段，避免用户在旧版本上遇到不兼容问题。

用户需要在设置 → 插件页面开启"允许全权插件"开关。**开关关着时，full-access 插件完全不会加载**（不会部分加载），直到用户主动打开开关。

在 restricted 基础上额外获得：

| 能力 | 说明 |
|------|------|
| `bus.handle` | 注册能力供其他 plugin 调用 |
| `routes/*.js` | HTTP 端点 |
| `extensions/*.js` | Pi SDK 事件拦截（tool 调用、provider 请求等） |
| `providers/*.js` | Provider 声明：聊天/媒体能力 |
| `ctx.registerTool` | 运行时动态注册工具 |
| `onload` / `onunload` | 生命周期钩子 |

**没有声明 `trust` 或声明为其他值的插件，一律按 restricted 处理。**

## 贡献类型详解

### Tools（工具）

`tools/*.js` 每个文件 export：

```js
export const name = "search";           // 必须
export const description = "...";       // 必须
export const parameters = { ... };      // JSON Schema，可选
export async function execute(input, toolCtx) {  // 必须
  // input: 用户传入的参数
  // toolCtx: { pluginId, pluginDir, dataDir, sessionId, sessionRef, sessionPath, bus, network, config, log, registerSessionFile, stageFile }
  return "result";
}
```

- 自动加命名空间前缀：`pluginId_name`（如 `my-plugin_search`）
- restricted 插件的 `toolCtx.bus` 只有 `emit/subscribe/request`，没有 `handle`
- 新插件可以使用 `@luccode/plugin-runtime` 的 `defineTool()` 获得类型和默认参数；当前静态 `tools/*.js` loader 仍读取命名导出。
- Agent 可调用工具应声明 `sessionPermission`。纯读取工具用 `readOnly: true`；只写 `ctx.dataDir` 并通过 `stageFile()` 返回 `SessionFile` 的工具用 `kind: "plugin_output"`；会访问外部 provider、网络、平台账号或真实世界副作用的工具用 `kind: "external_side_effect"`，Auto 模式会交给 reviewer。修改用户工作区文件的工具默认保持 reviewer-bound，除非能用 `describeSideEffect(input)` 明确描述更窄的副作用。
- 定时自动化的 `plugin_action` v0 复用工具入口：`pluginId/actionId` 会映射到 `pluginId_actionId` 工具。cron 只保存 `pluginId`、`actionId` 和 JSON 参数；插件作者写的静态 `tools/*.js` 与动态 `ctx.registerTool()` 工具都会收到 SDK 风格的 `(input, ctx)` 调用；插件缺失、工具缺失或插件被禁用时，任务执行失败并记录运行历史，不会自动降级成 Agent 会话。

```js
import { defineTool } from '@luccode/plugin-runtime';

const tool = defineTool({
  name: "search",
  description: "Search project data",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  },
  sessionPermission: { readOnly: true },
  async execute(input, ctx) {
    ctx.log.info("search", input.query);
    return `results for ${input.query}`;
  }
});

export const { name, description, parameters, execute } = tool;
```

#### 用户资源访问

插件需要读取或修改用户资源时，使用 `ctx.resources`，资源可以是本地文件、挂载文件、`SessionFile`、Resource 记录或 URL。manifest 里按需声明能力：

```json
{
  "capabilities": ["resource.read", "resource.search", "resource.write"]
}
```

```js
export async function execute(input, ctx) {
  const ref = { kind: "mount", mountId: input.mountId, path: input.path };
  const file = await ctx.resources.read(ref);
  await ctx.resources.write(ref, file.content.toString("utf-8") + "\nupdated\n");
  return "updated";
}
```

`resource.read` 覆盖 `stat`、`read`、`list`；`resource.search` 覆盖搜索，包括 provider 选项里的文件名搜索；`resource.write` 覆盖 `write`、`writeExpectedVersion`、`edit`、`mkdir`、`delete`、`copy`、`rename`、`move`、`trash`；`resource.materialize` 用于把资源实体化成本机路径；`resource.watch` 覆盖 `ctx.resources.watch()` / `ctx.resources.subscribe()` 后端监听订阅。URL resource 保持只读。插件自己生成的文件仍然可以写到 `ctx.dataDir`，再通过 `stageFile()` 返回；用户资源读写不要直接用本地路径和 `fs.writeFileSync`。

`ctx.resources.watch(ref)` 用于单个资源，`ctx.resources.subscribe([refA, refB])` 用于一组资源，返回 `{ subscriptionId, resourceKeys, unsubscribe, close }`。生命周期插件应把 `unsubscribe` 交给 `register()`，短任务应在 `finally` 中释放。资源变化仍通过插件 bus 的 `resource.changed` / `resource.deleted` / `resource.renamed` 事件到达，消费侧按 `resourceKeys` 过滤后再刷新或重新读取。

ResourceIO 是用户资源的唯一权限入口。`local-file`、`mount`、`session-file`、`resource`、`url` 都是资源身份，不等于插件能拿到宿主本机路径。`stageFile()` 只用于插件生成物进入 `SessionFile` 交付链路，不用于修改用户源文件。`ctx.dataDir` 和插件包内 `assets/` 是插件自有存储，可以使用 raw `fs`；工作区、挂载、URL、SessionFile 输入不能套用这个例外。第三方库必须吃本机路径时，用 `ctx.resources.materialize(ref)`，写回仍然要显式走 ResourceIO，而不是把 materialized 文件当源文件直接改。

#### 媒体交付

工具需要交付文件时，使用 `toolCtx.stageFile()` 把本地文件登记成当前 session 的 `SessionFile`，并直接复用它返回的 `mediaItem`：

```js
import { createMediaDetails } from "@luccode/plugin-runtime";

const staged = toolCtx.stageFile({
  sessionId: toolCtx.sessionId,
  sessionRef: toolCtx.sessionRef,
  filePath: "/path/to/image.png",
  label: "image.png",
});

return {
  content: [{ type: "text", text: "已生成图片" }],
  details: createMediaDetails([staged]),
};
```

框架会自动提取 `details.media` 并根据上下文投递：桌面端渲染文件卡片，Bridge 按平台能力发送给对方，Mobile PWA / 远程前端通过 `SessionFile` / Resource 身份读取。新协议优先消费 `details.media.items` 里的结构化 `session_file`；`mediaUrls` 只保留为兼容旧工具和远程 URL 的字段，不建议新插件使用。本地文件不得通过 `MEDIA:/path`、`file://` 或 `mediaUrls` 绕过 `stageFile()` / `stage_files`，必须先登记成 `session_file`。内置 `stage_files` 会自动登记 SessionFile 并返回结构化媒体项，插件交付用户可见文件时应复用这条语义，不要让插件自己判断运行平台，也不要自己创建私有文件卡片来替代 `SessionFile`。

插件直接产出本地文件时，调用 `toolCtx.stageFile({ sessionId, sessionRef, filePath, label })` 绑定到当前 session，并得到可直接放入 `details.media.items` 的 `mediaItem`。`registerSessionFile` 仍保留为低层兼容 API，新插件应优先使用 `stageFile`，这样文件归属和媒体交付不会被拆散。`sessionId` / `sessionRef` 是新协议，`sessionPath` 仅作为旧插件兼容字段；`filePath` 必须是绝对路径。框架会把这类文件记为 `storageKind: "plugin_data"`，它们属于插件数据或生成结果，不会被 session 临时缓存清理器删除。插件不应把任意本地路径标成临时缓存，缓存生命周期由框架拥有。

几条边界：

- 插件生成的文件：`origin: "plugin_output"`，走 `storageKind: "plugin_data"`
- 插件异步生成的文件：后台任务完成时仍要登记 `SessionFile`；如果工具先返回 card，card 只负责展示任务状态和结果引用
- 用户上传、Bridge 入站、浏览器截图、旧 `create_artifact` 兼容工具输出等临时产物由框架登记为 `managed_cache`
- 安装来源（`.skill`、plugin 目录或 zip）：由安装 route 登记为 `install_source`
- Card 负责呈现交互界面，文件仍然是资源；卡片需要引用文件时，应引用 `SessionFile`，不要把文件内容塞进 card payload

#### 外部数据访问

插件需要实时比分、天气、行情、外部搜索结果或第三方平台数据时，新代码应通过宿主提供的 `ctx.network.fetch()` 访问外部 HTTP API。iframe 页面只调用本插件自己的 route，例如 `luc.api.fetch("api/live-scores")`；route handler 再调用 `ctx.network.fetch("https://...")`。这样 iframe 认证、外部域名声明、超时、缓存和响应大小限制都在宿主边界内统一处理。

`ctx.network.fetch()` 需要 manifest 显式声明 `network.fetch`，并列出允许访问的主机：

```json
{
  "trust": "full-access",
  "capabilities": ["network.fetch"],
  "network": {
    "allowedHosts": ["site.api.espn.com"],
    "methods": ["GET"],
    "defaultTimeoutMs": 8000,
    "maxResponseBytes": 1048576
  }
}
```

```js
// routes/api.js
route.get("/live-scores", async (c) => {
  const ctx = c.get("pluginCtx");
  const res = await ctx.network.fetch(
    "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard",
    { cacheTtlMs: 30_000 },
  );
  return c.json(await res.json());
});
```

边界规则：

- `allowedHosts` 必须写主机名，可用 `*.example.com` 匹配子域；空列表拒绝所有外部主机
- 默认只允许 `GET`；需要 `POST`、`PUT` 等方法时在 `network.methods` 中显式声明
- 默认只允许 HTTPS；`http://127.0.0.1`、`localhost`、私网地址必须额外声明 `"allowLocalhost": true`
- `timeoutMs`、`cacheTtlMs`、`maxResponseBytes` 可在单次调用覆盖 manifest 默认值
- API key、token、cookie 不得写进 `assets/` 或 iframe JS；用 configuration schema 保存，由 route 在服务端读取
- 旧插件已经直接在 Node route 中使用 `fetch()` 的路径继续兼容；新插件、模板和 Agent 生成代码应使用 `ctx.network.fetch()`，这样诊断能指出缺少能力声明、域名、方法或大小限制

#### 可视化卡片

工具可以在聊天中自动渲染可视化卡片，在返回值的 `details` 中声明 `card`。当前有两条稳定形态：

- `type: "iframe"` / `type: "webview"`：用于插件自己的 Web UI、远程网站、单独 HTML 或复杂浏览器 UI。旧 `iframe` 卡继续兼容；新文档把它定位成正式 WebView escape hatch。
- `type: "chat.surface"`：用于把插件自己创建的 `plugin_private` / `private` session 作为原生聊天 transcript 嵌进当前聊天流。它只接受 `sessionId/sessionRef`，宿主会校验该 session 属于当前 plugin 且不是公开 session。

命名边界：`workbench` 是旧代码 namespace，不作为新插件作者需要学习的公开概念。当前公开能力以 `chat.surface` 的原生 transcript 和 WebView/iframe UI 为准。

WebView 卡片示例：

```js
return {
  content: [{ type: "text", text: "数据摘要..." }],
  details: {
    card: {
      type: "webview",
      route: "/card/chart?symbol=sh600519&period=daily",
      title: "贵州茅台 日K",
      description: "贵州茅台 现价1450.00 涨跌+2.11%",
    },
  },
};
```

- `route`：插件路由路径，WebView / iframe 自行从该路径拉数据渲染
- `title`：卡片标题（可选）
- `description`：纯文本摘要，用于 IM 平台降级显示和插件卸载后的 fallback
- `pluginId` 由框架自动注入，工具无需填写
- 卡片在工具完成时立即渲染，不依赖 LLM 行为
- 卡片数据随 toolResult 存入 JSONL，会话重载时自动恢复
- 插件 route / Session Bus 发送的自定义消息如果携带同样的 `details.card`，也会被提取成 `plugin_card`，历史回放时保持一致
- 卡片本身可以随 Bridge 或移动端做不同呈现；卡片关联的文件仍通过 `SessionFile` 生命周期恢复

原生聊天 surface 示例：

```js
import { createChatSurfaceCard, createSession } from "@luccode/plugin-runtime";

const child = await createSession(ctx, {
  kind: "tavern-run",
  visibility: "plugin_private",
  cwd: ctx.dataDir,
});

return {
  content: [{ type: "text", text: "已创建插件私有会话。" }],
  details: {
    card: createChatSurfaceCard(ctx, child.sessionRef ?? child, {
      title: "Tavern run",
      description: "插件私有会话 transcript",
    }),
  },
};
```

`chat.surface` 在 main 当前版本只提供原生 transcript 展示；复杂 composer、可组合 native cards 和组件生态尚未进入公开 SDK 契约。

### Skills（知识注入）

`skills/*/SKILL.md`，标准 frontmatter 格式：

```markdown
---
name: my-skill
description: 这个 skill 做什么
---
# 正文内容
Agent 在需要时会自动加载这段知识。
```

零代码，和 Claude Code 的 skill 模式一致。

### Commands（用户命令）

`commands/*.js` 每个文件 export：

```js
export const name = "focus";
export const description = "Start focus mode";
export async function execute(args, cmdCtx) {
  // args: 用户输入的参数文本
  // cmdCtx: { sessionId, sessionRef, sessionPath, agentId, bus, config, log }
}
```

### Agents（Agent 模板）

`agents/*.json`：

```json
{
  "name": "Translator",
  "systemPrompt": "You are a translator.",
  "defaultModel": "gpt-4o",
  "defaultTools": ["web-search"]
}
```

### Routes（HTTP 路由）⚡ full-access

`routes/*.js` 支持三种写法，自动挂载到 `/api/plugins/{pluginId}/...`：

**写法 A：工厂函数**（推荐，ctx 作为参数直接可用）

```js
// routes/chat.js
export default function (app, ctx) {
  app.post("/send", async (c) => {
    const { text } = await c.req.json();
    const result = await ctx.bus.request("session:send", {
      text,
      sessionId: ctx.sessionId,
      sessionRef: ctx.sessionRef,
    });
    return c.json(result);
  });
}
```

**写法 B：静态 Hono app**（通过中间件取 ctx）

```js
// routes/webhook.js
import { Hono } from "hono";
const route = new Hono();
route.get("/webhook", (c) => {
  const ctx = c.get("pluginCtx");
  return c.json({ ok: true, plugin: ctx.pluginId });
});
export default route;
```

**写法 C：register 导出**

```js
// routes/status.js
export function register(app, ctx) {
  app.get("/status", (c) => c.json({ pluginId: ctx.pluginId }));
}
```

三种写法向后兼容：不使用 ctx 的老插件无需改动。`ctx.bus` 可直接调用内置 session 操作：`session:create`、`session:get`、`session:update`、`session:send`、`session:abort`、`session:history`、`session:list`、`agent:list`、`agent:profile`、`agent:create`、`agent:update`。所有针对已有 session 的操作必须携带 `sessionId` 或 `sessionRef`；`sessionPath` 仅作为旧插件兼容输入。详见下方 Route Context 和 Session Bus Handlers 章节。

#### 请求级上下文（pluginRequestContext）

每个进入插件 route 的 HTTP 请求都会得到一份独立的请求级上下文。新 route 建议通过 `@luccode/plugin-runtime` 的 `getPluginRequestContext(c)` 读取；老写法 `c.get("pluginRequestContext")` 仍兼容。

```js
import { getPluginRequestContext } from "@luccode/plugin-runtime";

app.post("/create-session", async (c) => {
  const reqCtx = getPluginRequestContext(c);
  // reqCtx.principal        本次请求的来源身份（owner 设备 / 本插件 iframe surface…），测试直连时为 null
  // reqCtx.agentId          本次请求属于哪个 agent；为 null 表示这个表面此刻
  //                         不属于任何 agent（例如预览），不要当成"某个默认 agent"
  // reqCtx.capabilityGrant  { accessLevel, declaredPermissions, legacyDeclaration }
  if (!reqCtx.agentId) {
    return c.json({ error: "这个表面还没有关联 agent" }, 400);
  }
  const result = await reqCtx.bus.request("session:create", { agentId: reqCtx.agentId });
  return c.json(result);
});
```

`reqCtx.bus` 与 `ctx.bus` 的区别：通过它调用系统敏感能力（capability 目录里 `owner: "system"` 且带 `permission` 的条目，如 `session:create` → `session.write`）时按「manifest 声明 + 用户授权」校验。manifest `capabilities` / `sensitiveCapabilities` 未声明对应 permission（支持命名空间，`session` 即覆盖 `session.write`）返回 403 `PLUGIN_CAPABILITY_NOT_DECLARED`；插件未获 full-access 返回 403 `PLUGIN_CAPABILITY_NOT_GRANTED`。错误响应携带 `capability` / `permission` / `pluginId` / `declared` / `granted` 字段，可直接定位缺什么。完全没写能力声明的老 manifest（两个字段都缺失）视为 legacy（等同声明全部），行为不回退；一旦显式写出任一列表即按声明严格校验——显式空数组（`"capabilities": []`）不是 legacy，会拒绝所有系统敏感能力。处理来自 iframe 页面的请求时优先使用 `reqCtx.bus`。

### Extensions（Pi SDK 事件拦截）⚡ full-access

`extensions/` 目录下的每个 `.js` 文件导出一个工厂函数，接收 Pi SDK 的 `ExtensionAPI`，可以订阅 LLM 调用链上的事件：

```js
// extensions/strip-empty-tools.js
export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const p = event.payload;
    if (p && Array.isArray(p.tools) && p.tools.length === 0) {
      delete p.tools;
    }
    return p;
  });
}
```

常用事件：

| 事件 | 时机 | 能做什么 |
|------|------|----------|
| `tool_call` | 工具调用前 | 修改参数、block 调用 |
| `tool_result` | 工具返回后 | 修改返回结果 |
| `before_provider_request` | HTTP 请求发出前 | 改写 payload |
| `context` | 每次 LLM 调用前 | 过滤/注入消息 |
| `before_agent_start` | 用户输入后 | 注入 system prompt |
| `input` | 用户输入到达时 | 拦截/变换输入 |

工厂函数在 session 创建时被 Pi SDK 调用，handler 在对应事件触发时执行。安装、启用或 reload full-access 插件后，Luc 会让当前空闲 session 重新绑定 extension runner；正在 streaming、compacting 或切换中的 session 会跳过重绑，下一次安全重建时生效。完整事件列表参见 Pi SDK extension 文档。

`extensions/` 仍是 full-access 边界。restricted 插件即使包含 `extensions/` 目录也不会加载这些工厂；如果插件需要拦截 provider 请求、tool 调用或上下文构建，必须在 manifest 中声明 `"trust": "full-access"`，并由用户开启全权插件开关。

### Providers（Provider Contribution）⚡ full-access

`providers/*.js` export ProviderPlugin 数据对象：

```js
export const id = "my-llm";
export const displayName = "My LLM Service";
export const authType = "api-key";
export const defaultBaseUrl = "https://api.my-llm.com/v1";
export const defaultApi = "openai-completions";
```

Provider 可以声明多种 capability。聊天侧只消费 `capabilities.chat`，生图/生视频/生语音消费 `capabilities.media.*`。如果 provider 只提供媒体能力，把 `chat.projection` 设为 `"none"`，它就不会进入聊天模型列表：

```js
export const id = "my-image-cli";
export const displayName = "My Image CLI";
export const authType = "none";

export const runtime = {
  kind: "local-cli",
  protocolId: "local-cli-media",
  command: {
    executable: "my-image-cli",
    args: [
      { literal: "generate" },
      { option: "--prompt", from: "prompt" },
      { option: "--model", from: "modelId" },
      { option: "--output", from: "outputDir" },
    ],
    timeoutMs: 120000,
    output: { kind: "file_glob", directory: "outputDir", pattern: "*.png" },
  },
};

export const capabilities = {
  chat: { projection: "none" },
  media: {
    imageGeneration: {
      models: [
        {
          id: "my-image-model",
          displayName: "My Image Model",
          protocolId: "local-cli-media",
          inputs: ["text"],
          outputs: ["image"],
        },
      ],
    },
  },
};
```

CLI provider 必须使用结构化参数绑定。不要拼 shell 字符串；Luc 会通过 `execFile` / `spawn` 的非 shell 模式运行命令，并把输出收束进媒体任务目录。

#### Provider 与 Adapter 的边界

`providers/*.js` 是长期支持的 Provider Contribution 入口。它声明供应商、模型、能力、`protocolId`，进入 ProviderRegistry 后由聊天、图片、视频、语音等选择器统一发现。旧插件如果已经通过 `providers/*.js` 声明图片 provider，只需要补齐 `capabilities.media.imageGeneration` 和每个模型的 `protocolId`，不需要换入口。

媒体 Adapter 负责执行某个 `protocolId` 的 `submit` / `query` / 下载流程。只注册 Adapter 不等于注册供应商；没有 Provider capability 的模型不会自然出现在供应商管理、默认媒体模型选择、媒体 helper 发现结果里。

旧 `media-gen:*` 事件接口仍然保留给历史图片生成插件兼容，例如 `media-gen:register-adapter`、`media-gen:submit-image`、`media-gen:list-adapters`。新插件和 Agent 生成的模板不要调用这些旧命名空间；新建插件必须先通过 `providers/*.js` 声明 Provider capability，再使用稳定媒体 helper 或正式 Adapter Plugin API。迁移方向是：

```text
ProviderPlugin capabilities.media.*
        │
        ▼
ProviderRegistry 发现供应商和模型
        │
        ▼
MediaAdapterRegistry 按 protocolId 选择 Adapter
        │
        ▼
UniversalMediaManager 统一任务、占位、轮询、SessionFile 回填
```

如果插件需要全新媒体协议，先声明 Provider capability，并为该 `protocolId` 提供 Adapter。正式 Adapter Plugin API 尚未稳定前，内置或受信插件可以继续使用旧 `media-gen:register-adapter` 作为过渡，但要把它视为兼容层，不能把它写进新插件脚手架或新 Agent 指南。

### Configuration（配置 schema）

在 `manifest.json` 的 `contributes.configuration` 中声明配置 schema。Luc 会规范化字段、写入默认值、校验类型，并在设置 API 中自动隐藏敏感字段：

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "interval": {
          "type": "number",
          "default": 25,
          "title": "工作间隔（分钟）",
          "scope": "global",
          "ui": { "control": "number" }
        },
        "sound": { "type": "boolean", "default": true, "title": "结束提示音" },
        "apiKey": {
          "type": "string",
          "title": "API Key",
          "sensitive": true,
          "ui": { "control": "password" }
        }
      }
    }
  }
}
```

配置通过 `ctx.config.get(key)` / `ctx.config.set(key, value)` 读写，持久化在 `plugin-data/{pluginId}/config.json`。旧插件没有 schema 时仍可自由读写平铺 key；声明了 schema 的插件会按字段类型、`enum` 和 `scope` 校验。

字段支持：

- `type`: `string` / `number` / `integer` / `boolean` / `object` / `array`
- `default`
- `title` / `description`
- `enum`
- `scope`: `global` / `per-agent` / `per-session`
- `sensitive`: 设置 API 返回时显示为 `********`
- `ui`: 自动设置页的控件提示
- `reloadRequired`

per-agent 和 per-session 配置要显式传归属：

```js
await ctx.config.set("agentMode", "strict", { scope: "per-agent", agentId: "agent-123" });
const value = await ctx.config.get("agentMode", { scope: "per-agent", agentId: "agent-123" });
```

### Page（插件页面）⚡ full-access

插件可以在顶部 tab 栏注册一个全页面视图，跟「聊天/频道」同级。切换到该 tab 后，插件的 iframe 占据整个窗口空间。

在 `manifest.json` 的 `contributes` 中声明：

```json
{
  "contributes": {
    "page": {
      "title": { "zh": "金融", "en": "Finance" },
      "icon": "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><polyline points='22 12 18 12 15 21 9 3 6 12 2 12'/></svg>",
      "route": "/dashboard"
    }
  }
}
```

- `title`：显示名，支持字符串或 `{ zh, en, ... }` 国际化对象
- `icon`：强烈建议提供内联 SVG（stroke 风格，`currentColor`）。缺省时取 title 首字
- `route`：插件 route 的相对路径，实际 URL 为 `/api/plugins/{pluginId}{route}`
- 一个插件可以同时声明 `page` 和 `widget`，互不冲突
- 悬停 tab 时显示插件全名（tooltip）
- Tab 超过 5 个时自动折叠到 overflow 下拉菜单，用户可拖拽排序

插件页面通过 WebView/iframe 渲染。旧 iframe 是兼容名称，新的插件设计可以把它理解成 WebView：适合展示已有 Web 应用、远程网站或单独 HTML。Luc 原生聊天 surface 不依赖 WebView/iframe。新插件建议使用 `@luccode/plugin-sdk` 发送握手和宿主请求：

```js
import { luc } from '@luccode/plugin-sdk';

luc.ready();
luc.ui.resize({ height: 320 });
await luc.toast.show({ message: '已刷新', type: 'success' });
await luc.external.open('https://example.com');
await luc.clipboard.writeText('复制内容');
await luc.resources.open({ resource: { kind: 'session-file', fileId: 'sf_1' }, mode: 'preview' });
```

底层仍保留 `luc.host.request(type, payload)`，用于未来 capability 或实验能力；稳定能力优先使用 typed helper。

为兼容旧插件，宿主仍接受原始握手消息：

```js
window.parent.postMessage({ type: 'ready' }, '*');
```

宿主只接受来自当前 iframe window 且 origin 匹配的消息。SDK 请求会经过 capability registry；当前内置能力包括 `toast.show`（无需授权）、`external.open`（需要授权）、`clipboard.writeText`（需要授权）以及资源请求类 `resource.open`、`resource.pick`、`resource.requestAccess`（均需要授权）。

需要授权的 iframe 宿主能力必须在 manifest 中声明：

```json
{
  "manifestVersion": 1,
  "ui": {
    "hostCapabilities": ["external.open", "clipboard.writeText", "resource.open"]
  }
}
```

未声明的敏感能力会返回 `CAPABILITY_DENIED`。未知能力名会在加载时被忽略；`toast.show` 不需要声明。

`luc.resources.*` 只是在 iframe 中向宿主发请求：可以请求打开资源、选择资源、申请访问权限，但不能直接读取或写入文件内容。真正的用户资源读写仍然放在插件服务端 route、tool 或 lifecycle 里，通过 `ctx.resources` 进入 ResourceIO。

宿主会在 iframe URL 上附加 `luc-theme` 和 `luc-css` 参数，插件可选择引用主题 CSS 以保持视觉一致：

```html
<link rel="stylesheet" href="${new URLSearchParams(location.search).get('luc-css')}">
```

静态前端资源放在插件目录的 `assets/` 下，由 Luc 宿主通过 `/api/plugins/{pluginId}/assets/...` 统一服务。这个模型参考 VS Code Webview 的资源边界：入口 route 通过本地 token 或 `pluginIframeTicket` 打开，成功返回页面后，宿主下发一个只作用于 `/api/plugins/{pluginId}/assets/` 的 HttpOnly 短会话 cookie。Vite split chunks、`React.lazy()`、CSS、字体、图片、JSON、wasm、MP4/WebM/MOV 等浏览器可播放视频请求不需要也不应该携带 `?token` 或 `pluginIframeTicket`。视频资源支持 HTTP Range，`<video>` 可以通过官方 assets 路由播放和 seek。

页面脚本调用本插件的动态 route API 时，优先使用 `@luccode/plugin-sdk` 的 `luc.api.fetch()`。它会从当前 iframe route 推导 pluginId，并自动携带宿主随 iframe URL 下发的 surface session 凭证：

```js
import { luc } from '@luccode/plugin-sdk';

const res = await luc.api.fetch('create-session', {
  method: 'POST',
});
```

网页转换成插件时，要把同插件的 `fetch('/api/...')` 重写为 `luc.api.fetch(...)`，不要在浏览器代码里硬编码 `/api/plugins/{pluginId}/...`。底层协议是：宿主把 surface session 放在 query 参数 `pluginSurfaceSession`，页面调用本插件 route handler 时以 `X-Luc-Plugin-Surface-Session` 请求头（或同名 query 参数）回传：

```js
const surfaceSession = new URLSearchParams(location.search).get('pluginSurfaceSession');
const res = await fetch('/api/plugins/my-plugin/create-session', {
  method: 'POST',
  headers: { 'X-Luc-Plugin-Surface-Session': surfaceSession },
});
```

该凭证只授权本插件自己的 route 代理路径，不携带任何宿主 scope，宿主在转发给插件 handler 前会把它从请求中剥离。`pluginIframeTicket` 是一次性的文档加载凭证，不要把它复用到 XHR 上。

浏览器代码优先使用 SDK 生成资源 URL：

```js
import { luc } from '@luccode/plugin-sdk';

const iconUrl = luc.assets.url('images/icon.svg');
const bgVideoUrl = luc.assets.url('videos/background.mp4');
```

服务端 shell 可以直接引用同一个 host-served 资源路径：

```html
<script type="module" src="/api/plugins/my-plugin/assets/dist/app.js"></script>
```

`assets/` 是公开静态资源根，只放构建产物和公开素材。不要放源码、密钥、私有配置或运行时数据。宿主默认拒绝路径穿越、隐藏文件、source map 和非 Web 静态扩展；动态数据继续走插件 route API 或 SDK host request。

Agent 新生成或重构插件时，不要为了 CSS、JS、图片、字体、MP4 这类静态资源额外注册 `/api/file`、`/api/video`、`/assets/*` 等 route。已有插件中的静态资源兼容 handler 继续可用；新工作遵循的正式契约是把这些资源放进 `assets/`，用 `luc.assets.url(...)` 或 route shell 中的官方 assets 路径引用。`pluginIframeTicket` 只用于 iframe 文档加载，不要手动拼到静态资源 URL。

React 插件 UI 建议使用 `@luccode/plugin-components`，它提供和 Luc 当前控件接近的 Button、IconButton、TextInput、Textarea、Select、Switch、SettingRow、CardShell、List、EmptyState 等基础组件：

```tsx
import { Button, CardShell, LucThemeProvider, SettingRow, Switch } from "@luccode/plugin-components";
import "@luccode/plugin-components/styles.css";

export function PluginPanel() {
  return (
    <LucThemeProvider mode="inherit">
      <CardShell title="同步">
        <SettingRow label="启用" control={<Switch checked label="开启" />} />
        <Button variant="primary">运行</Button>
      </CardShell>
    </LucThemeProvider>
  );
}
```

`LucThemeProvider` 支持三种模式：`inherit` 读取宿主 CSS 变量并走 SDK fallback；`luc` 固定使用某个 Luc 主题 token；`custom` 只覆盖插件显式传入的 token，未传字段继续 fallback。组件只依赖 `luc-plugin-*` class 和 CSS 变量，不导入 renderer 内部组件。

### Widget（侧栏组件）⚡ full-access

插件可以在右侧 Jian 侧栏注册一个组件。Widget 与 Page 可以同时声明，互不冲突。

```json
{
  "contributes": {
    "widget": {
      "title": { "zh": "盯盘", "en": "Monitor" },
      "icon": "<svg viewBox='0 0 24 24' .../>",
      "route": "/sidebar"
    }
  }
}
```

字段规则同 Page。Widget 在 Jian 侧栏的书桌旁显示，由 titlebar 右侧的按钮控制。没有 widget 注册时按钮区域自动隐藏。

Widget 同样通过 iframe 渲染，需要发送 `ready` 握手信号。

### SettingsTab（原生设置页，内置插件专用）⚡ full-access

随 app 打包的内置插件可以注册一个原生设置页，显示在设置左侧导航中，与「技能」「插件」等大页面平级。这个入口只对 `plugins/` 目录下的 built-in 插件生效，社区插件即使声明也会被忽略。原生组件由宿主白名单映射，插件只声明组件 ID，不执行前端代码。

```json
{
  "hidden": true,
  "trust": "full-access",
  "contributes": {
    "settingsTab": {
      "id": "mcp",
      "title": { "zh": "连接器", "en": "Connectors" },
      "nativeComponent": "mcp.settings"
    }
  }
}
```

- `id`：设置页 tab id，需全局唯一
- `title`：显示名，支持字符串或 `{ zh, en, ... }` 国际化对象
- `nativeComponent`：宿主内置组件注册名，例如 `mcp.settings`
- 适用场景：隐藏的随包功能需要原生设置 UI，并且仍希望运行时逻辑可以按插件边界整块删除

## Manifest

大多数 plugin 不需要 manifest。只有以下场景需要：

- 声明 `trust: "full-access"` 获取完整权限
- 声明 WebView/iframe UI 需要的宿主能力（`ui.hostCapabilities`）
- 声明插件希望使用的普通能力（`capabilities`）或未来需要用户授权的敏感能力（`sensitiveCapabilities`）
- 声明外部 HTTP 数据访问边界（`network.allowedHosts`、`network.methods` 等）
- Configuration schema（JSON Schema 声明）
- Plugin 元信息（名称、版本、描述，给管理 UI 展示）
- 软依赖声明

```json
{
  "manifestVersion": 1,
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "trust": "full-access",
  "activationEvents": ["onToolCall:search"],
  "capabilities": ["session", "agent", "model.sample", "media.generate", "network.fetch"],
  "sensitiveCapabilities": ["filesystem.write"],
  "network": {
    "allowedHosts": ["api.example.com"],
    "methods": ["GET", "POST"],
    "defaultTimeoutMs": 8000,
    "maxResponseBytes": 1048576
  },
  "ui": {
    "hostCapabilities": ["external.open"]
  },
  "contributes": {
    "configuration": { ... }
  },
  "depends": {
    "capabilities": ["bridge:send"]
  }
}
```

没有 manifest 时，`id` 从目录名推导，其他字段默认空，权限为 restricted。

`capabilities` 是普通能力声明，加载后会出现在 `ctx.capabilities`，当前版本声明后即可通过 SDK / EventBus 使用对应稳定能力。`sensitiveCapabilities` 只记录插件意图，加载后出现在 `ctx.sensitiveCapabilities`；用户授权式权限系统接入后，文件系统写入、凭证读取、外部网络等高危能力会从这里进入授权流程。

`network` 只描述外部 HTTP 访问边界，本身不授予能力；使用 `ctx.network.fetch()` 时仍必须在 `capabilities` 或 `sensitiveCapabilities` 中声明 `network.fetch`。新插件应把实时数据、第三方 API、搜索、网页转插件所需的动态业务数据放在 route 层获取，再把净化后的 JSON 返回给 iframe。`network` 不是静态资源服务配置；图片、视频、CSS、JS 等随插件分发的资源仍应放进 `assets/`。

## 有状态 Plugin（生命周期）⚡ full-access

如果 plugin 需要持久连接、定时任务或 bus handler，创建 `index.js`：

`index.js` 不一定会在 app 启动时立刻执行。新插件可以在 `manifest.json` 里声明 `activationEvents`，让生命周期按需启动：

| 事件 | 触发时机 |
|------|----------|
| `onStartup` | 插件加载时立刻执行 `onload()` |
| `onPageOpen` | 用户打开插件页面 route |
| `onWidgetOpen` | 用户打开插件 widget route |
| `onToolCall` | 插件任意静态 tool 被调用 |
| `onToolCall:name` | 指定静态 tool 被调用 |
| `onBusRequest` | 预留给 bus 请求触发 |
| `onBusRequest:type` | 预留给指定 bus 能力请求触发 |
| `*` | 任意已知触发原因 |

没有声明 `activationEvents` 的老插件保持兼容：只要存在 `index.js`，默认等价于 `["onStartup"]`。新插件建议按能力声明最小激活条件，避免 app 启动时把所有长连接、任务和 handler 一次性拉起来。

```json
{
  "id": "lazy-search",
  "trust": "full-access",
  "activationEvents": ["onToolCall:search"],
  "contributes": {
    "page": { "title": "Search", "route": "/search" }
  }
}
```

新插件建议使用 `@luccode/plugin-runtime` 的 `definePlugin()`。它会返回兼容当前 PluginManager 的 class：

```js
import { definePlugin } from '@luccode/plugin-runtime';

export default definePlugin({
  async onload(ctx, { register }) {
    register(ctx.bus.handle("bridge:send", async (payload) => {
      return { sent: true, payload };
    }));
  },
});
```

也可以继续使用传统 class 形式：

```js
import { LUC_BUS_SKIP } from "@luccode/plugin-runtime";

export default class MyPlugin {
  async onload() {
    // ctx 由 PluginManager 注入：
    // this.ctx.bus          — EventBus（完整版：emit/subscribe/request/handle）
    // this.ctx.config       — 配置读写（get/set）
    // this.ctx.dataDir      — 私有数据目录路径
    // this.ctx.log          — 带 pluginId 前缀的 logger
    // this.ctx.pluginId     — plugin id
    // this.ctx.pluginDir    — plugin 安装目录
    // this.ctx.registerTool — 动态注册工具（返回清理函数）

    // register() 注册的资源在卸载时自动清理（逆序）
    this.register(
      this.ctx.bus.handle("bridge:send", async (payload) => {
        if (payload.platform !== "feishu") return LUC_BUS_SKIP;
        await this.sendToFeishu(payload);
        return { sent: true };
      })
    );

    this.ws = await this.connect();
  }

  async onunload() {
    // register() 注册的东西自动清理，不需要手动 unhandle
    // 只清理框架管不到的资源
    this.ws?.close();
  }
}
```

## 总线通信（bus.request / bus.handle）

Plugin 间通信通过 EventBus 的请求-响应机制。`bus.handle` 需要 full-access 权限，`bus.request` 所有插件都可以用。`bus.listCapabilities()` / `bus.getCapability(type)` 可以读取当前稳定能力目录，目录记录能力名、输入输出 schema、权限要求、错误码、稳定性和当前是否有 handler 可用。新插件建议用 `@luccode/plugin-runtime` 的 `defineBusHandler()`、`requestBus()` 和 `LUC_BUS_SKIP`，这样 handler 类型、请求参数和链式跳过语义都来自 SDK，而不是手写约定。

```js
import { defineBusHandler, LUC_BUS_SKIP, requestBus } from "@luccode/plugin-runtime";

// Plugin A（full-access）: 注册能力
const bridgeSend = defineBusHandler({
  type: "bridge:send",
  async handle(payload) {
    if (payload.platform !== "telegram") return LUC_BUS_SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  },
});

this.register(this.ctx.bus.handle(
  bridgeSend.type,
  (payload) => bridgeSend.handle(payload, this.ctx),
  {
    capability: {
      title: "Bridge send",
      description: "Send text to a bridge platform.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string" },
          chatId: { type: "string" },
          text: { type: "string" },
        },
        required: ["platform", "text"],
      },
      outputSchema: { type: "object" },
      permission: "bridge.send",
      errors: ["NO_HANDLER", "TIMEOUT", "INTERNAL_ERROR"],
      owner: "plugin:my-plugin",
      stability: "experimental",
    },
  },
));

// Plugin B（任意权限）: 调用能力
const capability = this.ctx.bus.getCapability?.("bridge:send");
if (capability?.available) {
  const result = await requestBus(this.ctx, "bridge:send", {
    platform: "telegram",
    chatId: "123",
    text: "Hello",
  }, { timeout: 5000 });
}
```

**命名规范**：`领域:动作`，冒号分隔。如 `bridge:send`、`memory:query`、`timer:schedule`。

**SKIP 链**：同一事件类型可以注册多个 handler。系统按注册顺序调用，直到某个 handler 返回非 `LUC_BUS_SKIP` 的值。返回 `LUC_BUS_SKIP` 表示"我不处理，交给下一个"：

```js
this.register(
  this.ctx.bus.handle("bridge:send", async (payload) => {
    if (payload.platform !== "telegram") return LUC_BUS_SKIP;
    await telegramBot.send(payload.chatId, payload.text);
    return { sent: true };
  })
);
```

**错误处理**：
- 无 handler → 抛 `BusNoHandlerError`
- 超时（默认 30s）→ 抛 `BusTimeoutError`
- handler 业务错误 → 直接透传

**软依赖**：manifest 的 `depends.capabilities` 只是提示，系统不会因缺失而阻止安装。Plugin 代码优先用 `bus.getCapability(type)?.available`，旧插件也可以继续用 `bus.hasHandler()` 在运行时做优雅降级。

### 内置 Session / Agent / 模型 / 媒体能力

插件可以直接使用 `@luccode/plugin-runtime` 的 typed helpers；底层对应 EventBus 能力如下：

| 能力 | 说明 |
|------|------|
| `session:create` | 创建不切换主界面焦点的普通 Luc session，可指定 `agentId`、`cwd`、`memoryEnabled`、`workspaceFolders`、`thinkingLevel`、`permissionMode`、`ownerPluginId`、`kind`、`visibility` |
| `session:get` / `session:list` | 读取 session 投影；插件私有 session 默认不进主列表，插件可按 `ownerPluginId` 查自己的 session |
| `session:update` | 更新标题、置顶、项目、思考等级、权限模式、插件归属和可见性 |
| `session:send` | 向指定 session 发送消息；支持 `context.system`、`context.beforeUser`、`context.afterUser` |
| `session:abort` / `session:history` | 中止 session 当前工作、读取历史消息 |
| `agent:list` / `agent:profile` | 列出 agent、读取 agent 公开资料 |
| `agent:create` / `agent:update` | 创建或更新插件拥有的 agent，可设置 `visibility: "plugin_private"` |
| `model:sample-text` | 使用系统配置的 utility 模型做非流式文本采样，适合 RAG 查询改写、摘要、路由 |
| `provider:media-providers` / `provider:resolve-media-model` | 读取已配置的媒体供应商和模型，discovery 语义稳定；具体 media adapter / executor 契约另行收口 |
| `media:generate-image` | 通过内置媒体任务管线提交生图任务，默认完成后以 `SessionFile` 交付；`delivery.mode="response"` 时只返回任务/文件结果 |
| `media:generate` / `media:generate-video` / `media:transcribe-audio` | 通过原生 Media Manager 提交通用媒体任务、视频生成任务或音频转录任务 |

插件后端优先使用 `@luccode/plugin-runtime` helpers。插件页面或插件 route handler 如果已经有宿主 HTTP 凭证，也可以使用原生 façade：`POST /api/media/generate`、`POST /api/media/image/generate`、`POST /api/media/video/generate`、`POST /api/media/asr/transcribe`。这些入口需要 chat scope，图片/视频必须传 `prompt`；默认 `delivery.mode="session"` 时还必须传 `sessionId` 或 `sessionRef`，完成后登记 `SessionFile`。如果插件只想拿生成产物，传 `delivery: { mode: "response" }` 可省略 session 身份，完成后轮询 `GET /api/media/tasks/:taskId`，再用 `task.files[]` 调 `GET /api/media/generated/:filename` 读取文件。ASR 必须传 `sessionId` 或旧 `sessionPath` 加 `fileId`。图片参考图只接受 `{ kind: "session_file", fileId }` 这类 SessionFile 引用，底层仍进入同一个 Media Manager 任务管线。图片 / 视频模型必须在当前 mode 上声明参考图能力，例如 `modes[].inputLimits.referenceImages = { min: 0, max: 0 }` 表示纯文生图，`{ min: 1, max: 1 }` 表示单参考图模式。任务管线会按所选 mode 在入队前拒绝不足量或超量参考图。

`session:send.context` 只注入到当轮 provider 请求，不会改写可见用户消息，也不会写入用户消息文本。插件可以在自己的 RAG、世界观、mood、角色状态系统里生成这些片段，然后在发送时附带：

```js
import {
  createAgent,
  createSession,
  generateMedia,
  generateImage,
  transcribeAudio,
  sampleText,
  sendSessionMessage,
  createChatSurfaceCard,
} from "@luccode/plugin-runtime";

const agent = await createAgent(ctx, {
  name: "Tavern Character",
  visibility: "plugin_private",
  memoryPolicy: { enabled: true },
});

const session = await createSession(ctx, {
  agentId: agent.agent.id,
  kind: "tavern",
  visibility: "plugin_private",
  cwd: ctx.dataDir,
});
const sessionTarget = session.sessionRef ?? { sessionId: session.sessionId };

const query = await sampleText(ctx, {
  operation: "tavern-rag-query",
  messages: [{ role: "user", content: "提取这一轮需要检索的世界观关键词" }],
  maxTokens: 80,
});

await sendSessionMessage(ctx, sessionTarget, {
  text: "我推开门。",
  context: {
    beforeUser: [
      { label: "world", text: "雨夜城市，旧剧院仍在营业。" },
      { label: "rag_query", text: query.text },
    ],
  },
});

await generateImage(ctx, {
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  prompt: "A handwritten character card on warm paper",
  referenceImages: [
    { kind: "session_file", fileId: "sf_reference_a" },
    { kind: "session_file", fileId: "sf_reference_b" },
  ],
  ratio: "3:2",
});

await generateMedia(ctx, {
  kind: "video",
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  prompt: "A slow page-turn animation on warm paper",
});

const artifactOnly = await generateImage(ctx, {
  prompt: "A small icon on transparent background",
  delivery: { mode: "response" },
});
// 后续轮询 /api/media/tasks/{artifactOnly.tasks[0].taskId}

const transcription = await transcribeAudio(ctx, {
  sessionId: session.sessionId,
  sessionRef: session.sessionRef,
  fileId: "session-file-id",
});
// transcription = { ok: true, transcription: { status, text, ... } }
```

### LLM 用量账本

宿主会把 LLM 请求用量持久化到本地账本。插件如需读取历史用量或订阅新增用量，必须在 `manifest.json` 中声明 `usage.read` 权限：

```json
{
  "permissions": ["usage.read"]
}
```

```js
import { listUsageEntries, subscribeUsageEvents } from "@luccode/plugin-runtime";

const usage = await listUsageEntries(this.ctx, {
  since: "2026-05-01T00:00:00.000Z",
  limit: 100,
});

this.register(subscribeUsageEvents(this.ctx, (entry, meta) => {
  this.ctx.log.info("new usage", entry.requestId, meta.sessionId, meta.sessionPath);
}));
```

底层能力名是 `usage:list`，实时事件名是 `llm_usage`。`meta.sessionId` 是稳定身份，`meta.sessionPath` 只是当前 locator / 旧插件兼容字段。受限插件没有 `usage.read` 时，宿主会拒绝请求，并过滤全局订阅里的 `llm_usage` 事件。

### 动态工具注册 ⚡ full-access

Plugin 可以在 `onload()` 中通过 `ctx.registerTool()` 动态注册工具，适用于运行时才知道有哪些工具的场景（如随包连接器里的 MCP bridge）：

```js
this.register(this.ctx.registerTool({
  name: "dynamic-search",
  description: "Dynamically registered tool",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async (input) => { ... },
}));
```

工具名自动加 `pluginId_` 前缀，通过 `register()` 在卸载时自动移除。Luc 自己触发这类工具（例如定时自动化或 dev smoke test）时，也会按 `execute(input, ctx)` 调用动态工具。Luc 内部桥接层如果已经暴露 Pi 工具签名，可以显式设置 `invocationStyle: "pi_tool"` 保留旧调用约定。

### 后台任务（Background Tasks） ⚡ full-access

插件可以注册后台任务，让 Agent 能够追踪、终止、诊断和恢复它们。系统通过 `TaskRegistry` 管理任务记录和计划任务元数据。

`TaskRegistry` 的边界很明确：任务 handler 是插件运行时函数，只存在内存里；任务记录和 schedule 元数据可以持久化，重启后仍能被诊断面板看到。重启后仍处于 `pending` / `running` / `paused` / `blocked` 的任务会标记为 `recovering`，插件在 `onload()` 里重新注册 handler 后，再按自己的持久化状态继续执行或清理。

**注册任务类型处理器**（在 `onload()` 中调用一次）：

```js
await this.ctx.bus.request("task:register-handler", {
  type: "my-task-type",
  abort: (taskId) => { /* 终止逻辑：取消轮询、中断请求等 */ },
  run: async (schedule) => {
    // 可选：计划任务触发时执行
    await this.runScheduledJob(schedule.payload);
  },
});

// 卸载时清理
this.register(() => {
  this.ctx.bus.request("task:unregister-handler", { type: "my-task-type" }).catch(() => {});
});
```

**注册任务实例**（每次启动后台任务时）：

```js
await this.ctx.bus.request("task:register", {
  taskId: "my-task-123",
  type: "my-task-type",
  parentSessionPath: sessionPath,
  pluginId: this.ctx.pluginId,
  meta: { type: "my-task", prompt: "..." },
});
```

**更新进度、完成和失败**：

```js
await this.ctx.bus.request("task:update", {
  taskId: "my-task-123",
  progress: { current: 3, total: 10, message: "rendering" },
});

await this.ctx.bus.request("task:complete", {
  taskId: "my-task-123",
  result: { fileId: "sf_123" },
});

await this.ctx.bus.request("task:fail", {
  taskId: "my-task-123",
  reason: "remote service timeout",
});
```

**取消和移除**：

```js
await this.ctx.bus.request("task:cancel", {
  taskId: "my-task-123",
  reason: "user canceled",
});

await this.ctx.bus.request("task:remove", { taskId: "my-task-123" });
```

**计划任务**：

```js
await this.ctx.bus.request("task:schedule", {
  scheduleId: "my-plugin.daily-sync",
  type: "my-task-type",
  pluginId: this.ctx.pluginId,
  intervalMs: 24 * 60 * 60 * 1000,
  payload: { agentId: "default" },
  meta: { label: "Daily sync" },
});

const schedules = await this.ctx.bus.request("task:list-schedules", {
  pluginId: this.ctx.pluginId,
});
```

**结果通知**（搭配 `deferred:*` 使用）：

`task:*` 管理运行时生命周期（注册、终止），`deferred:*` 管理结果送达。后台任务通常同时使用两套协议：`deferred:register` 注册结果占位，`task:register` 注册运行时实例；完成时 `deferred:resolve` 送达结果，`task:remove` 清理运行时状态。

**重启恢复**：Luc 持久化任务与 schedule 元数据，不持久化插件函数。插件需要在 `onload()` 时重新注册 `task:register-handler`，然后调用 `task:list` 查询 `status: "recovering"` 的本插件任务，按自己的业务存储恢复或失败它们。

### 官方插件市场

设置 → 插件里的「打开插件市场」会进入独立的市场子页，该页面读取 `/api/plugins/marketplace`。Luc 采用 Obsidian 式官方社区插件目录：第三方开发者把插件提交到 `luccode-plugins`，用户只浏览、安装、启用、禁用，不管理市场源。

默认官方目录：

```text
https://raw.githubusercontent.com/LuoJunCheng/luccode-plugins/main/marketplace.json
```

开发调试仍可用环境变量覆盖：

- `LUC_PLUGIN_MARKETPLACE_FILE=/path/to/marketplace.json`
- `LUC_PLUGIN_MARKETPLACE_URL=https://.../marketplace.json`

没有配置环境变量时，Luc 会先尝试读取 `${LUC_HOME}/plugin-marketplace/marketplace.json`（本地开发覆盖），如果不存在则读取官方 `luccode-plugins` URL。市场 index 的基本形状与 `luccode-plugins` 仓库一致：

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "schemaVersion": 1,
    "id": "demo",
    "name": "Demo",
    "publisher": "Luc",
    "version": "1.0.0",
    "description": "Demo plugin",
    "repository": "https://example.com/demo",
    "compatibility": { "minAppVersion": "1.0.0" },
    "trust": "restricted",
    "permissions": ["task.read"],
    "contributions": ["tools"],
    "distribution": {
      "kind": "release",
      "packageUrl": "https://github.com/LuoJunCheng/luccode-plugins/releases/download/demo-v1.0.0/demo.zip",
      "sha256": "..."
    },
    "versions": [
      {
        "version": "1.0.0",
        "compatibility": { "minAppVersion": "1.0.0" },
        "distribution": {
          "kind": "release",
          "packageUrl": "https://github.com/LuoJunCheng/luccode-plugins/releases/download/demo-v1.0.0/demo.zip",
          "sha256": "..."
        }
      }
    ],
    "readmePath": "plugins/demo/README.md"
  }]
}
```

市场 UI 会在设置主区域内展示更宽的插件列表和 README 单页视图，点击插件后读取 `/api/plugins/marketplace/:id/readme` 展示 README。`distribution.kind: "release"` 会下载 zip、校验 `sha256`，再安装到用户插件目录。`distribution.kind: "source"` 仅用于本地开发文件市场，因为 source path 必须能在本机解析成目录。

市场版本管理以 `versions[]` 为长期契约：每一项声明 `version`、该版本的 `compatibility.minAppVersion` 和对应的 `distribution`。没有 `versions[]` 时，Luc 会把根级 `version` / `compatibility` / `distribution` 视为单版本条目。客户端会按 SemVer 选择“当前 app 能运行的最高版本”，同时保留 `latestVersion`、`selectedVersion`、`installedVersion`、`updateAvailable`、`downgrade`、`reinstall`、`compatible`、`installAction` 和 `canInstall` 给 UI 展示。

如果已安装版本高于当前 app 可兼容的最高市场版本，安装动作会被标记为 `downgrade`，必须显式传 `allowDowngrade: true` 才能继续。拖拽 / 本地路径安装同样会阻止隐式降级。更新安装会先备份旧目录到 `${LUC_HOME}/plugin-backups/<pluginId>/`，新版本加载失败时恢复旧目录并重新加载；成功后 `${LUC_HOME}/plugin-installs.json` 会记录来源、版本、release URL 和 sha256，供后续市场状态判断。

## 前向兼容

系统忽略不认识的目录和 manifest 字段。老 plugin 永远能跑在新系统上，新 plugin 在老系统上只是新贡献类型不生效。`manifestVersion` 仍是可选兼容字段；新 WebView/iframe UI 若要声明 `ui.hostCapabilities`，建议写 `manifestVersion: 1` 让宿主和 SDK 文档语义对齐，但旧插件不需要补迁移。已有插件中为了兼容早期资源限制而自建的静态资源 route 继续允许；诊断和 Agent 规则只把它们标记为“可整理项”，不会作为加载失败理由。

## 错误隔离

- 单个 plugin 的 `onload()` 失败不阻塞其他 plugin 和系统启动
- 单个 tool/route/command 文件的语法错误只影响该文件
- 失败的 plugin 标记为 `status: "failed"`，在插件页面显示错误信息

## 诊断面板

设置 → 插件里的诊断按钮会读取 `/api/plugins/diagnostics`，统一展示插件加载状态、激活状态、routes、tools、commands、configuration、EventBus 能力、后台任务和计划任务。插件作者排查问题时优先看这里：如果插件已加载但 `activationState` 仍是 `inactive`，说明生命周期尚未被对应 `activationEvents` 触发；如果任务处于 `recovering`，说明 app 重启后宿主恢复了任务记录，但插件还需要在 `onload()` 里重新注册 handler 并恢复业务状态。

## 并发设计

Luc 支持多 session / 多 agent 并行运行。插件开发时需注意：

- 所有针对已有 session 的 EventBus 事件（`session:get`、`session:update`、`session:send`、`session:abort`、`session:history` 等）必须携带 `sessionId` 或 `sessionRef`，用于标识目标 session；`sessionPath` 只保留为旧插件兼容输入
- 工具（tool）通过 `toolCtx.sessionId` / `toolCtx.sessionRef` 获取当前 session 身份；`toolCtx.sessionPath` 是当前 locator，不要把它当持久身份
- 不要使用 `engine.currentSessionPath` 或 `engine.currentAgentId`（这些是 UI 焦点指针，不代表当前执行的 session）

```js
// 正确：显式指定 sessionId / sessionRef
await bus.request("session:send", {
  text: "你好",
  sessionId: toolCtx.sessionId,
  sessionRef: toolCtx.sessionRef,
  context: {
    beforeUser: "插件本轮 RAG / 世界观上下文",
  },
});

await bus.request("session:abort", {
  sessionId: toolCtx.sessionId,
});

// 错误：省略 session 身份，在并发场景下无法定位目标 session
await bus.request("session:send", { text: "你好" });
```
