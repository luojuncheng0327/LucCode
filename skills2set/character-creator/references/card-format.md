# 角色卡打包与导入手册

阶段六的技术底稿。Luc 内置 Character Card 系统（`lib/character-cards/service.ts`），本手册的格式与接口均以它的源码为准。

## 一、包目录结构

```
<mypkg>/                      临时组装目录
├── card.json                 必需，角色卡描述文件
├── assets/
│   └── avatar.png            可选，头像（png / jpg / webp）
└── skills/                   可选，随包安装的技能
    ├── <skill-a>/
    │   └── SKILL.md          每个技能目录必须有 SKILL.md
    └── <skill-b>/
        └── SKILL.md
```

## 二、card.json 完整格式

```json
{
  "kind": "CharacterCard",
  "schemaVersion": 1,
  "package": { "name": "给这个包起的名字" },
  "agent": {
    "name": "角色名（必填，可中文）",
    "id": "ascii-id（可选，省略则按名字自动生成）",
    "yuan": "luc | butter | ming | kong",
    "description": "一句话介绍，显示在团队名册"
  },
  "identity": {
    "summary": "身份摘要一句话",
    "content": "identity.md 全文（几行身份速写，别塞人格）"
  },
  "prompts": {
    "identity": "identity.md 全文（与 identity.content 保持一致）",
    "agents": "AGENTS.md 全文（人格定义主文件：性格、说话方式、原则。省略则回落到 yuan 默认模板，内容与角色无关，务必提供）",
    "publicAgents": "可选但推荐，AGENTS.public.md 全文（对外 AGENTS.md：接待外部访客时的人格与边界）"
  },
  "assets": { "avatar": "assets/avatar.png" },
  "skills": {
    "bundles": [
      { "name": "<角色名> Bundle", "skills": ["skills/skill-a", "skills/skill-b"] }
    ]
  }
}
```

字段规则（来自源码 normalize 函数）：

- `agent.name` 必填；`agent.id` 可省，合法字符为 ASCII 字母/数字/`_`/`-`，且至少含一个字母或数字
- `yuan` 只认 `luc` `butter` `ming` `kong`，填错静默回落到 `luc`
- 内心独白格式（MOOD / PULSE / 沉思）由 `yuan` 在系统层自带，**不写进 AGENTS.md**；AGENTS.md 只写角色的人格定义。三层分工：identity.md 是"他是谁"（几行速写），AGENTS.md 是"他怎样想、怎样说话"（人格主文件），对外 AGENTS.md（`AGENTS.public.md`）是"他对外人时的样子"
- **新包一律写 `prompts.agents` / `prompts.publicAgents`**，这两个 key 是当前的正式写法，导出通道产出的也是它们。人格文本的 key 历史上换过几轮名字，老卡包里是旧写法；卡包一旦分享出去就装在别人硬盘和分享链接里，改不动，所以导入端对旧 key 的兼容是永久的，不是过渡期措施。你只管按新 key 写，同一份包里新旧并存时新 key 优先
- `assets.avatar` 是**包内相对路径**，图片类型仅 png/jpg/jpeg/webp
- `skills.bundles[].skills[]` 填技能目录的包内相对路径，每个目录里必须有带 `name` frontmatter 的 `SKILL.md`
- 包内**禁止符号链接**，导入端会拒绝

## 三、打 zip

macOS / Linux：

```bash
cd /path/to/mypkg && zip -r ~/Desktop/<agent-id>-charactercard.zip .
```

Windows（PowerShell）：

```powershell
Compress-Archive -Path C:\path\to\mypkg\* -DestinationPath C:\path\to\<agent-id>-charactercard.zip
```

注意 zip 内容要以 `card.json` 为根，别多套一层目录（上面的命令已保证）。

## 四、导入 API

服务发现：端口与令牌在 `~/.luccode/server-info.json`。

```bash
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.luccode/server-info.json'))['port'])")
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.luccode/server-info.json'))['token'])")
BASE="http://127.0.0.1:$PORT/api/character-cards"
AUTH="Authorization: Bearer $TOKEN"
```

第一步，生成导入预览（`path` 传 zip 或组装目录的**绝对路径**皆可，目录会直接被采用）：

```bash
curl -s -X POST "$BASE/plan" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"path": "/absolute/path/to/<agent-id>-charactercard.zip"}'
```

返回 `{ ok: true, plan: { token, agent, prompts, skills, assets, ... } }`。把关键信息（名字、yuan、技能数量、头像有无）给用户确认。

第二步，确认后提交导入：

```bash
curl -s -X POST "$BASE/import" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"token": "<上一步的 token>"}'
```

返回 `{ ok: true, agent: { id, ... }, installedSkills: [...] }` 即成功。新角色立刻出现在 agent 列表。

## 五、导出（复刻现有角色）

用户想给已有角色打 zip 分享时走导出通道，产物落在桌面或指定目录：

```bash
curl -s -X POST "$BASE/export" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"agentId": "<agent-id>", "exportMemory": false}'
```

`exportMemory: true` 会把该角色的记忆也打进包，涉及隐私，默认 false，用户明确要求才开。

## 六、分享前隐私检查

zip 是分享产物，里面每一份文本、每一张图都会原样公开。分享给他人前逐项过：

- **用户名占位**：identity / prompts / description 里用 `{{userName}}` 指代用户（运行时自动替换），没有写死真实用户名、昵称、称呼
- **技能目录干净**：打进包的每个技能文件夹里没有个人绝对路径、API key、账号密码、私人文档的引用或摘录
- **头像授权**：头像不是未经授权的真人照片（用户本人同意用的除外）
- **无记忆残留**：新造角色的 card.json 不带 `memory` 字段；导出现有角色时 `exportMemory` 默认 false，只有用户明确说“连记忆一起打包”才开，开了要二次确认
- **token 不落盘**：`server-info.json` 的 token 只活在 shell 变量里，不写进任何文件、不贴进对话、不进 zip

## 七、坑位备忘录

- **技能默认全关**：角色卡导入时只启用包内技能。包里没有的技能，哪怕本机已装，新角色也是关的。要么打进包，要么交付时提醒用户去设置里开
- **撞名自动改名**：agent id 或技能名与现有重复时，导入端自动加哈希后缀，返回结果里能看到实际名字
- **头像兜底**：包里无 avatar 时，自动用所选 yuan 的默认头像
- **plan 会过期**：plan 的 staging 在服务端临时目录，间隔太久 token 会 404，重生成 plan 即可
- **80MB 上限**：上传接口限制 80MB，本地 path 方式更稳；技能包别打进无关大文件
