import { memo } from 'react';
import { AttachmentChip } from '../shared/AttachmentChip';
import { AudioAttachmentChip } from '../shared/AudioAttachmentChip';
import { FolderIcon } from '../shared/FolderIcon';
import { kindOfFileName } from '../../utils/file-kind';
import styles from './InputArea.module.css';

export const AttachedFilesBar = memo(function AttachedFilesBar({ files, onRemove }: {
  files: Array<{ path: string; name: string; isDirectory?: boolean; base64Data?: string; mimeType?: string }>;
  onRemove: (index: number) => void;
}) {
  return (
    <div className={styles['attached-files']}>
      {files.map((f, i) => {
        const kind = f.isDirectory ? 'directory' : kindOfFileName(f.name || f.path, f.mimeType);
        if (kind === 'audio') {
          return (
            <AudioAttachmentChip
              key={f.path}
              file={f}
              onRemove={() => onRemove(i)}
            />
          );
        }
        if (kind === 'image' || kind === 'svg') {
          return (
            <ImageAttachmentChip
              key={f.path}
              file={f}
              onRemove={() => onRemove(i)}
            />
          );
        }
        return (
          <AttachmentChip
            key={f.path}
            icon={f.isDirectory ? <FolderIcon /> : <ClipIcon />}
            name={f.name}
            onRemove={() => onRemove(i)}
          />
        );
      })}
    </div>
  );
});

function ImageAttachmentChip({
  file,
  onRemove,
}: {
  file: { path: string; name: string; base64Data?: string; mimeType?: string };
  onRemove: () => void;
}) {
  const src = getMediaUrl(file);
  return (
    <span className={styles['media-attachment-chip']} title={file.name}>
      <span className={styles['image-attachment-preview']} aria-hidden="true">
        {src ? (
          <img src={src} alt="" />
        ) : (
          <ClipIcon />
        )}
      </span>
      <span className={styles['media-attachment-name']}>{file.name}</span>
      <RemoveButton name={file.name} onRemove={onRemove} />
    </span>
  );
}

function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      className={styles['media-attachment-remove']}
      onClick={onRemove}
      aria-label={`Remove ${name}`}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

function getMediaUrl(file: { path: string; base64Data?: string; mimeType?: string }) {
  if (file.base64Data && file.mimeType) {
    return `data:${file.mimeType};base64,${file.base64Data}`;
  }
  if (typeof window === 'undefined') return null;
  return window.platform?.getFileUrl?.(file.path) || null;
}

function ClipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
