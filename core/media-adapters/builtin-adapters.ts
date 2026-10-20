import { agnesImageAdapter, agnesVideoAdapter } from "./agnes.ts";
import { dashscopeImageAdapter } from "./dashscope.ts";
import { geminiImageAdapter } from "./gemini.ts";
import { minimaxImageAdapter } from "./minimax.ts";
import { openaiCodexImageAdapter } from "./openai-codex.ts";
import { openaiImageAdapter } from "./openai.ts";
import { volcengineImageAdapter } from "./volcengine.ts";

export const builtinImageGenAdapters = Object.freeze([
  volcengineImageAdapter,
  openaiImageAdapter,
  openaiCodexImageAdapter,
  minimaxImageAdapter,
  dashscopeImageAdapter,
  geminiImageAdapter,
  agnesImageAdapter,
  agnesVideoAdapter,
]);
