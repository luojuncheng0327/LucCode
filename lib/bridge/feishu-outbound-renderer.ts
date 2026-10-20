import MarkdownIt from "markdown-it";

const FEISHU_AT_TOKEN_RE = /<at\s+user_id=(["'])([^"']+)\1\s*>([\s\S]*?)<\/at>/gi;

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

export type FeishuOutboundKind = "post" | "interactive";

export interface FeishuOutboundMessage {
  kind: FeishuOutboundKind;
  msgType: "post" | "interactive";
  content: string;
}

function renderFeishuPostParagraph(text: string) {
  const parts: Array<Record<string, string>> = [];
  let cursor = 0;
  FEISHU_AT_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = FEISHU_AT_TOKEN_RE.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) parts.push({ tag: "md", text: before });
    const userId = match[2].trim();
    const userName = match[3].trim() || userId;
    if (userId) parts.push({ tag: "at", user_id: userId, user_name: userName });
    cursor = match.index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail || parts.length === 0) parts.push({ tag: "md", text: tail });
  return parts;
}

export function renderFeishuPostMessageContent(text: unknown) {
  const paragraphs = String(text || "")
    .split(/\r?\n/)
    .map(renderFeishuPostParagraph);
  return JSON.stringify({
    zh_cn: {
      content: paragraphs,
    },
  });
}

function hasMarkdownTable(text: unknown) {
  return md.parse(String(text || ""), {}).some((token) => token.type === "table_open");
}

export function renderFeishuInteractiveMarkdownMessageContent(text: unknown) {
  const content = String(text || "").trim() ? String(text) : " ";
  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content,
        },
      ],
    },
  });
}

export function renderFeishuOutbound(
  text: unknown,
  { forceInteractive = false }: { forceInteractive?: boolean } = {},
): FeishuOutboundMessage {
  if (forceInteractive || hasMarkdownTable(text)) {
    return {
      kind: "interactive",
      msgType: "interactive",
      content: renderFeishuInteractiveMarkdownMessageContent(text),
    };
  }
  return {
    kind: "post",
    msgType: "post",
    content: renderFeishuPostMessageContent(text),
  };
}
