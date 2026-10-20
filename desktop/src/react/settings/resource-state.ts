export type RemoteResourceStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'error';

export interface RemoteResource<T> {
  key: string | null;
  status: RemoteResourceStatus;
  data: T | null;
  error: string | null;
  requestId: number;
  updatedAt: number | null;
}

export const LOCAL_RESOURCE_OWNER = 'local';

export function makeSettingsResourceKey(
  scope: string,
  ownerId: string | null | undefined,
  connectionId: string | null | undefined,
): string | null {
  if (!ownerId) return null;
  return `${connectionId || LOCAL_RESOURCE_OWNER}:${scope}:${ownerId}`;
}

export function createRemoteResource<T>(): RemoteResource<T> {
  return {
    key: null,
    status: 'idle',
    data: null,
    error: null,
    requestId: 0,
    updatedAt: null,
  };
}

export function startRemoteLoad<T>(
  resource: RemoteResource<T>,
  key: string | null,
  requestId: number,
  options: { retainSameKeyData?: boolean } = {},
): RemoteResource<T> {
  const retainData = options.retainSameKeyData && resource.key === key;
  return {
    key,
    status: 'loading',
    data: retainData ? resource.data : null,
    error: null,
    requestId,
    updatedAt: retainData ? resource.updatedAt : null,
  };
}

export function finishRemoteLoad<T>(
  resource: RemoteResource<T>,
  key: string | null,
  requestId: number,
  data: T,
): RemoteResource<T> {
  if (resource.key !== key || resource.requestId !== requestId) return resource;
  return {
    key,
    status: 'ready',
    data,
    error: null,
    requestId,
    updatedAt: Date.now(),
  };
}

export function failRemoteLoad<T>(
  resource: RemoteResource<T>,
  key: string | null,
  requestId: number,
  error: unknown,
): RemoteResource<T> {
  if (resource.key !== key || resource.requestId !== requestId) return resource;
  return {
    ...resource,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

export function readReadyResource<T>(
  resource: RemoteResource<T>,
  key: string | null,
): T | undefined {
  if (!key || resource.key !== key) return undefined;
  if (resource.status !== 'ready' && resource.status !== 'saving' && resource.status !== 'loading') return undefined;
  return resource.data ?? undefined;
}

export function readConfigBoolean<T extends Record<string, any>>(
  config: T | null | undefined,
  read: (config: T) => unknown,
  defaultWhenReady: boolean,
): boolean | undefined {
  if (!config) return undefined;
  const value = read(config);
  return typeof value === 'boolean' ? value : defaultWhenReady;
}
