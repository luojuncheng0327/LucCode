import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_SURFACE_SESSION_QUERY,
  PLUGIN_UI_CAPABILITY,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_PROTOCOL_VERSION,
  parsePluginUiMessage,
  type PluginResourceOpenInput,
  type PluginResourceOpenResult,
  type PluginResourcePickInput,
  type PluginResourcePickResult,
  type PluginResourceRequestAccessInput,
  type PluginResourceRequestAccessResult,
  type PluginUiError,
  type PluginUiMessage,
} from '@luccode/plugin-protocol';

export interface LucPluginSize {
  width?: number;
  height?: number;
}

export interface LucPluginThemeSnapshot {
  theme?: string;
  cssUrl?: string;
}

export interface LucPluginRequestOptions {
  timeoutMs?: number;
}

export type LucToastType = 'success' | 'error' | 'info' | 'warning';

export interface LucToastShowInput {
  message: string;
  type?: LucToastType;
  duration?: number;
}

export interface LucToastShowResult {
  shown: boolean;
}

export type LucExternalOpenInput = string | { url: string };

export interface LucExternalOpenResult {
  opened: boolean;
}

export type LucClipboardWriteTextInput = string | { text: string };

export interface LucClipboardWriteTextResult {
  written: boolean;
}

export interface LucPluginSdkOptions {
  parentWindow?: Window;
  targetWindow?: Window;
  targetOrigin?: string;
  requestTimeoutMs?: number;
  idFactory?: () => string;
}

export interface LucPluginSdk {
  ready(payload?: unknown): void;
  assets: {
    url(path: string): string;
  };
  api: {
    url(path: string): string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  ui: {
    resize(size: LucPluginSize): void;
  };
  theme: {
    getSnapshot(): LucPluginThemeSnapshot;
    subscribe(callback: (theme: LucPluginThemeSnapshot) => void): () => void;
  };
  host: {
    request<T = unknown>(
      type: string,
      payload?: unknown,
      options?: LucPluginRequestOptions,
    ): Promise<T>;
  };
  toast: {
    show(input: LucToastShowInput, options?: LucPluginRequestOptions): Promise<LucToastShowResult>;
  };
  external: {
    open(input: LucExternalOpenInput, options?: LucPluginRequestOptions): Promise<LucExternalOpenResult>;
  };
  clipboard: {
    writeText(
      input: LucClipboardWriteTextInput,
      options?: LucPluginRequestOptions,
    ): Promise<LucClipboardWriteTextResult>;
  };
  resources: {
    open(
      input: PluginResourceOpenInput,
      options?: LucPluginRequestOptions,
    ): Promise<PluginResourceOpenResult>;
    pick(
      input?: PluginResourcePickInput,
      options?: LucPluginRequestOptions,
    ): Promise<PluginResourcePickResult>;
    requestAccess(
      input: PluginResourceRequestAccessInput,
      options?: LucPluginRequestOptions,
    ): Promise<PluginResourceRequestAccessResult>;
  };
}

export class LucPluginError extends Error {
  override name = 'LucPluginError';
  readonly code: string;
  readonly details?: unknown;

