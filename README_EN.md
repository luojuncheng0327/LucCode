<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="LucCode Banner">
</p>

<p align="center">
  <img src=".github/assets/LucCode-280.png" width="80" alt="LucCode">
</p>

<h1 align="center">LucCode</h1>

<p align="center">A personal AI agent with memory and soul</p>

<p align="center"><a href="README.md">中文版</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/LuoJunCheng/luccode/releases)

---

## What is LucCode

LucCode is a personal AI agent that is easier to use than traditional coding agents. It has memory, personality, and can act autonomously. Multiple agents can work together on your machine.

As an assistant, it is gentle: no complex configuration files, no obscure jargon. LucCode is designed not just for coders, but for everyone who works at a computer.
As a tool, it is powerful: it remembers everything you've said, operates your computer, browses the web, searches for information, reads and writes files, executes code, manages schedules, and can even learn new skills on its own.

## Features

**Memory** — A custom memory system that keeps recent events sharp and lets older ones fade naturally.

**Personality** — Not a generic "AI assistant". Each agent has its own voice and behavior through personality templates. Agents are self-contained folders, easy to back up and manage.

**Tools** — Read/write files, run one-shot commands or persistent terminal sessions, browse the web, search the internet through browser-backed or API providers, take screenshots and segmented long screenshots, preview media, and inspect pages. Covers the vast majority of daily work scenarios. A server-first CLI can also attach to the same LucCode Server to show status, list sessions, and continue chats from a terminal.

**Skills** — Built-in compatibility with the community Skills ecosystem. Agents can also install skills from GitHub or write their own. Strict safety review enabled by default.

**Character Cards & Skill Bundles** — Export and import agents as local-first character-card zip packages with allowlisted identity, avatar, optional memory, and skills. Skill Bundles are separate skill-pack infrastructure: group skills, drag them between bundles, toggle a whole bundle for an agent, and export a bundle as a standalone zip for migration or sharing.

**Multi-Agent** — Create multiple agents, each with independent memory, personality, and scheduled tasks. Agents can collaborate via channel group chats or delegate tasks to each other.

**Desk** — Each agent has a desk for files and notes (Jian). Supports drag-and-drop, file preview, and workspace file-tree change watching, serving as an async collaboration space between you and your agent.

**Full-Screen Media Viewer** — Click any image, SVG, or video from chat or the desk to open a dark-overlay viewer with wheel-zoom, drag-to-pan, `+` / `−` / `0` shortcuts, and left/right navigation between sibling media in the same session or folder.

**Session Management** — The sidebar can search chat history, prioritizing title matches and then searching message content. Old sessions can be archived, restored, or permanently deleted from settings. Selecting text in a chat message turns it into a composer quote card so follow-up questions keep the original context.

**Cron & Heartbeat** — Agents can run scheduled tasks and periodically check for file changes on the desk. The current automation executor separates "when to run" from "what to do": complex tasks still run as background Agent sessions, lightweight reminders can send direct notifications, and plugin actions can be scheduled too.

**Sandbox** — Two-layer isolation: application-level PathGuard with four access tiers + OS-level sandboxing (Windows restricted token). Agents can read ordinary system files, while writes and deletes stay limited to the workspace and managed data folders. On Windows, the command sandbox is a write-isolation model: reads use the current user's normal permissions, and network access keeps the current user's network permissions. External network access can use system proxy, manual proxy, or direct mode.

**Plugins** — Extensible plugin system with a convention-first architecture. Install community plugins by drag-and-drop. Plugins can contribute tools, skills, commands, agent templates, HTTP routes, Pi SDK extensions, LLM providers, pages, widgets, configuration schemas, and background tasks. Routes have direct access to core services (PluginContext injection) and can interact with agent sessions via the Session Bus; plugin cards flow through the same message-block and history replay pipeline as built-in cards. The two-level permission model (restricted / full-access) keeps advanced surfaces safe: `extensions/`, routes, providers, pages, and lifecycle hooks only load for full-access plugins.

**Multi-Platform Bridge** — A single agent can connect to Telegram, Feishu, QQ, and WeChat bots simultaneously. Chat from any platform and remotely operate your computer. Bridge sessions carry platform context, and notifications can be delivered back to the current external platform.

**Mobile & LAN Frontends** — LucCode Server can host the `/mobile/` PWA. Phones can sign in with a device access key or local account, view sessions, chat, and manage workbench files. Another desktop frontend can also connect to an existing LAN LucCode Server with a LAN URL and access key.

**i18n** — Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Quick Start

### Download

