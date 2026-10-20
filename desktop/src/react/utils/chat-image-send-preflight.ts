import { isImageFile, isVideoFile } from './format';
import { isAudioFileName } from './file-kind';
import { modelSupportsDirectAudioInput } from '../../../../shared/model-capabilities.ts';

export interface ChatImageAttachment {
  path: string;
  name: string;
  isDirectory?: boolean;
  mimeType?: string;
}

export interface ChatImageModel {
  id?: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
  base_url?: string;
  input?: readonly string[];
  video?: boolean;
  videoTransport?: string | null;
  videoTransportSupported?: boolean;
  audio?: boolean;
  audioTransport?: string | null;
  audioTransportSupported?: boolean;
  compat?: {
    lucVideoInput?: boolean;
    lucAudioInput?: boolean;
    audioTransport?: string;
    lucAudioTransport?: string;
  } | null;
}

export interface VisionAuxiliaryConfig {
  enabled: boolean;
  model: unknown;
}

export type ModelImageInputMode = 'native-image' | 'text-only' | 'unknown';
export type ModelVideoInputMode = 'native-video' | 'no-native-video' | 'unknown';
export type ModelAudioInputMode = 'native-audio' | 'no-native-audio' | 'unknown';

export type ChatImageSendPreflightResult =
  | {
    ok: true;
    reason: 'no-images' | 'native-image' | 'unknown-model-capability' | 'auxiliary-vision';
    imageInputMode: ModelImageInputMode;
  }
  | {
    ok: false;
    reason: 'text-model-image-without-auxiliary';
    imageInputMode: 'text-only';
  };

export type ChatImageBlockedToast = (
  text: string,
  type: 'warning',
  duration: number,
  opts: {
    dedupeKey: string;
    action: {
      label: string;
      onClick: () => void;
    };
  },
) => void;

export type ChatVideoSendPreflightResult =
  | {
    ok: true;
    reason: 'no-videos' | 'native-video';
    videoInputMode: ModelVideoInputMode;
  }
  | {
    ok: false;
    reason: 'model-video-unsupported';
    videoInputMode: 'no-native-video' | 'unknown';
  };

export type ChatAudioSendPreflightResult =
  | {
    ok: true;
    reason: 'no-audios' | 'native-audio';
    audioInputMode: ModelAudioInputMode;
  }
  | {
    ok: false;
    reason: 'model-audio-unsupported';
    audioInputMode: 'no-native-audio' | 'unknown';
  };

export function hasChatImageAttachments(attachments: readonly ChatImageAttachment[]): boolean {
  return attachments.some((file) => !file.isDirectory && isImageFile(file.name));
}

export function hasChatVideoAttachments(attachments: readonly ChatImageAttachment[]): boolean {
  return attachments.some((file) => !file.isDirectory && isVideoFile(file.name));
}

export function hasChatAudioAttachments(attachments: readonly ChatImageAttachment[]): boolean {
  return attachments.some((file) => !file.isDirectory && isAudioFileName(file.name, file.mimeType));
}

export function getModelImageInputMode(model: ChatImageModel | null | undefined): ModelImageInputMode {
  const input = model?.input;
  if (!Array.isArray(input)) return 'unknown';
  return input.includes('image') ? 'native-image' : 'text-only';
}

export function getModelVideoInputMode(model: ChatImageModel | null | undefined): ModelVideoInputMode {
  const explicitVideo = model?.video === true || model?.compat?.lucVideoInput === true;
  const transport = model?.videoTransport;
  if (explicitVideo) {
    if (model.videoTransportSupported === false || transport === 'unsupported' || transport === 'none') {
      return 'no-native-video';
    }
    if (model.videoTransportSupported === true || transport === 'gemini-inline-data' || transport === 'openai-video-url') {
      return 'native-video';
    }
    return 'native-video';
  }
  const input = model?.input;
  if (!Array.isArray(input)) return 'unknown';
  return input.includes('video') ? 'native-video' : 'no-native-video';
}

export function getModelAudioInputMode(model: ChatImageModel | null | undefined): ModelAudioInputMode {
  if (!model) return 'unknown';
  const explicitAudio = model.audio === true || model.compat?.lucAudioInput === true;
  const transport = model.audioTransport || model.compat?.audioTransport || model.compat?.lucAudioTransport;
  if (explicitAudio) {
    if (model.audioTransportSupported === false || transport === 'unsupported' || transport === 'none') {
      return 'no-native-audio';
    }
    if (model.audioTransportSupported === true || transport === 'mimo-input-audio' || transport === 'openai-input-audio') {
      return 'native-audio';
    }
    return modelSupportsDirectAudioInput(model) ? 'native-audio' : 'no-native-audio';
  }
  return modelSupportsDirectAudioInput(model) ? 'native-audio' : 'no-native-audio';
}

