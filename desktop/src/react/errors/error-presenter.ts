/**
 * error-presenter.ts — 把任意错误呈现成"人话 + 可展开详情"
 *
 * 后端抛出的 Error 带的是英文 message 和一个错误码。直接把 message 显示给用户
 * 是过去所有中文界面里冒出英文报错的原因。这里统一做一次转换：错误码查得到文案
 * 就说人话，查不到就用兜底文案，原始英文一律落到 detail，排障时仍然拿得到。
 *
 * 兜底顺序是显式的、不静默：本地化文案 → 兜底文案 → 原始 message → 错误码。
 * 语言包漏配某条时 translate() 会把 key 原样吐回来，这里会识别出来并退回原始
 * message，绝不会把 error.code.xxx 这样的 key 当文案显示给用户。
 */

import {
  UNKNOWN_ERROR_MESSAGE_KEY,
  userMessageKeyForCode,
} from '../../../../shared/error-user-messages.ts';

export interface PresentedError {
  /** 已本地化的一句话，直接显示给用户。 */
  text: string;
  /** 原始英文 message / 堆栈。跟 text 重复时为 null。 */
  detail: string | null;
  /** 后端错误码，供详情区展示与问题上报。 */
  code: string | null;
}

type Translate = (key: string) => string;

interface PresentOptions {
  /** 注入翻译函数；默认取 window.t。 */
  translate?: Translate;
  /** 覆盖兜底文案 key。 */
  fallbackKey?: string;
}

/** 造一个带错误码的 Error，让错误码跟着异常一路传到呈现层。 */
export function errorWithCode(message: string, code: string | null): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  if (typeof code === 'string' && code.trim()) error.code = code.trim();
  return error;
}

function defaultTranslate(key: string): string {
  const translator = typeof window !== 'undefined' ? window.t : undefined;
  return typeof translator === 'function' ? translator(key) : key;
}

/**
 * 翻译一个 key；语言包没有这条时 t() 会返回 key 本身，那等同于没翻出来，返回 null。
 * 调用方据此决定退回原始 message 还是错误码，绝不把 key 当文案显示。
 */
export function translateKeyOrNull(key: string, translate: Translate = defaultTranslate): string | null {
  if (!key) return null;
  const value = translate(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === key) return null;
  return trimmed;
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as { code?: unknown }).code;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed || null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return (error.message || '').trim();
  if (typeof error === 'string') return error.trim();
  if (error === null || error === undefined) return '';
  return String(error).trim();
}

/** 把错误转成可直接渲染的结构。 */
export function presentError(error: unknown, options: PresentOptions = {}): PresentedError {
  const translate = options.translate || defaultTranslate;
  const fallbackKey = options.fallbackKey || UNKNOWN_ERROR_MESSAGE_KEY;
  const code = codeOf(error);
  const raw = messageOf(error);

  const mappedKey = userMessageKeyForCode(code);
  const text = (mappedKey ? translateKeyOrNull(mappedKey, translate) : null)
    || translateKeyOrNull(fallbackKey, translate)
    || raw
    || code
    || 'Unexpected error';

  return {
    text,
    // 详情只在真的多出信息时保留：跟正文重复、或者原文本身就是错误码（那些老 route
    // 把错误码直接放在 error 字段里）时留空，code 字段已经单独带着它了。
    detail: raw && raw !== text && raw !== code ? raw : null,
    code,
  };
}

/**
 * 只要一句话的失败原因：错误码翻得出人话就说人话，翻不出就退回原文。
 *
 * 跟 presentError 的分工看呈现位置有没有详情区。有详情区的（inline error、带
 * errorCode 的 toast）用 presentError：它把原始英文塞进 detail，正文可以放心换成
 * 兜底文案，信息一条都不丢。设置页这种单行 toast 没有详情区，正文是唯一的载体——
 * 那里若用兜底文案盖掉原文，英文就彻底消失了，用户连报障时能贴的线索都没有。
 * 所以这里的档位链把原文排在兜底文案前面：
 *
 *   映射到的本地化文案 → 原始 message → 错误码 → 通用兜底文案
 *
 * 后两档是给空 message 兜的：拿不到原文时宁可显示一个错误码，也好过让调用方拼出
 * "切换失败: "这样后面空着的半句话。
 */
export function localizedReasonOrRaw(error: unknown, translate: Translate = defaultTranslate): string {
  const code = codeOf(error);
  const mappedKey = userMessageKeyForCode(code);
  return (mappedKey ? translateKeyOrNull(mappedKey, translate) : null)
    || messageOf(error)
    || code
    || translateKeyOrNull(UNKNOWN_ERROR_MESSAGE_KEY, translate)
    || 'Unexpected error';
}

/**
 * 呈现一个带动作前缀的错误，例如"新建会话失败：会话正忙，稍后再试"。
 * 前缀由调用方给出（已本地化），详情与错误码原样保留。
 */
export function presentErrorWithLabel(
  label: string,
  error: unknown,
  options: PresentOptions = {},
): PresentedError {
  const presented = presentError(error, options);
  const prefix = label.trim();
  if (!prefix) return presented;
  // 分隔符沿用界面既有写法（半角冒号加空格），中英日韩共用一套，不按语言分叉。
  return { ...presented, text: `${prefix}: ${presented.text}` };
}