  constructor(error: PluginUiError) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
}

let fallbackIdSeq = 0;

function defaultIdFactory(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackIdSeq += 1;
  return `luc-plugin-${Date.now()}-${fallbackIdSeq}`;
}

function getBrowserWindow(): Window {
  if (typeof window === 'undefined') {
    throw new Error('@luccode/plugin-sdk requires a browser iframe window.');
  }
  return window;
}

function safeOriginFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function resolveTargetOrigin(targetWindow: Window, explicit?: string): string {
  if (explicit) return explicit;

  const hostOrigin = new URLSearchParams(targetWindow.location.search).get('luc-host-origin');
  if (hostOrigin) return hostOrigin;

  return safeOriginFromUrl(targetWindow.document.referrer) ?? '*';
}

function readInitialTheme(targetWindow: Window): LucPluginThemeSnapshot {
  const params = new URLSearchParams(targetWindow.location.search);
  return {
    theme: params.get('luc-theme') ?? undefined,
    cssUrl: params.get('luc-css') ?? undefined,
  };
}

function isTrustedHostEvent(event: MessageEvent, parentWindow: Window, targetOrigin: string): boolean {
  if (event.source !== parentWindow) return false;
  if (targetOrigin !== '*' && event.origin !== targetOrigin) return false;
  return true;
}

function externalOpenPayload(input: LucExternalOpenInput): { url: string } {
  return typeof input === 'string' ? { url: input } : input;
}

function clipboardWriteTextPayload(input: LucClipboardWriteTextInput): { text: string } {
  return typeof input === 'string' ? { text: input } : input;
}

function readPluginIdFromIframeRoute(targetWindow: Window): string {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(targetWindow.location.pathname || '');
  if (!match) {
    throw new Error('Plugin asset URL helper requires an iframe route under /api/plugins/:pluginId/.');
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new Error('Plugin asset URL helper could not decode the current plugin id.');
  }
}

function normalizeAssetPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid plugin asset path.');
  }
  if (input.includes('\\') || input.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('Invalid plugin asset path.');
  }
  const stripped = input.replace(/^\/+/, '');
  if (!stripped || stripped.startsWith('./')) {
    throw new Error('Invalid plugin asset path.');
  }
  const segments = stripped.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error('Invalid plugin asset path.');
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function pluginAssetUrl(targetWindow: Window, input: string): string {
  const pluginId = readPluginIdFromIframeRoute(targetWindow);
  const assetPath = normalizeAssetPath(input);
  return `${targetWindow.location.origin}/api/plugins/${encodeURIComponent(pluginId)}/assets/${assetPath}`;
}

function readSurfaceSession(targetWindow: Window): string | null {
  return new URLSearchParams(targetWindow.location.search).get(PLUGIN_SURFACE_SESSION_QUERY) || null;
}

function normalizePluginApiPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid plugin API path.');
  }
  const trimmed = input.trim();
  if (
    !trimmed
    || trimmed.includes('\\')
    || trimmed.includes('\0')
    || trimmed.includes('#')
    || trimmed.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    throw new Error('Invalid plugin API path.');
  }

  const stripped = trimmed.replace(/^\/+/, '');
  if (!stripped || stripped.startsWith('./') || stripped === 'api/plugins' || stripped.startsWith('api/plugins/')) {
    throw new Error('Invalid plugin API path. Use a route path relative to the current plugin.');
  }

  const queryIndex = stripped.indexOf('?');
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  if (!rawPath) {
    throw new Error('Invalid plugin API path.');
  }
  const segments = rawPath.split('/');
  for (const segment of segments) {
    if (!segment) throw new Error('Invalid plugin API path.');
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error('Invalid plugin API path.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new Error('Invalid plugin API path.');
    }
  }

  const parsed = new URL(`http://luc.local/${stripped}`);
  const safePath = segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
  return `${safePath}${parsed.search}`;
}

function pluginApiUrl(targetWindow: Window, input: string): string {
  const pluginId = readPluginIdFromIframeRoute(targetWindow);
  const apiPath = normalizePluginApiPath(input);
  return `${targetWindow.location.origin}/api/plugins/${encodeURIComponent(pluginId)}/${apiPath}`;
}

function pluginApiFetch(targetWindow: Window, input: string, init?: RequestInit): Promise<Response> {
  const surfaceSession = readSurfaceSession(targetWindow);
  if (!surfaceSession) {
    throw new Error('luc.api.fetch requires pluginSurfaceSession in the iframe URL.');
  }
  const fetchImpl = targetWindow.fetch?.bind(targetWindow) ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error('luc.api.fetch requires window.fetch.');
  }
  const requestInit = init ?? {};
  const headers = new Headers(requestInit.headers);
  headers.set(PLUGIN_SURFACE_SESSION_HEADER, surfaceSession);
  return fetchImpl(pluginApiUrl(targetWindow, input), {
    ...requestInit,
    headers,
  });
}