function canUseVisionAuxiliary(config: VisionAuxiliaryConfig | null | undefined): boolean {
  return config?.enabled === true && !!config.model;
}

export async function evaluateChatImageSendPreflight({
  attachments,
  model,
  loadVisionAuxiliaryConfig,
}: {
  attachments: readonly ChatImageAttachment[];
  model: ChatImageModel | null | undefined;
  loadVisionAuxiliaryConfig: () => Promise<VisionAuxiliaryConfig>;
}): Promise<ChatImageSendPreflightResult> {
  const imageInputMode = getModelImageInputMode(model);
  if (!hasChatImageAttachments(attachments)) {
    return { ok: true, reason: 'no-images', imageInputMode };
  }
  if (imageInputMode === 'native-image') {
    return { ok: true, reason: 'native-image', imageInputMode };
  }
  if (imageInputMode === 'unknown') {
    return { ok: true, reason: 'unknown-model-capability', imageInputMode };
  }

  let auxiliaryConfig: VisionAuxiliaryConfig | null = null;
  try {
    auxiliaryConfig = await loadVisionAuxiliaryConfig();
  } catch {
    auxiliaryConfig = null;
  }
  if (canUseVisionAuxiliary(auxiliaryConfig)) {
    return { ok: true, reason: 'auxiliary-vision', imageInputMode };
  }
  return {
    ok: false,
    reason: 'text-model-image-without-auxiliary',
    imageInputMode,
  };
}

export async function evaluateChatVideoSendPreflight({
  attachments,
  model,
}: {
  attachments: readonly ChatImageAttachment[];
  model: ChatImageModel | null | undefined;
}): Promise<ChatVideoSendPreflightResult> {
  const videoInputMode = getModelVideoInputMode(model);
  if (!hasChatVideoAttachments(attachments)) {
    return { ok: true, reason: 'no-videos', videoInputMode };
  }
  if (videoInputMode === 'native-video') {
    return { ok: true, reason: 'native-video', videoInputMode };
  }
  return {
    ok: false,
    reason: 'model-video-unsupported',
    videoInputMode,
  };
}

export async function evaluateChatAudioSendPreflight({
  attachments,
  model,
}: {
  attachments: readonly ChatImageAttachment[];
  model: ChatImageModel | null | undefined;
}): Promise<ChatAudioSendPreflightResult> {
  const audioInputMode = getModelAudioInputMode(model);
  if (!hasChatAudioAttachments(attachments)) {
    return { ok: true, reason: 'no-audios', audioInputMode };
  }
  if (audioInputMode === 'native-audio') {
    return { ok: true, reason: 'native-audio', audioInputMode };
  }
  return {
    ok: false,
    reason: 'model-audio-unsupported',
    audioInputMode,
  };
}

/**
 * #1647：视觉能力不可用时不再拦下整条消息，而是显式告知
 * 「图片已按文件发送，模型看不到内容」。文件身份（SessionFile + 路径）始终随消息发出。
 */
export function notifyTextModelImageFileOnly({
  t,
  addToast,
  openSettings,
}: {
  t: (key: string) => string;
  addToast: ChatImageBlockedToast;
  openSettings: () => void;
}): void {
  addToast(
    t('input.textModelImageFileOnly'),
    'warning',
    9000,
    {
      dedupeKey: 'text-model-image-file-only',
      action: {
        label: t('input.openModelSettings'),
        onClick: openSettings,
      },
    },
  );
}

export function notifyTextModelVideoFileOnly({
  t,
  addToast,
  openSettings,
}: {
  t: (key: string) => string;
  addToast: ChatImageBlockedToast;
  openSettings: () => void;
}): void {
  addToast(
    t('input.textModelVideoFileOnly'),
    'warning',
    9000,
    {
      dedupeKey: 'text-model-video-file-only',
      action: {
        label: t('input.openModelSettings'),
        onClick: openSettings,
      },
    },
  );
}

export function notifyTextModelAudioBlocked({
  t,
  addToast,
  openSettings,
}: {
  t: (key: string) => string;
  addToast: ChatImageBlockedToast;
  openSettings: () => void;
}): void {
  addToast(
    t('input.textModelAudioBlocked'),
    'warning',
    9000,
    {
      dedupeKey: 'text-model-audio-blocked',
      action: {
        label: t('input.openModelSettings'),
        onClick: openSettings,
      },
    },
  );
}
