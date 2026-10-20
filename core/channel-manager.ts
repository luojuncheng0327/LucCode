/**
 * ChannelManager — 频道管理
 *
 * 从 Engine 提取，负责频道 CRUD、成员管理、新 agent 频道初始化。
 * 不持有 engine 引用，通过构造器注入依赖。
 *
 * Channel ID 化：文件名为 ch_{id}.md，frontmatter 含 id/name/description/members。
 */
import fs from "fs";
import path from "path";
import { createModuleLogger } from "../lib/debug-log.ts";
import { t } from "../lib/i18n.ts";
import {
  addBookmarkEntry,
  createChannel,
  getChannelMembers,
  removeChannelMember,
  removeBookmarkEntry,
  deleteChannel,
} from "../lib/channels/channel-store.ts";

const log = createModuleLogger("channel");

export class ChannelManager {
  declare _channelsDir: string;
  declare _agentsDir: string;
  declare _userDir: string;
  declare _getHub: () => any;

  /**
   * @param {object} deps
   * @param {string} deps.channelsDir - 频道目录
   * @param {string} deps.agentsDir  - agents 根目录
   * @param {string} deps.userDir    - 用户数据目录
   * @param {() => object|null} deps.getHub - 返回 Hub（可能为 null）
   */
  constructor(deps: any) {
    this._channelsDir = deps.channelsDir;
    this._agentsDir = deps.agentsDir;
    this._userDir = deps.userDir;
    this._getHub = deps.getHub;
  }

  async createChannelEntry({ name, description, members, intro, addUserBookmark = true }: any = {}) {
    const normalizedMembers = Array.isArray(members) ? members : [];
    fs.mkdirSync(this._channelsDir, { recursive: true });
    for (const memberId of normalizedMembers) {
      if (!this._safeAgentDir(memberId)) {
        throw new Error(`Agent not found: ${memberId}`);
      }
    }

    const created = await createChannel(this._channelsDir, {
      name,
      description,
      members: normalizedMembers,
      intro,
    } as any);

    for (const memberId of normalizedMembers) {
      const memberDir = this._safeAgentDir(memberId);
      if (!memberDir) continue;
      await addBookmarkEntry(path.join(memberDir, "channels.md"), created.id);
    }

    if (addUserBookmark) {
      await addBookmarkEntry(path.join(this._userDir, "channel-bookmarks.md"), created.id);
    }

    this._emitChannelCreated({
      id: created.id,
      name,
      description,
      members: normalizedMembers,
    });
    return created;
  }

  /**
   * 从所有频道中清理被删除的 agent
   * - 从每个频道的 members 中移除
   * - 移除后只剩 ≤1 人的频道直接删除
   * - 清理相关 bookmark
   */
  async cleanupAgentFromChannels(agentId: any) {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return;

    const channelFiles = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    const deletedChannels = [];

    for (const f of channelFiles) {
      const filePath = path.join(this._channelsDir, f);
      const channelId = f.replace(".md", "");
      const members = getChannelMembers(filePath);

      if (!members.includes(agentId)) continue;

      try {
        await removeChannelMember(filePath, agentId);
        this._abortChannelPhoneSessions(channelId, agentId, "channel-member-removed");
        const remaining = getChannelMembers(filePath);
        if (remaining.length <= 1) {
          await deleteChannel(filePath);
          this._abortChannelPhoneSessions(channelId, null, "channel-deleted");
          deletedChannels.push(channelId);
          log.log(`频道 "${channelId}" 成员不足，已删除`);
        }
      } catch (err: any) {
        log.error(`清理频道 "${channelId}" 失败: ${err.message}`);
      }
    }

    if (deletedChannels.length > 0) {
      await this._cleanupBookmarks(deletedChannels, agentId);
    }
  }

  /**
   * 删除频道及其所有关联数据
   */
  async deleteChannelByName(channelId: any) {
    const filePath = path.join(this._channelsDir, `${channelId}.md`);
    if (!fs.existsSync(filePath)) {
      throw new Error(t("error.channelNotFoundById", { id: channelId }));
    }

    await deleteChannel(filePath);
    this._abortChannelPhoneSessions(channelId, null, "channel-deleted");

    // 清理所有 agent 的 bookmark
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      await removeBookmarkEntry(channelsMd, channelId);
    }

    // 清理用户 bookmark
    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    await removeBookmarkEntry(userBookmarkPath, channelId);

