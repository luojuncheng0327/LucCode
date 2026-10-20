/**
 * Platform-owned interaction-surface capability declaration.
 *
 * Bridge platforms are text/media consumers without Luc's interactive
 * confirmation cards. This declaration tells confirmation-related copy
 * (agent-facing tool results, bridge prompt lines) which confirmation
 * protocol the user can actually operate, so wording never assumes a
 * clickable desktop surface (#1619). buildBridgeContext attaches the
 * declaration per platform; consumers branch on confirmationMode only,
 * never on platform names.
 */

const CONFIRMATION_MODES = new Set(["text_command"]);

/**
 * @param {object} opts
 * @param {string} opts.platform
 * @param {"text_command"} opts.confirmationMode
 * @param {string} [opts.source]
 */
export function createInteractionCapabilities({ platform, confirmationMode, source = "" }: {
  platform: string;
  confirmationMode: string;
  source?: string;
}) {
  if (!platform) throw new Error("interaction capability requires platform");
  if (!CONFIRMATION_MODES.has(confirmationMode)) {
    throw new Error(`unsupported confirmation mode: ${confirmationMode}`);
  }
  return Object.freeze({ platform, confirmationMode, source });
}

/**
 * 平台 → 交互能力声明表。新增 bridge 平台必须在此声明（缺声明时
 * buildBridgeContext 直接 throw，不做静默降级）；与 BRIDGE_NOTIFY_PLATFORMS
 * 的一致性由 tests/bridge-interaction-capabilities.test.ts 守护。
 * 文本确认协议的命令事实源是 core/slash-commands/bridge-commands.ts（/apply）。
 */
export const BRIDGE_INTERACTION_CAPABILITIES: Record<string, ReturnType<typeof createInteractionCapabilities>> = Object.freeze({
  wechat: createInteractionCapabilities({
    platform: "wechat",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  feishu: createInteractionCapabilities({
    platform: "feishu",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  dingtalk: createInteractionCapabilities({
    platform: "dingtalk",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  telegram: createInteractionCapabilities({
    platform: "telegram",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
  qq: createInteractionCapabilities({
    platform: "qq",
    confirmationMode: "text_command",
    source: "core/slash-commands/bridge-commands.ts#apply",
  }),
});

export function interactionCapabilitiesForPlatform(platform: string) {
  const capability = BRIDGE_INTERACTION_CAPABILITIES[platform];
  if (!capability) {
    throw new Error(`no interaction capabilities declared for platform: ${platform}`);
  }
  return capability;
}
