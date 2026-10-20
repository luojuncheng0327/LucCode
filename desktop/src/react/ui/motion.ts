/**
 * Luc 动画系统 · Spring 预设与动画原语
 *
 * 三组弹簧预设，模拟纸质感的物理反馈：轻微过冲后快速稳定。
 * 所有运动组件共享这套预设，保证全局一致的动效语言。
 *
 * 用法：
 *   import { spring, FadeIn, Collapse, SlideIn } from '@/ui';
 *   <FadeIn><Card /></FadeIn>
 *   <Collapse open={expanded}><Details /></Collapse>
 */

import type { Transition } from 'motion/react';

// ── Spring 预设 ──────────────────────────────────────

/** 纸质弹簧：通用默认。适度过冲，快速稳定。 */
const paper: Transition = { type: 'spring', stiffness: 500, damping: 38, mass: 0.8 };

/** 纸质柔和：大面板、模态、侧栏。过冲更轻，稳定更缓。 */
const paperGentle: Transition = { type: 'spring', stiffness: 350, damping: 34, mass: 1.0 };

/** 纸质利落：菜单、tooltip、小元素。过冲极轻，响应最快。 */
const paperSnap: Transition = { type: 'spring', stiffness: 600, damping: 40, mass: 0.6 };

export const spring = { paper, paperGentle, paperSnap } as const;

// ── Motion Token（CSS 变量映射） ────────────────────
// 供混合场景（部分 CSS transition + 部分 framer-motion）对齐时长。
// 值与 styles.css :root 的 --duration-* 一致，单位秒。

export const motionDuration = {
  instant: 0.08,
  fast: 0.18,
  normal: 0.28,
  slow: 0.4,
} as const;
