import { createRequire } from "module";

const require = createRequire(import.meta.url);

const CUSTOM_WORDS = [
  "session_search 1000 nz",
  "session 1000 eng",
  "SessionFile 1000 eng",
  "A2A通信 1000 nz",
  "聊天记录 1000 nz",
  "搜不到 1000 v",
  "Agent 1000 eng",
  "CodeX 1000 eng",
  "Claude 1000 eng",
  "OpenClaw 1000 eng",
  "Cherry 1000 eng",
  "Studio 1000 eng",
  "LUC_HOME 1000 eng",
  "Bridge 1000 eng",
  "MCP 1000 eng",
  "RC 1000 eng",
  "better-sqlite3 1000 eng",
];

const PUNCTUATION_RE = /^[\p{P}\p{S}\s]+$/u;
const ASCII_WORD_RE = /[a-z0-9_][a-z0-9_.-]*/giu;
const SPACED_TERM_RE = /[^\s]+/gu;

let jiebaInstance = null;

export class SessionSearchTokenizerUnavailableError extends Error {
  constructor(cause) {
    super("session_search_tokenizer_unavailable");
    this.name = "SessionSearchTokenizerUnavailableError";
    this.cause = cause;
  }
}

export function normalizeSessionSearchText(value): string {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSessionSearchQuery(query): string[] {
  const normalized = normalizeSessionSearchText(query);
  if (!normalized) return [];

  const terms = new Set<string>();
  addToken(terms, normalized);

  for (const match of normalized.matchAll(SPACED_TERM_RE)) {
    addToken(terms, match[0]);
  }
  for (const match of normalized.matchAll(ASCII_WORD_RE)) {
    addToken(terms, match[0]);
  }

  const jieba = getJieba();
  for (const token of jieba.cutForSearch(normalized, true)) {
    addToken(terms, normalizeSessionSearchText(token));
  }

  return [...terms];
}

function getJieba() {
  if (jiebaInstance) return jiebaInstance;

  try {
    const { Jieba } = require("@node-rs/jieba");
    const { dict } = require("@node-rs/jieba/dict");
    const jieba = Jieba.withDict(dict);
    jieba.loadDict(Buffer.from(CUSTOM_WORDS.join("\n"), "utf8"));
    jiebaInstance = jieba;
    return jieba;
  } catch (err) {
    throw new SessionSearchTokenizerUnavailableError(err);
  }
}

function addToken(terms, token) {
  const value = normalizeSessionSearchText(token);
  if (!value || PUNCTUATION_RE.test(value)) return;
  if (value.length === 1 && /^[\p{Script=Han}]$/u.test(value)) return;
  terms.add(value);
}
