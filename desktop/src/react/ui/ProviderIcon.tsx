import { PROVIDER_ICONS } from './provider-icons';
import groupStyles from './ProviderIcon.module.css';

/**
 * provider id（来自 /api/models 的 m.provider，对应 provider-presets 的 value）
 * → lobehub 图标 key。多个 provider 可共享同一品牌图标（如 token-plan 变体）。
 */
const PROVIDER_TO_ICON: Record<string, string> = {
  deepseek: 'deepseek',
  'deepseek-responses': 'deepseek',
  dashscope: 'qwen',
  openai: 'openai',
  gemini: 'gemini',
  volcengine: 'volcengine',
  moonshot: 'moonshot',
  'kimi-coding': 'kimi',
  zhipu: 'zhipu',
  'zhipu-coding': 'zhipu',
  siliconflow: 'siliconcloud',
  groq: 'groq',
  mistral: 'mistral',
  minimax: 'minimax',
  'minimax-token-plan': 'minimax',
  openrouter: 'openrouter',
  fireworks: 'fireworks',
  mimo: 'xiaomimimo',
  'mimo-token-plan': 'xiaomimimo',
  ollama: 'ollama',
};

interface ProviderIconProps {
  provider?: string;
  className?: string;
}

/**
 * 渲染某个模型提供商的单色 logo（fill: currentColor，继承父级文字颜色）。
 * 图标数据由 scripts/gen-provider-icons.mjs 从 @lobehub/icons (MIT) 和本地 SVG 源内联生成。
 * 未知 provider 回退到系统风格的中性 stroke 占位图标，永不为空、永不报错。
 */
/** 把 provider id 归一到图标 key，兼容 coding-plan / token-plan / oauth / codex 等变体后缀 */
function iconKeyFor(provider?: string): string | undefined {
  if (!provider) return undefined;
  const p = provider.toLowerCase();
  if (PROVIDER_TO_ICON[p]) return PROVIDER_TO_ICON[p];
  const base = p.replace(/-(coding-plan|coding|token-plan|oauth|codex-oauth|codex)$/, '');
  if (PROVIDER_TO_ICON[base]) return PROVIDER_TO_ICON[base];
  if (base.startsWith('openai')) return 'openai';
  return undefined;
}

export function ProviderIcon({ provider, className }: ProviderIconProps) {
  const iconKey = iconKeyFor(provider);
  const icon = iconKey ? PROVIDER_ICONS[iconKey] : undefined;

  if (!icon) {
    return (
      <svg
        className={className}
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <rect x="4.5" y="4.5" width="15" height="15" rx="4" />
        <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <svg
      className={className}
      width="1em"
      height="1em"
      viewBox={icon.viewBox}
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: icon.content }}
    />
  );
}

/**
 * 模型列表的分组标题：provider 图标 + 名字（小写）。
 * 聊天页 ModelSelector 与设置页 AgentTab 共用，确保两处样式一致。
 * 搭配 SelectWidget 的 popupClassName={selectWidgetStyles.providerInset}，
 * 让选项文字与分组标题文字左对齐（图标凸出在左侧）。
 */
export function ProviderGroupHeader({ provider }: { provider: string }) {
  return (
    <div className={groupStyles.groupHeader}>
      <ProviderIcon provider={provider} className={groupStyles.icon} />
      <span className={groupStyles.label}>{provider}</span>
    </div>
  );
}
