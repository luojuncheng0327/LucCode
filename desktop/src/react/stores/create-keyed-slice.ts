import { useStore } from './index';
import { sessionScopedKey } from './session-slice';

/**
 * Generic updater for keyed-by-session state + compat global field.
 *
 * Usage in ws-message-handler:
 *   updateKeyed('contextBySession', sessionPath, data,
 *     (s, d) => ({ contextTokens: d.tokens, contextWindow: d.window, contextPercent: d.percent }));
 */
export function updateKeyed<T>(
  keyedField: string,
  sessionPath: string,
  value: T,
  toCompat?: (state: any, value: T) => Record<string, any>,
) {
  useStore.setState((s: any) => {
    const key = sessionScopedKey(s, sessionPath) || sessionPath;
    const keyed = { ...s[keyedField], [key]: value };
    if (key !== sessionPath) delete keyed[sessionPath];
    const compat = (sessionPath === s.currentSessionPath && toCompat)
      ? toCompat(s, value)
      : {};
    return { [keyedField]: keyed, ...compat };
  });
}
