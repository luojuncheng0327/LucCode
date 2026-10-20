import type { FileVersion } from '../types';

export type FileKind =
  | 'image'
  | 'svg'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'code'
  | 'markdown'
  | 'other';

export type FileSource =
  | 'desk'
  | 'session-attachment'
  | 'session-registry'
  | 'session-block-file'
  | 'session-block-legacy-artifact'
  | 'session-block-screenshot';

export interface FileRef {
  id: string;
  fileId?: string;
  /**
   * fork 出来的 session 会继承父 session 的文件 id / 路径作为别名：历史消息里的
   * marker 仍然写着旧 id 和旧路径，账本里的当前条目已经换成新的。查找与去重都要
   * 认这些别名，否则同一个文件会既命中不到、又按新旧身份各出现一次。
   */
  legacyFileIds?: string[];
  legacyFilePaths?: string[];
  kind: FileKind;
  source: FileSource;
  name: string;
  /** 当 source === 'session-block-screenshot' 时为 '' */
  path: string;
  ext?: string;
  mime?: string;
  status?: 'available' | 'expired' | string;
  missingAt?: number | null;
  origin?: string;
  operations?: string[];
  presentation?: 'attachment' | 'voice-input' | string;
  listed?: boolean;
  createdAt?: number;
  timestamp?: number;
  version?: FileVersion | null;
  sessionMessageId?: string;
  sessionBlockIdx?: number;
  inlineData?: { base64: string; mimeType: string };
  resource?: {
    resourceId: string;
    studioId: string;
    links: {
      self: string;
      content?: string;
    };
  };
}
