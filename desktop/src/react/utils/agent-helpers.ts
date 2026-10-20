/**
 * agent-helpers.ts — Yuan 辅助纯函数
 *
 * 从 app-agents-shim.ts 提取。不依赖 ctx 注入，直接使用 Zustand store。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- t() 返回值 + opts/patch 为动态 Record */

import { useStore } from '../stores';
import { displayInitial } from './grapheme';

function tr(key: string, vars?: Record<string, string>): any {
  const fn = (globalThis as any).t || (globalThis as any).window?.t;
  return typeof fn === 'function' ? fn(key, vars) : undefined;
}

export function yuanFallbackAvatar(yuan?: string): string {
  const types = tr('yuan.types') || {};
  const entry = types[yuan || 'luc'];
  return `assets/${entry?.avatar || 'Luc.png'}`;
}

export function userFallbackAvatar(displayName: string): string {
  const initial = displayInitial(displayName || 'User', 'U');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">',
    '<rect width="40" height="40" rx="20" fill="#f0eee9"/>',
    '<text x="20" y="24" text-anchor="middle" font-family="Georgia, serif" font-size="15" font-weight="600" fill="#2f6f8f">',
    initial,
    '</text>',
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function randomWelcome(agentName?: string, yuan?: string): string {
  const s = useStore.getState();
  const name = agentName || s.agentName;
  const y = yuan || s.agentYuan;
  const yuanMsgs = tr(`yuan.welcome.${y}`);
  const msgs = Array.isArray(yuanMsgs) ? yuanMsgs : tr('welcome.messages');
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const raw = msgs[Math.floor(Math.random() * msgs.length)];
  return raw.replaceAll('{name}', name);
}

export function yuanPlaceholder(yuan?: string): string {
  const s = useStore.getState();
  const y = yuan || s.agentYuan;
  const yuanPh = tr(`yuan.placeholder.${y}`);
  return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : tr('input.placeholder');
}