    log.log(`已删除频道: ${channelId}`);
  }

  /**
   * 触发频道立即手机送达（群聊新消息后调用）
   */
  async triggerChannelDelivery(channelName: any, opts: any) {
    return this._getHub()?.triggerChannelDelivery(channelName, opts);
  }

  async triggerChannelTriage(channelName: any, opts: any) {
    return this.triggerChannelDelivery(channelName, opts);
  }

  _safeAgentDir(agentId: any) {
    if (!agentId || /[/\\]|\.\./.test(agentId)) return null;
    const dirPath = path.resolve(this._agentsDir, agentId);
    const base = path.resolve(this._agentsDir);
    if (!dirPath.startsWith(base + path.sep) && dirPath !== base) return null;
    return fs.existsSync(dirPath) ? dirPath : null;
  }

  _emitChannelCreated(channel: any) {
    const eventBus = this._getHub?.()?.eventBus;
    if (typeof eventBus?.emit !== "function") return;
    eventBus.emit({
      type: "channel_created",
      channelName: channel.id,
      channel,
    }, null);
  }

  _abortChannelPhoneSessions(channelId: any, agentId: any, reason: any) {
    const hub = this._getHub?.();
    if (typeof hub?.abortAgentPhoneSessions !== "function") return;
    hub.abortAgentPhoneSessions(reason, {
      ...(agentId ? { agentId } : {}),
      conversationId: channelId,
      conversationType: "channel",
    });
  }

  /**
   * 为新 agent 写入频道游标投影。
   *
   * 只做一件事：扫描所有频道，把"已把该 agent 列为成员的频道"写进它的
   * channels.md（last-read cursor）。不自动建群、不自动拉人——建群由用户
   * 通过 POST /channels 或 channel 工具显式发起。
   */
  async setupChannelsForNewAgent(agentId: any) {
    const channelsMdPath = path.join(this._agentsDir, agentId, "channels.md");

    // 扫描所有频道，加入包含该 agent 的（写 last-read cursor 投影）
    const memberChannels = [];
    try {
      const files = fs.readdirSync(this._channelsDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const channelId = f.replace(".md", "");
        const members = getChannelMembers(path.join(this._channelsDir, f));
        if (members.includes(agentId)) {
          memberChannels.push(channelId);
        }
      }
    } catch {
      // Missing channels directory is fine during first-run initialization.
    }

    for (const ch of memberChannels) {
      await addBookmarkEntry(channelsMdPath, ch);
    }
  }

  /**
   * 修复 agent 的频道游标投影。
   *
   * 频道文件 frontmatter 的 members 是成员真相源；agent 的 channels.md 只保存
   * last-read cursor。老数据或异常中断导致 cursor 缺失时，在启动阶段补齐为
   * never，不改频道文件，也不删除旧 cursor，避免改变用户可见历史。
   */
  async repairChannelCursorProjection() {
    if (!this._channelsDir || !fs.existsSync(this._channelsDir)) return { added: 0 };

    let added = 0;
    const files = fs.readdirSync(this._channelsDir).filter(f => f.endsWith(".md"));
    for (const f of files) {
      const channelId = f.replace(/\.md$/, "");
      const channelFile = path.join(this._channelsDir, f);
      const members = getChannelMembers(channelFile);
      for (const agentId of members) {
        const agentDir = path.join(this._agentsDir, agentId);
        const configPath = path.join(agentDir, "config.yaml");
        if (!fs.existsSync(configPath)) continue;

        const channelsMdPath = path.join(agentDir, "channels.md");
        const before = fs.existsSync(channelsMdPath)
          ? fs.readFileSync(channelsMdPath, "utf-8")
          : "";
        await addBookmarkEntry(channelsMdPath, channelId);
        const after = fs.existsSync(channelsMdPath)
          ? fs.readFileSync(channelsMdPath, "utf-8")
          : "";
        if (before !== after) added++;
      }
    }
    if (added > 0) {
      log.log(`已修复 ${added} 个频道游标投影`);
    }
    return { added };
  }

  /** 清理被删频道的 bookmark（从其他 agent 和用户的 bookmark 中移除） */
  async _cleanupBookmarks(deletedChannels: any, excludeAgentId: any) {
    const agentDirs = fs.readdirSync(this._agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== excludeAgentId);

    for (const d of agentDirs) {
      const channelsMd = path.join(this._agentsDir, d.name, "channels.md");
      for (const ch of deletedChannels) {
        try {
          await removeBookmarkEntry(channelsMd, ch);
        } catch (err: any) {
          log.error(`清理 ${d.name} bookmark "${ch}" 失败: ${err.message}`);
        }
      }
    }

    const userBookmarkPath = path.join(this._userDir, "channel-bookmarks.md");
    for (const ch of deletedChannels) {
      try {
        await removeBookmarkEntry(userBookmarkPath, ch);
      } catch (err: any) {
        log.error(`清理用户 bookmark "${ch}" 失败: ${err.message}`);
      }
    }
  }
}