export function createLucPluginSdk(options: LucPluginSdkOptions = {}): LucPluginSdk {
  const targetWindow = options.targetWindow ?? getBrowserWindow();
  const parentWindow = options.parentWindow ?? targetWindow.parent;
  const targetOrigin = resolveTargetOrigin(targetWindow, options.targetOrigin);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const idFactory = options.idFactory ?? defaultIdFactory;
  let themeSnapshot = readInitialTheme(targetWindow);
  const themeSubscribers = new Set<(theme: LucPluginThemeSnapshot) => void>();

  function post(message: PluginUiMessage): void {
    parentWindow.postMessage(message, targetOrigin);
  }

  function postEvent(type: string, payload?: unknown): void {
    const message: PluginUiMessage = {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type,
    };
    if (payload !== undefined) message.payload = payload;
    post(message);
  }

  function onThemeMessage(event: MessageEvent): void {
    if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
    const parsed = parsePluginUiMessage(event.data);
    if (!parsed.ok) return;

    const message = parsed.value;
    if (message.kind !== 'event' || message.type !== 'luc.theme.changed') return;
    if (typeof message.payload !== 'object' || message.payload === null) return;

    const payload = message.payload as Record<string, unknown>;
    themeSnapshot = {
      theme: typeof payload.theme === 'string' ? payload.theme : themeSnapshot.theme,
      cssUrl: typeof payload.cssUrl === 'string' ? payload.cssUrl : themeSnapshot.cssUrl,
    };
    for (const callback of themeSubscribers) callback(themeSnapshot);
  }

  function request<T = unknown>(
    type: string,
    payload?: unknown,
    requestOptions: LucPluginRequestOptions = {},
  ): Promise<T> {
    const id = idFactory();
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        targetWindow.removeEventListener('message', onMessage);
        targetWindow.clearTimeout(timeout);
      };

      const onMessage = (event: MessageEvent) => {
        if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
        const parsed = parsePluginUiMessage(event.data);
        if (!parsed.ok) return;

        const message = parsed.value;
        if (message.id !== id || message.type !== type) return;

        if (message.kind === 'response') {
          cleanup();
          resolve(message.payload as T);
        }
        if (message.kind === 'error' && message.error) {
          cleanup();
          reject(new LucPluginError(message.error));
        }
      };

      const timeout = targetWindow.setTimeout(() => {
        cleanup();
        reject(new LucPluginError({
          code: 'TIMEOUT',
          message: `Plugin host request timed out: ${type}.`,
        }));
      }, timeoutMs);

      targetWindow.addEventListener('message', onMessage);

      const message: PluginUiMessage = {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id,
        kind: 'request',
        type,
      };
      if (payload !== undefined) message.payload = payload;
      post(message);
    });
  }

  return {
    ready(payload?: unknown) {
      postEvent('luc.ready', payload);
    },
    assets: {
      url(assetPath: string) {
        return pluginAssetUrl(targetWindow, assetPath);
      },
    },
    api: {
      url(apiPath: string) {
        return pluginApiUrl(targetWindow, apiPath);
      },
      fetch(apiPath: string, init?: RequestInit) {
        return pluginApiFetch(targetWindow, apiPath, init);
      },
    },
    ui: {
      resize(size: LucPluginSize) {
        postEvent(PLUGIN_UI_CAPABILITY.UI_RESIZE, size);
      },
    },
    theme: {
      getSnapshot() {
        return { ...themeSnapshot };
      },
      subscribe(callback: (theme: LucPluginThemeSnapshot) => void) {
        if (themeSubscribers.size === 0) {
          targetWindow.addEventListener('message', onThemeMessage);
        }
        themeSubscribers.add(callback);
        callback({ ...themeSnapshot });
        return () => {
          themeSubscribers.delete(callback);
          if (themeSubscribers.size === 0) {
            targetWindow.removeEventListener('message', onThemeMessage);
          }
        };
      },
    },
    host: {
      request,
    },
    toast: {
      show(input: LucToastShowInput, options?: LucPluginRequestOptions) {
        return request<LucToastShowResult>(PLUGIN_UI_CAPABILITY.TOAST_SHOW, input, options);
      },
    },
    external: {
      open(input: LucExternalOpenInput, options?: LucPluginRequestOptions) {
        return request<LucExternalOpenResult>(PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN, externalOpenPayload(input), options);
      },
    },
    clipboard: {
      writeText(input: LucClipboardWriteTextInput, options?: LucPluginRequestOptions) {
        return request<LucClipboardWriteTextResult>(
          PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
          clipboardWriteTextPayload(input),
          options,
        );
      },
    },
    resources: {
      open(input: PluginResourceOpenInput, options?: LucPluginRequestOptions) {
        return request<PluginResourceOpenResult>(PLUGIN_UI_CAPABILITY.RESOURCE_OPEN, input, options);
      },
      pick(input: PluginResourcePickInput = {}, options?: LucPluginRequestOptions) {
        return request<PluginResourcePickResult>(PLUGIN_UI_CAPABILITY.RESOURCE_PICK, input, options);
      },
      requestAccess(input: PluginResourceRequestAccessInput, options?: LucPluginRequestOptions) {
        return request<PluginResourceRequestAccessResult>(
          PLUGIN_UI_CAPABILITY.RESOURCE_REQUEST_ACCESS,
          input,
          options,
        );
      },
    },
  };
}

