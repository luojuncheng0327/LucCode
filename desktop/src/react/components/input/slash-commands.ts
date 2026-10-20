/**
 * slash-commands.ts — 斜杠命令定义和执行逻辑
 *
 * 从 InputArea.tsx 提取，减少主组件体量。
 */

import { lucFetch } from '../../hooks/use-luc-fetch';
import { getWebSocket } from '../../services/websocket';
import { useStore } from '../../stores';

// ── Xing Prompt ──

const isZh = window.i18n?.locale?.startsWith?.('zh') ?? true;

export const XING_PROMPT = isZh
  ? `回顾本次对话中我（用户）发送的消息，提取可复用的工作流程、纠正和操作经验。

不要把用户的个人画像、审美喜好、兴趣、生活近况写进技能；这些属于记忆系统。
只把“以后遇到类似任务应该怎么做”的内容写成通用技能。

你必须先查阅 skill-creator 技能，按照其中 "Capture Intent" 和 "Write the SKILL.md" 部分的流程操作。
只做到创建并安装为止，不需要做 eval、benchmark 或 description optimization。

最终产物必须是完整 skill package：包含 SKILL.md，且 references/scripts/assets 等配套资源必须保留在同一个 skill 目录里。不要调用 install_skill 传 skill_content；模型侧 install_skill 只接受 GitHub 仓库等完整包来源。如果本轮生成的是本地 skill，请先把完整目录写到工作区并说明需要通过技能管理导入该目录或 zip，不能把单个 SKILL.md 冒充成完整安装。`
  : `Review the messages I (the user) sent in this session and extract reusable workflows, corrections, and operational lessons.

Do not write the user's personal profile, aesthetic tastes, interests, or life/current-state context into a skill; those belong in memory.
Only turn "how to handle similar tasks in the future" into a reusable skill.

You must first consult the skill-creator skill, following its "Capture Intent" and "Write the SKILL.md" sections.
Only go as far as creating and installing — do not run evals, benchmarks, or description optimization.

The final artifact must be a complete skill package: it must contain SKILL.md, and references/scripts/assets must stay in the same skill directory when needed. Do not call install_skill with skill_content; the model-facing install_skill tool only accepts complete package sources such as GitHub repositories. If this session creates a local skill, write the complete directory into the workspace and explain that the user should import that directory or zip through skill management; never treat a single SKILL.md as a complete install.`;

// ── Slash Command Interface ──

export interface SlashItem {
  name: string;
  aliases?: string[];
  label: string;
  description: string;
  busyLabel: string;
  icon: string;
  type: 'builtin' | 'skill' | 'server-command';
  execute: (inputText?: string) => Promise<void> | void;
}

export const MAX_SLASH_TRIGGER_LENGTH = 20;

/**
 * applySlashCompletion — 菜单选择 server-command 后，把编辑器原始文本改写为
 * canonical 命令文本（`/${item.name}`），保留首个 slash token 之后的一切内容
 * （空格、参数、多行）。非 slash 开头的文本走菜单按钮时丢弃输入，回退为纯
 * canonical 命令（复刻既有兜底语义）。一律替换为 canonical name（不保留用户
 * 输入的 alias），因为服务端 dispatch 的 alias 解析能力未验证。
 */
export function applySlashCompletion(
  text: string,
  item: Pick<SlashItem, 'name'>,
): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return `/${item.name}`;
  const tokenMatch = /^\/(\S*)/.exec(trimmed);
  if (!tokenMatch) return `/${item.name}`;
  return `/${item.name}${trimmed.slice(tokenMatch[0].length)}`;
}

export function getSlashMatches(text: string, commands: SlashItem[]): SlashItem[] {
  const normalized = text.trim();
  if (!normalized.startsWith('/')) return [];
  const query = normalized.slice(1).split(/\s+/, 1)[0].toLowerCase();
  if (query.length > MAX_SLASH_TRIGGER_LENGTH) return [];
  return commands.filter(command => {
    if (command.name.startsWith(query)) return true;
    return (command.aliases || []).some(alias => alias.toLowerCase().startsWith(query));
  });
}

export function resolveSlashSubmitSelection({
  text,
  skills,
  commands,
  selectedIndex,
  dismissedText,
}: {
  text: string;
  skills: string[];
  commands: SlashItem[];
  selectedIndex: number;
  dismissedText: string | null;
}): SlashItem | null {
  if (skills.length > 0) return null;
  const matches = getSlashMatches(text, commands);
  if (matches.length === 0) return null;
  if (dismissedText === text.trim()) return null;
  const selected = matches[selectedIndex] || matches[0] || null;
  if (!selected) return null;
  const hasArgs = /\s/.test(text.trim().slice(1));
  if (hasArgs && selected.type !== 'server-command') return null;
  return selected;
}

// ── Command Executors ──

type ToastType = 'success' | 'error' | 'info' | 'warning';
type AddToast = (
  text: string,
  type?: ToastType,
  duration?: number,
  opts?: { persistent?: boolean; dedupeKey?: string },
) => number | null;
type RemoveToast = (id: number) => void;

