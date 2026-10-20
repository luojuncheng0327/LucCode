/**
 * GuestHandler — Guest 留言机处理
 *
 * 所有非主人的消息都经过这里。
 * A: 消息前缀标注发送者身份
 * B: system prompt 注入对话上下文（不暴露任何主人隐私）
 */

import { getLocale } from "../lib/i18n.ts";

export class GuestHandler {
  declare _hub: any;

  /**
   * @param {object} opts
   * @param {import('./index.ts').Hub} opts.hub
   */
  constructor({ hub }) {
    this._hub = hub;
  }

  /**
   * 处理 guest 消息
   * @param {string} text
   * @param {string} sessionKey
   * @param {object} [meta]  { name, avatarUrl, userId }
   * @param {object} [opts]  { isGroup }
   * @returns {Promise<{text: string|null, toolMedia: any[], error: string|null, truncated: boolean}|null>}
   *   透传 executeExternalMessage 的结构化结果（null 仅在用户中止时）
   */
  async handle(text, sessionKey, meta, opts: any = {}) {
    const isZh = getLocale().startsWith("zh");
    const senderName = meta?.name || (isZh ? "访客" : "Guest");
    const isGroup = opts.isGroup || false;

    // A: 消息前缀
    const prefixed = isZh
      ? `[来自 ${senderName}] ${text}`
      : `[From ${senderName}] ${text}`;

    // B: 上下文标签（注入到 system prompt 末尾）
    const contextTag = isGroup
      ? (isZh ? "当前对话来自群聊。" : "This conversation is from a group chat.")
      : (isZh ? "当前对话来自外部访客。" : "This conversation is from an external guest.");

    return this._hub.engine.executeExternalMessage(prefixed, sessionKey, meta, {
      guest: true,
      agentId: opts.agentId,
      contextTag,
      onDelta: opts.onDelta,
      images: opts.images,
      imageAttachmentPaths: opts.imageAttachmentPaths,
      videos: opts.videos,
      videoAttachmentPaths: opts.videoAttachmentPaths,
      audios: opts.audios,
      audioAttachmentPaths: opts.audioAttachmentPaths,
      inboundFiles: opts.inboundFiles,
      displayMessage: opts.displayMessage,
    });
  }
}