let singleton: LucPluginSdk | null = null;

function getSingleton(): LucPluginSdk {
  singleton ??= createLucPluginSdk();
  return singleton;
}

export const luc: LucPluginSdk = {
  ready(payload?: unknown) {
    return getSingleton().ready(payload);
  },
  assets: {
    url(assetPath: string) {
      return getSingleton().assets.url(assetPath);
    },
  },
  api: {
    url(apiPath: string) {
      return getSingleton().api.url(apiPath);
    },
    fetch(apiPath: string, init?: RequestInit) {
      return getSingleton().api.fetch(apiPath, init);
    },
  },
  ui: {
    resize(size: LucPluginSize) {
      return getSingleton().ui.resize(size);
    },
  },
  theme: {
    getSnapshot() {
      return getSingleton().theme.getSnapshot();
    },
    subscribe(callback: (theme: LucPluginThemeSnapshot) => void) {
      return getSingleton().theme.subscribe(callback);
    },
  },
  host: {
    request<T = unknown>(
      type: string,
      payload?: unknown,
      options?: LucPluginRequestOptions,
    ) {
      return getSingleton().host.request<T>(type, payload, options);
    },
  },
  toast: {
    show(input: LucToastShowInput, options?: LucPluginRequestOptions) {
      return getSingleton().toast.show(input, options);
    },
  },
  external: {
    open(input: LucExternalOpenInput, options?: LucPluginRequestOptions) {
      return getSingleton().external.open(input, options);
    },
  },
  clipboard: {
    writeText(input: LucClipboardWriteTextInput, options?: LucPluginRequestOptions) {
      return getSingleton().clipboard.writeText(input, options);
    },
  },
  resources: {
    open(input: PluginResourceOpenInput, options?: LucPluginRequestOptions) {
      return getSingleton().resources.open(input, options);
    },
    pick(input?: PluginResourcePickInput, options?: LucPluginRequestOptions) {
      return getSingleton().resources.pick(input, options);
    },
    requestAccess(input: PluginResourceRequestAccessInput, options?: LucPluginRequestOptions) {
      return getSingleton().resources.requestAccess(input, options);
    },
  },
};
