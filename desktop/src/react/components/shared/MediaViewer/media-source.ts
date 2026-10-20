import type { FileRef } from '../../../types/file-ref';
import { useStore } from '../../../stores';
import { resolveServerConnection } from '../../../services/server-connection';
import { resolveFileRefUrl } from '../../../services/resource-url';

export interface MediaSource {
  url: string;
  cleanup?: () => void;
}

/**
 * FileRef → 可供 <img> / <video> 直接消费的 URL。
 *
 * 设计原则：
 *   - 本地桌面连接优先走 platform.getFileUrl（preload 层统一编码 + UNC / Windows 盘符兜底）。
 *   - 远程连接优先走 Resource content URL，避免把 server 本机路径暴露给 client。
 *   - 只有无 path 且无 resource content link 的 inline 数据才走 data URL。
 */
export async function loadMediaSource(ref: FileRef): Promise<MediaSource> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.platform 的运行时存在性要在这里显式校验
  const platform = (window as any).platform;

  if (ref.kind !== 'image' && ref.kind !== 'svg' && ref.kind !== 'video') {
    throw new Error(`unsupported media kind: ${ref.kind}`);
  }

  const connection = resolveServerConnection(useStore.getState());
  const source = resolveFileRefUrl(ref, { connection, platform });
  return { url: source.url };
}
