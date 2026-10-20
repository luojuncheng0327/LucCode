/**
 * Luc 动画原语组件
 *
 * 四个组件覆盖 90% 的动效场景：
 * - FadeIn：淡入 + 微上移，适合卡片、菜单、任何条件渲染元素
 * - Collapse：高度折叠/展开，适合折叠面板、详情区域
 * - SlideIn：方向性滑入，适合侧栏、面板
 * - AnimatedList：列表项增删 + 重排动画
 *
 * 所有组件基于 motion (framer-motion v12)，使用 spring 物理预设。
 * 调用方只需包裹即可，无需了解底层 API。
 */

import {
  type ReactNode,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  forwardRef,
} from 'react';
import {
  motion,
  AnimatePresence,
  LayoutGroup,
  type Transition,
} from 'motion/react';
import { spring } from './motion';

// ── FadeIn ───────────────────────────────────────────

interface FadeInProps {
  children: ReactNode;
  /** 弹簧预设，默认 paper */
  preset?: keyof typeof spring;
  /** 延迟（秒） */
  delay?: number;
  /** 入场 Y 偏移量（px），默认 4 */
  y?: number;
  /** 作为 AnimatePresence 直接子元素时需要 */
  className?: string;
  style?: CSSProperties;
}

/**
 * 淡入 + 微上移。用 AnimatePresence 包裹可获得退场动画。
 *
 * ```tsx
 * <AnimatePresence>
 *   {show && <FadeIn key="card"><Card /></FadeIn>}
 * </AnimatePresence>
 * ```
 */
export const FadeIn = forwardRef<HTMLDivElement, FadeInProps>(function FadeIn(
  { children, preset = 'paper', delay = 0, y = 4, className, style },
  ref,
) {
  const transition: Transition = delay
    ? { ...spring[preset], delay }
    : spring[preset];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={transition}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
});

// ── Collapse ─────────────────────────────────────────

interface CollapseProps {
  /** 是否展开 */
  open: boolean;
  children: ReactNode;
  /** 弹簧预设，默认 paper */
  preset?: keyof typeof spring;
  className?: string;
  style?: CSSProperties;
}

/**
 * 高度折叠/展开。内部已包含 AnimatePresence，调用方无需额外包裹。
 *
 * ```tsx
 * <Collapse open={expanded}>
 *   <Details />
 * </Collapse>
 * ```
 */
export function Collapse({ open, children, preset = 'paper', className, style }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="collapse-body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={spring[preset]}
          style={{ overflow: 'hidden', ...style }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── SlideIn ──────────────────────────────────────────

type SlideDirection = 'left' | 'right' | 'top' | 'bottom';

interface SlideInProps {
  children: ReactNode;
  /** 滑入方向，默认 right */
  from?: SlideDirection;
  /** 弹簧预设，默认 paperGentle */
  preset?: keyof typeof spring;
  /** 滑动距离（px），默认 300 */
  distance?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * 方向性滑入。用 AnimatePresence 包裹可获得退场动画。
 *
 * ```tsx
 * <AnimatePresence>
 *   {panelOpen && <SlideIn key="panel" from="right"><Panel /></SlideIn>}
 * </AnimatePresence>
 * ```
 */
export const SlideIn = forwardRef<HTMLDivElement, SlideInProps>(function SlideIn(
  { children, from = 'right', preset = 'paperGentle', distance = 300, className, style },
  ref,
) {
  const axis = from === 'left' || from === 'right' ? 'x' : 'y';
  const sign = from === 'right' || from === 'bottom' ? 1 : -1;
  const offset = distance * sign;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0.5, [axis]: offset }}
      animate={{ opacity: 1, [axis]: 0 }}
      exit={{ opacity: 0, [axis]: offset }}
      transition={spring[preset]}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
});

// ── AnimatedList ──────────────────────────────────────

interface AnimatedListProps {
  children: ReactNode;
  /** 弹簧预设，默认 paper */
  preset?: keyof typeof spring;
  /** LayoutGroup 的 id，多个列表共存时需区分 */
  layoutId?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 列表容器，为子元素提供增删 + 重排动画。
 * 子元素必须有稳定的 key。
 *
 * ```tsx
 * <AnimatedList>
 *   <AnimatePresence initial={false}>
 *     {items.map(item => (
 *       <AnimatedListItem key={item.id}>{item.name}</AnimatedListItem>
 *     ))}
 *   </AnimatePresence>
 * </AnimatedList>
 * ```
 */
export function AnimatedList({ children, layoutId, className, style }: AnimatedListProps) {
  return (
    <LayoutGroup id={layoutId}>
      <div className={className} style={style}>
        {children}
      </div>
    </LayoutGroup>
  );
}

interface AnimatedListItemProps extends ComponentPropsWithoutRef<typeof motion.div> {
  children: ReactNode;
  /** 弹簧预设，默认 paper */
  preset?: keyof typeof spring;
}

/**
 * 列表项，自动具备入场、退场、重排动画。
 * 必须放在 AnimatedList + AnimatePresence 内。
 */
export const AnimatedListItem = forwardRef<HTMLDivElement, AnimatedListItemProps>(
  function AnimatedListItem({ children, preset = 'paper', ...rest }, ref) {
    return (
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 6, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, x: -20, scale: 0.95 }}
        transition={spring[preset]}
        {...rest}
      >
        {children}
      </motion.div>
    );
  },
);

// ── Re-export motion 核心 API ────────────────────────
// 让业务组件只从 @/ui 导入，不直接依赖 motion 包名

export { motion, AnimatePresence, LayoutGroup };
export type { Transition };
