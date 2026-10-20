/**
 * notify-tool.js — 用户通知工具
 *
 * 让 agent 能主动向用户发送提醒，由通知投递层决定桌面 / Bridge 等通道。
 * 仅在用户明确要求提醒/通知时使用，普通任务完成不调用。
 */

import { Type, StringEnum } from "../pi-sdk/index.ts";
import { t } from "../i18n.ts";

const NOTIFY_CHANNELS = new Set(["auto", "desktop", "bridge_owner"]);
const NOTIFY_BRIDGE_PLATFORMS = new Set(["wechat", "feishu", "dingtalk", "telegram", "qq"]);
const NOTIFY_CONTEXT_POLICIES = new Set(["none", "record_when_delivered"]);

function stableUniqueStrings(value: unknown, allowed: Set<string>) {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) return null;
    strings.push(item);
  }
  return [...new Set(strings)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function stableRouteId(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

/**
 * @param {{ onNotify: (payload: object) => Promise<object|void> | object | void }} opts
 */
export function createNotifyTool({ onNotify }) {
  return {
    name: "notify",
    label: "Notification",
    description: "Send a notification to the user via desktop popup, Bridge owner chat, or the default channel; pass bridgePlatforms when delivery must target one or more explicit Bridge platforms such as WeChat, Feishu, DingTalk, Telegram, or QQ. Call it when the user asked to be reminded or notified, or when a scheduled or monitoring task finds something that needs their attention; if everything is normal, do not call it. Successful Bridge notifications can be appended to that conversation context according to contextPolicy.",
    sessionPermission: {
      resolveInvocation: (params: any = {}) => {
        if (typeof params.title !== "string" || typeof params.body !== "string") return null;
        const audience = params.audience === undefined ? "owner" : params.audience;
        if (audience !== "owner") return null;
        const hasExplicitChannels = params.channels !== undefined;
        const declaredChannels = hasExplicitChannels
          ? stableUniqueStrings(params.channels, NOTIFY_CHANNELS)
          : [];
        const channels = declaredChannels?.includes("auto")
          ? [...new Set([...declaredChannels.filter((channel) => channel !== "auto"), "desktop"])]
              .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
          : declaredChannels;
        const bridgePlatforms = params.bridgePlatforms === undefined
          ? []
          : stableUniqueStrings(params.bridgePlatforms, NOTIFY_BRIDGE_PLATFORMS);
        const contextPolicy = params.contextPolicy === undefined ? "record_when_delivered" : params.contextPolicy;
        if (!channels || !bridgePlatforms) return null;
        if (!NOTIFY_CONTEXT_POLICIES.has(contextPolicy)) return null;
        return {
          action: "send",
          kind: "review",
          capability: "notify.send",
          target: {
            type: "notification_route",
            id: stableRouteId({
              audience,
              channels: hasExplicitChannels ? channels : "context_default",
              bridgePlatforms,
              contextPolicy,
            }),
            label: hasExplicitChannels ? (channels.join(", ") || "none") : "context default",
          },
        };
      },
    },
    parameters: Type.Object({
      title: Type.String({ description: "Notification title (brief)" }),
      body: Type.String({ description: "Notification content" }),
      audience: Type.Optional(StringEnum(["owner"], {
        description: "Notification audience. Use owner for the human user.",
      })),
      channels: Type.Optional(Type.Array(StringEnum(["auto", "desktop", "bridge_owner"], {
        description: "Delivery channels. Use desktop for local popup, bridge_owner for the owner's Bridge chat, or auto for default routing.",
      }), {
        description: "Preferred delivery channels. Do not include a channel unless the user asked for it or the task prompt implies it.",
      })),
      bridgePlatforms: Type.Optional(Type.Array(StringEnum(["wechat", "feishu", "dingtalk", "telegram", "qq"], {
        description: "Explicit Bridge platform fan-out targets when channels includes bridge_owner. Provide multiple values to send the same notification to multiple platforms.",
      }), {
        description: "Bridge platforms to send to. If set, Bridge owner notifications are sent to every listed platform with an available owner target.",
      })),
      contextPolicy: Type.Optional(StringEnum(["none", "record_when_delivered"], {
        description: "Whether a successfully delivered Bridge notification should be appended to the Bridge conversation context.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { title, body } = params;
      try {
        const result = await onNotify?.({
          title,
          body,
          audience: params.audience,
          channels: params.channels,
          bridgePlatforms: params.bridgePlatforms,
          contextPolicy: params.contextPolicy,
        }, {
          sessionPath: typeof ctx?.sessionPath === "string" && ctx.sessionPath.trim() ? ctx.sessionPath.trim() : null,
          bridgeContext: ctx?.bridgeContext?.isBridgeSession === true ? ctx.bridgeContext : null,
          notificationContext: ctx?.notificationContext && typeof ctx.notificationContext === "object"
            ? ctx.notificationContext
            : null,
        });
        const sent = result?.ok !== false;
        const failure = Array.isArray(result?.deliveries)
          ? result.deliveries.find((d) => d?.status === "failed")?.error
          : null;
        return {
          content: [{
            type: "text",
            text: sent
              ? t("error.notifySent", { title })
              : t("error.notifyFailed", { msg: failure || "delivery failed" }),
          }],
          details: { title, body, sent, result },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: t("error.notifyFailed", { msg: err.message }) }],
          details: { title, body, sent: false, error: err.message },
        };
      }
    },
  };
}
