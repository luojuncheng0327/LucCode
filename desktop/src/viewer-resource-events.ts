type ViewerResourcePlatform = {
  getServerPort?: () => Promise<string | number | null | undefined>;
  getServerToken?: () => Promise<string | null | undefined>;
};

type ViewerResourceWatchOptions = {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  onChanged: (event: unknown) => void;
};

type ViewerResourceWatch = {
  ready: Promise<void>;
  release: () => void;
};

type LocalConnection = {
  baseUrl: string;
  wsUrl: string;
  token: string | null;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function appendQueryParam(url: string, key: string, value: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function authHeaders(token: string | null, headers: Record<string, string> = {}): Record<string, string> {
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

function normalizePort(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid local server port: ${text}`);
  }
  return text;
}

function normalizeToken(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

async function localConnectionFromPlatform(platform: ViewerResourcePlatform): Promise<LocalConnection> {
  const port = normalizePort(await platform.getServerPort?.());
  if (!port) throw new Error('viewer ResourceIO watch requires a local server port');
  const token = normalizeToken(await platform.getServerToken?.());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    token,
  };
}

function normalizeLocalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const slashed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
}

function localPathCandidates(event: any): string[] {
  const values = [
    event?.filePath,
    event?.resource?.filePath,
    event?.resource?.path,
  ];
  if (typeof event?.resourceKey === 'string' && event.resourceKey.startsWith('local_fs:')) {
    values.push(event.resourceKey.slice('local_fs:'.length));
  }
  return values
    .map(normalizeLocalPath)
    .filter((value): value is string => Boolean(value));
}

export function resourceEventMatchesViewerFile(event: unknown, filePath: string): boolean {
  const value = event as any;
  if (value?.type !== 'resource.changed') return false;
  const target = normalizeLocalPath(filePath);
  if (!target) return false;
  return localPathCandidates(value).includes(target);
}

export function retainViewerLocalFileResourceWatch(
  filePath: string,
  platform: ViewerResourcePlatform,
  {
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    onChanged,
  }: ViewerResourceWatchOptions,
): ViewerResourceWatch {
  let disposed = false;
  let released = false;
  let subscriptionId: string | null = null;
  let connection: LocalConnection | null = null;
  let socket: WebSocket | null = null;

  const releaseSubscription = () => {
    if (released || !subscriptionId || !connection) return;
    released = true;
    void fetchImpl(`${trimTrailingSlash(connection.baseUrl)}/api/resource-io/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      headers: authHeaders(connection.token),
    }).catch((err) => {
      console.warn('[viewer-resource] release failed:', err);
    });
  };

  const ready = (async () => {
    connection = await localConnectionFromPlatform(platform);
    const response = await fetchImpl(`${trimTrailingSlash(connection.baseUrl)}/api/resource-io/subscribe`, {
      method: 'POST',
      headers: authHeaders(connection.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        purpose: 'viewer',
        resources: [{ kind: 'local-file', path: filePath }],
      }),
    });
    const data = await response.json();
    if (!response.ok || typeof data?.subscriptionId !== 'string') {
      throw new Error(data?.error || `viewer ResourceIO watch failed: ${response.status}`);
    }
    subscriptionId = data.subscriptionId;
    if (disposed) {
      releaseSubscription();
      return;
    }

    const socketUrl = connection.token
      ? appendQueryParam(`${trimTrailingSlash(connection.wsUrl)}/ws`, 'token', connection.token)
      : `${trimTrailingSlash(connection.wsUrl)}/ws`;
    socket = new WebSocketImpl(socketUrl);
    socket.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(String(event.data));
        if (resourceEventMatchesViewerFile(message, filePath)) onChanged(message);
      } catch (err) {
        console.warn('[viewer-resource] event parse failed:', err);
      }
    };
  })();

  return {
    ready,
    release: () => {
      disposed = true;
      try { socket?.close(); } catch { /* noop */ }
      releaseSubscription();
    },
  };
}
