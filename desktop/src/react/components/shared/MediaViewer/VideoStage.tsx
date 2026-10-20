import { useEffect, useState } from 'react';
import type { FileRef } from '../../../types/file-ref';
import { loadMediaSource } from './media-source';
import { fileRefVersionToken } from '../../../services/resource-url';
import styles from './MediaViewer.module.css';

// prop 名 `file`（不可用 `ref`，React 会截获）
interface Props {
  file: FileRef;
  viewport: { width: number; height: number };
  onReady?: () => void;
  onError?: (e: unknown) => void;
}

export function VideoStage({ file, viewport, onReady, onError }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const fileVersionToken = fileRefVersionToken(file);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    loadMediaSource(file)
      .then((s) => { if (!cancelled) setSrc(s.url); })
      .catch((err) => { if (!cancelled) onError?.(err); });
    return () => { cancelled = true; };
    // 依赖稳定 id + version；file 是引用类型每次新建，onError 仅在错误时被调用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, fileVersionToken]);

  return (
    <div className={styles.videoWrap} style={{ maxWidth: viewport.width, maxHeight: viewport.height }}>
      {!src && <div className={styles.spinner} data-testid="video-stage-spinner" />}
      {src && (
        <video
          src={src}
          controls
          autoPlay={false}
          onLoadedData={onReady}
          className={styles.videoEl}
          data-testid="video-stage-video"
        />
      )}
    </div>
  );
}