const DIARY_WRITE_TIMEOUT_MS = 150_000;

export function executeDiary(
  t: (key: string) => string,
  addToast: AddToast,
  removeToast: RemoveToast,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => void {
  return () => {
    setInput('');
    setMenuOpen(false);
    const progressToastId = addToast(t('slash.diaryBusy'), 'info', 0, {
      persistent: true,
      dedupeKey: 'slash-diary-progress',
    });

    void (async () => {
      try {
        const res = await lucFetch('/api/diary/write', {
          method: 'POST',
          timeout: DIARY_WRITE_TIMEOUT_MS,
          throwOnHttpError: false,
        });
        let data: { error?: string } = {};
        try {
          data = await res.json();
        } catch {
          data = {};
        }
        if (progressToastId !== null) removeToast(progressToastId);
        if (!res.ok || data.error) {
          addToast(data.error || t('slash.diaryFailed'), 'error', 6000);
          return;
        }
        addToast(t('slash.diaryDone'), 'success', 5000);
      } catch {
        if (progressToastId !== null) removeToast(progressToastId);
        addToast(t('slash.diaryFailed'), 'error', 6000);
      }
    })();
  };
}

export function executeCompact(
  t: (key: string) => string,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): () => Promise<void> {
  return async () => {
    const state = useStore.getState();
    if (!state.currentSessionId) {
      state.addToast(t('error.noActiveSession'), 'error', 6000);
      return;
    }
    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      state.addToast(t('status.disconnected'), 'error', 6000);
      return;
    }
    setBusy('compact');
    setInput('');
    setMenuOpen(false);
    try {
      ws.send(JSON.stringify({ type: 'compact', sessionId: state.currentSessionId }));
    } finally {
      setTimeout(() => setBusy(null), 1500);
    }
  };
}

/**
 * 通用的 WS slash 命令发送器。
 * 桌面端的入口是菜单里的 server-command 类命令（/loop、插件与扩展注册的命令），
 * 以及用户直接敲出的同名 slash 文本；桌面已有 GUI 的 core 命令不从这里走。
 * 后端在 server/routes/chat.ts 接收 {type:'slash'}，走 engine.slashDispatcher.tryDispatch。
 *
 * agentId 由调用方显式传入，不在这里从任何全局指针推导：命令要在哪个助手身上执行，
 * 只有渲染这个输入框的会话说了算。服务端认的是会话清单里记着的归属，跟这个会话有没有
 * 被加载进内存无关；这个字段覆盖的是另一种情况——服务端根本不认识的草稿会话，它还没
 * 落进清单，归属只有前端知道。身份确实未知时传 null，让"不知道"显式出现在协议上，
 * 而不是悄悄少一个字段。
 *
 * 执行结果由服务端通过 WS {type:'slash_result'} 回来，ws-message-handler 的同名分支
 * 把它送进 inline notice 显示给用户。这里的 800ms setBusy(null) 与结果无关，只是给按钮
 * 一个防抖窗口，不代表命令已经执行完。
 */
export function executeSlashViaWs(
  cmd: string,
  agentId: string | null,
  setBusy: (name: string | null) => void,
  setInput: (text: string) => void,
  setMenuOpen: (open: boolean) => void,
): (inputText?: string) => Promise<void> {
  return async (inputText?: string) => {
    setBusy(cmd);
    setInput('');
    setMenuOpen(false);
    const rawText = typeof inputText === 'string' && inputText.trim().startsWith('/')
      ? inputText.trim()
      : `/${cmd}`;
    try {
      const ws = getWebSocket();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'slash',
          text: rawText,
          sessionPath: useStore.getState().currentSessionPath,
          agentId: agentId || null,
        }));
      }
    } finally {
      setTimeout(() => setBusy(null), 800);
    }
  };
}

export function buildSlashCommands(
  t: (key: string) => string,
  executeDiaryFn: () => Promise<void> | void,
  executeXingFn: () => Promise<void>,
  executeCompactFn: () => Promise<void>,
): SlashItem[] {
  const list: SlashItem[] = [
    {
      name: 'diary',
      label: '/diary',
      description: t('slash.diary'),
      busyLabel: t('slash.diaryBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
      type: 'builtin',
      execute: executeDiaryFn,
    },
    {
      name: 'xing',
      label: '/xing',
      description: t('slash.xing'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      type: 'builtin',
      execute: executeXingFn,
    },
    {
      name: 'compact',
      label: '/compact',
      description: t('slash.compact'),
      busyLabel: t('slash.compactBusy'),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
      type: 'builtin',
      execute: executeCompactFn,
    },
    // /loop 是服务端命令且必须带参数（任务描述 / 子命令），所以走 server-command 通道：
    // 提交时由 InputArea 经 applySlashCompletion 保留参数原文，再整条发给服务端 dispatcher。
    {
      name: 'loop',
      label: '/loop',
      description: t('slash.loop'),
      busyLabel: '',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      type: 'server-command',
      execute: () => {},
    },
  ];
  return list;
}
