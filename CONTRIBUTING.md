# Contributing to LucCode

感谢你对 LucCode 的关注！

## 开发环境

### 前置条件

- Node.js >= 24.12 (see package.json engines)
- npm (latest compatible with your Node.js version)
- C/C++ 编译工具链（编译 `better-sqlite3` 与 Windows sandbox helper 需要）：
  - **Windows**：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（选择 "Desktop development with C++" 工作负载）

### 本地运行

```bash
# 安装依赖
npm install

# 启动 Electron（自动构建前端）
npm start

# 或者用 Vite HMR 开发前端
npm run dev:renderer
# 另一个终端
npm run start:vite
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 构建前端 + 启动 Electron |
| `npm run start:vite` | Vite HMR 模式启动 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:renderer` | 单独构建前端 |

### Native Module 注意事项

Server 以独立 Node.js 进程运行（`spawn`，非 `fork`），不在 Electron 主进程内，因此 `better-sqlite3` **不需要 `electron-rebuild`**。`build-server.mjs` 在目标 Node.js runtime 下执行 `npm install --omit=dev`，native addon 的 ABI 自动匹配。

## Pull Request

项目目前处于早期阶段，**不接受 Pull Request**。如果你有想法或发现了问题，请按下面的 Issue 规则提交。

## Issue 规则

所有 Issue 都只描述问题或需求，**不接受代码实现**。包括修复建议、补丁、diff、替换代码、实现方案和实现示例。不符合规则的 Issue 会被直接关闭。

### Bug

只接受 Agent 排查报告：

1. 让你使用的 Agent（如 Claude Code、Codex、Luc 等）在你的环境里复现并排查问题。
2. 按 Bug Report 模板整理报告：环境、问题清单、复现步骤、期望与实际行为、证据、验收方式。
3. 报告要能被维护者验收：每个问题都能按步骤复现，并写明修复后应看到的结果。

报告可以指出出错的位置（文件、函数、配置项），但只说明哪里出错，不写应改成什么。请让你的 Agent 只列出实际问题，不要让它给出修改建议。

### Feature

只接受 Spec：

1. 建议先和你的 Agent 聊一聊，把想法理清楚。
2. 按 Feature Request 模板写清楚：想要什么、为什么需要、做到什么程度算完成。
3. 不写实现方式、技术方案或代码。

### 安全问题

安全漏洞请按 [SECURITY.md](SECURITY.md) 报告，优先使用私密报告渠道。

## 项目结构

```
core/           # Engine 编排层 + Manager
lib/            # 核心库（bridge、sandbox、memory、tools、providers）
server/         # Hono HTTP + WebSocket 服务
hub/            # 后台任务（调度器、频道路由、Agent 通信、DM 路由）
desktop/        # Electron 应用 + React 前端
shared/         # 跨层共享工具（config schema、error bus、模型引用等）
plugins/        # 内置系统插件（随应用打包）
skills2set/     # 内置技能定义
scripts/        # 构建工具（server 打包、启动器、签名）
```

## License

提交贡献即表示你同意你的代码以 [Apache License 2.0](LICENSE) 授权。
