import { useEffect, useRef, useState } from 'react';
import { lucFetch } from './use-luc-fetch';

interface ConfigCacheEntry {
  data: any;
  time: number;
}

const configCache = new Map<string, ConfigCacheEntry>();
const STALE_MS = 5000; // 5s stale window
const DEFAULT_CACHE_KEY = 'default';

interface FetchConfigOptions {
  cacheKey?: string | null;
  force?: boolean;
}

function normalizeCacheKey(cacheKey?: string | null): string {
  return cacheKey || DEFAULT_CACHE_KEY;
}

/** Invalidate cache (call after PUT /api/config or on WS config_changed) */
export function invalidateConfigCache(cacheKey?: string | null) {
  if (cacheKey) {
    configCache.delete(normalizeCacheKey(cacheKey));
    return;
  }
  configCache.clear();
}

/** Fetch config with in-memory cache */
export async function fetchConfig(options: FetchConfigOptions = {}): Promise<any> {
  const key = normalizeCacheKey(options.cacheKey);
  const cached = configCache.get(key);
  if (!options.force && cached && Date.now() - cached.time < STALE_MS) return cached.data;
  const res = await lucFetch('/api/config');
  const data = await res.json();
  configCache.set(key, { data, time: Date.now() });
  return data;
}

/**
 * React hook: returns config and a refresh function.
 * Auto-fetches on mount. Use `refresh()` after mutations.
 */
export function useConfig(options: FetchConfigOptions = {}) {
  const key = normalizeCacheKey(options.cacheKey);
  const [config, setConfig] = useState<any>(configCache.get(key)?.data ?? null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    fetchConfig({ cacheKey: key, force: options.force }).then(d => { if (mounted.current) setConfig(d); }).catch(() => {});
    return () => { mounted.current = false; };
  }, [key, options.force]);

  const refresh = async () => {
    invalidateConfigCache(key);
    const d = await fetchConfig({ cacheKey: key, force: true });
    if (mounted.current) setConfig(d);
    return d;
  };

  return { config, refresh };
}
