/**
 * error-bus-bridge.ts — ErrorBus (shared) → Zustand toast store bridge
 *
 * Call initErrorBusBridge() once during app init to wire up the renderer-side
 * ErrorBus subscriber to the toast slice.
 */

import { errorBus } from '../../../../shared/error-bus.ts';
import { useStore } from '../stores';
import { translateKeyOrNull } from './error-presenter';
import type { ErrorRoute } from './types';

export function initErrorBusBridge(): void {
  errorBus.subscribe((entry, route) => {
    const routeKey = route as ErrorRoute;
    const { error } = entry;
    // 本地化文案优先。以前把 error.message 排在最前，而后端几乎总会带一句英文
    // message，于是 userMessageKey 永远轮不到，整套 i18n 形同虚设。
    const userMessage = translateKeyOrNull(error.userMessageKey) || error.message || error.code;

    switch (routeKey) {
      case 'toast':
        useStore.getState().addToast(
          userMessage,
          error.severity === 'cosmetic' ? 'warning' : 'error',
          error.severity === 'critical' ? 0 : 5000,
          {
            errorCode: error.code,
            persistent: error.severity === 'critical',
            dedupeKey: error.code,
          }
        );
        break;
      case 'statusbar':
        // WebSocket manages its own wsState in connection-slice
        break;
      case 'boundary':
        // ErrorBoundary catches render errors directly
        break;
      case 'silent':
        // Log only (already logged by ErrorBus._log)
        break;
    }
  });
}