**Windows (x64):** download the latest `.exe` installer from [Releases](https://github.com/LuoJunCheng/luccode/releases).

> **Windows SmartScreen notice:** The installer is not yet code-signed. Windows Defender SmartScreen may show a warning on first run. Click **More info** → **Run anyway**. This is expected for unsigned builds.

### First Run

On first launch, an onboarding wizard will guide you through setup: choose a language, enter your name, connect a model provider (API key + base URL), and select three models — a **chat model** (main conversation), a **utility model** (lightweight tasks), and a **utility large model** (memory compilation and deep analysis). In settings you can also choose a **vision model** that lets text-only chat models work with image attachments through Vision Bridge. LucCode supports OpenAI-compatible providers, Anthropic-style providers, OAuth providers, and local models via Ollama.

## Architecture

```
core/           Engine orchestration + Managers (including PluginManager)
lib/            Core libraries (memory, tools, sandbox, bridge adapters)
server/         Hono HTTP + WebSocket server (standalone Node.js process)
hub/            Scheduler, ChannelRouter, EventBus
desktop/        Electron app + React frontend
shared/         Cross-layer utilities (config schema, error bus, model refs)
plugins/        Built-in system plugins (bundled into app)
skills2set/     Built-in skill definitions
scripts/        Build tools (server bundler, launcher, signing)
```

The engine layer coordinates multiple managers (Agent, Session, Model, Preferences, Skill, Channel, BridgeSession, Plugin, etc.) and exposes them through a unified facade. The Hub handles background tasks (heartbeat, automation / cron, channel routing, agent messaging, DM routing) independently of the active chat session.

User-visible files inside a session are registered through `SessionFile` sidecars. Desktop, Bridge, Mobile PWA, and other remote frontends consume the same file identity according to their own capabilities. Each Bridge adapter explicitly declares its supported media kinds, delivery modes, and size limits; plugin file contribution rules live in `PLUGINS.md`.

Local staged files are uploaded directly by platform adapters when possible: Telegram / Feishu / WeChat use their native upload flows, and QQ uses the official bot chunked-upload flow before sending `msg_type: 7` rich media. `preferences.bridge.mediaPublicBaseUrl` / `LUC_BRIDGE_PUBLIC_BASE_URL` are only for consumers or fallback paths that still require an internet-reachable URL.

The server runs as a standalone Node.js process (spawned by Electron or independently), bundled via Vite with @vercel/nft for dependency tracing. It communicates with the Electron renderer through WebSocket.
User data is rooted at `LUC_HOME` (`~/.luccode` in production, `~/.luccode-dev` in development). Luc-managed Pi SDK runtime resources live under `${LUC_HOME}/runtime/pi-sdk/`; Luc does not rely on Pi's global agent directory or `PI_CODING_AGENT_DIR`. Legacy `fd` / `rg` binaries under `${LUC_HOME}/.pi/agent/bin/` are copied into the new directory on first use of the corresponding search tool, while the legacy files remain untouched.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 42 |
| Frontend | React 19 + Zustand 5 + CSS Modules |
| Build | Vite 7 |
| Server | Hono + @hono/node-server |
| Agent Runtime | [Pi SDK](https://github.com/badlogic/pi-mono) |
| Database | better-sqlite3 (WAL mode) |
| i18n | 5 languages (zh / en / ja / ko / zh-TW) |

## Platform Support

| Platform | Status |
|----------|--------|
| Windows (x64) | Supported |
| Mobile (PWA) | v0: phone sessions and workbench access through the same LucCode Server |

## Development

```bash
# Install dependencies
npm install

# Start with Electron (builds renderer first)
npm start

# Start with Vite HMR (run npm run dev:renderer first)
npm run start:vite

# Server only
npm run server

# Server-first CLI
npm run cli

# Type check
npm run typecheck
```

## Filing Issues

Issues describe problems or needs only. We do not accept code implementations (fix suggestions, patches, diffs, implementation plans or examples). Issues that break this rule are closed.

- **Bug**: Have your Agent reproduce and investigate the problem in your environment, then submit a verifiable report with the Bug Report template: list the actual problems, the steps to reproduce them, and how to verify a fix. Do not describe how to change the code.
- **Feature**: Talk the idea through with your Agent first, then submit a spec with the Feature Request template: what you want, why you need it, and what result counts as done. Do not describe an implementation.

See [Contributing](CONTRIBUTING.md) for details.

## Acknowledgments

- [tw93/kami](https://github.com/tw93/kami): the progressive-disclosure structure of the beautify plugin's HTML aesthetic guide (a router entry with flat on-demand sections) was inspired by this project.

## License

[Apache License 2.0](LICENSE)

## Links

- [Report an Issue](https://github.com/LuoJunCheng/luccode/issues)
- [Security](https://github.com/LuoJunCheng/luccode/security)
- [Security Policy](SECURITY.md)
- [Plugin Development](PLUGINS.md)
- [Contributing](CONTRIBUTING.md)
