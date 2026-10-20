export const FEISHU_CARDKIT_STREAM_ELEMENT_ID = "luc_stream_markdown";

export type BridgePresentation = {
  kind: "bridge_presentation";
  format: "markdown";
  markdown: string;
};

type TelegramRichMessageOptions = {
  includeThinkingPlaceholder?: boolean;
  thinkingText?: unknown;
};

type FeishuCardKitCardOptions = {
  elementId?: string;
};

function normalizeMarkdown(text: unknown) {
  return String(text || "").replace(/\r\n?/g, "\n").trim();
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function createBridgePresentation(text: unknown): BridgePresentation {
  return {
    kind: "bridge_presentation",
    format: "markdown",
    markdown: normalizeMarkdown(text),
  };
}

function asPresentation(input: BridgePresentation | unknown): BridgePresentation {
  if (
    input &&
    typeof input === "object" &&
    (input as BridgePresentation).kind === "bridge_presentation" &&
    (input as BridgePresentation).format === "markdown"
  ) {
    return input as BridgePresentation;
  }
  return createBridgePresentation(input);
}

export function renderTelegramRichMessage(input: BridgePresentation | unknown, options: TelegramRichMessageOptions = {}) {
  const presentation = asPresentation(input);
  if (options.includeThinkingPlaceholder && !presentation.markdown) {
    const thinkingText = normalizeMarkdown(options.thinkingText) || "Thinking...";
    return { html: `<tg-thinking>${escapeHtml(thinkingText)}</tg-thinking>` };
  }
  return { markdown: presentation.markdown || " " };
}

export function renderFeishuCardKitCard(input: BridgePresentation | unknown, options: FeishuCardKitCardOptions = {}) {
  const presentation = asPresentation(input);
  const elementId = options.elementId || FEISHU_CARDKIT_STREAM_ELEMENT_ID;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      elements: [{
        tag: "markdown",
        element_id: elementId,
        content: presentation.markdown || " ",
      }],
    },
  };
}

export function renderFeishuCardKitSettings(streamingMode: boolean) {
  return JSON.stringify({
    config: {
      streaming_mode: Boolean(streamingMode),
    },
  });
}
