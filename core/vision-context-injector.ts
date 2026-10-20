import { adaptVisualContextMessages } from "./visual-context-pipeline.ts";
import {
  VISION_CONTEXT_END,
  VISION_CONTEXT_START,
} from "./vision-bridge.ts";

export const VISION_CONTEXT_INJECTION_FAILED = "VISION_CONTEXT_INJECTION_FAILED";

function refValue(ref) {
  if (typeof ref === "function") return ref();
  if (ref && typeof ref === "object" && "current" in ref) return ref.current;
  return ref ?? null;
}

function compactModel(model) {
  return model?.id && model?.provider
    ? { id: model.id, provider: model.provider }
    : null;
}

function errorMessage(err) {
  return err?.message || String(err || "unknown error");
}

function buildFailureDiagnostic({ path, sessionPath, targetModel, err }) {
  return {
    code: VISION_CONTEXT_INJECTION_FAILED,
    path: path || "luc-vision-context-injection",
    stage: "context",
    sessionPath: sessionPath || null,
    targetModel: compactModel(targetModel),
    message: errorMessage(err),
  };
}

function diagnosticBlock(diagnostic) {
  return `${VISION_CONTEXT_START}\nvision_context_injection_diagnostic: ${JSON.stringify(diagnostic)}\n${VISION_CONTEXT_END}\n\n`;
}

function injectDiagnostic(messages, diagnostic) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const index = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") return i;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && typeof messages[i] === "object") return i;
    }
    return -1;
  })();
  if (index < 0) return messages;

  const next = [...messages];
  const msg = messages[index];
  const block = diagnosticBlock(diagnostic);
  if (typeof msg.content === "string") {
    next[index] = { ...msg, content: `${block}${msg.content}` };
    return next;
  }
  if (Array.isArray(msg.content)) {
    next[index] = {
      ...msg,
      content: [{ type: "text", text: block }, ...msg.content],
    };
    return next;
  }
  next[index] = { ...msg, content: [{ type: "text", text: block }] };
  return next;
}

export async function runVisionContextInjection({
  path,
  event,
  sessionPathRef,
  targetModelRef,
  getVisionBridge,
  isVisionAuxiliaryEnabled,
  resolveSessionFile,
  warn,
}: {
  path?: any;
  event?: any;
  sessionPathRef?: any;
  targetModelRef?: any;
  getVisionBridge?: any;
  isVisionAuxiliaryEnabled?: any;
  resolveSessionFile?: any;
  warn?: any;
} = {}) {
  const messages = event?.messages;
  let sessionPath = null;
  let targetModel = null;
  try {
    if (isVisionAuxiliaryEnabled?.() !== true) return undefined;
    const bridge = getVisionBridge?.();
    if (!bridge) return undefined;
    sessionPath = refValue(sessionPathRef);
    targetModel = refValue(targetModelRef);
    const adapted = await adaptVisualContextMessages({
      messages,
      sessionPath,
      targetModel,
      visionBridge: bridge,
      isVisionAuxiliaryEnabled: () => isVisionAuxiliaryEnabled?.() === true,
      resolveSessionFile,
      warn,
    });
    const injectedNotes = bridge.injectNotes(adapted.messages, sessionPath);
    if (!adapted.injected && !injectedNotes.injected) return undefined;
    return { messages: injectedNotes.messages };
  } catch (err) {
    const diagnostic = buildFailureDiagnostic({
      path,
      sessionPath,
      targetModel,
      err,
    });
    warn?.(diagnostic);
    return {
      messages: injectDiagnostic(messages, diagnostic),
      diagnostics: [diagnostic],
    };
  }
}

export function createVisionContextInjectionExtension({
  path = "luc-vision-context-injection",
  sessionPathRef,
  targetModelRef,
  getVisionBridge,
  isVisionAuxiliaryEnabled,
  resolveSessionFile,
  warn,
}: {
  path?: string;
  sessionPathRef?: any;
  targetModelRef?: any;
  getVisionBridge?: any;
  isVisionAuxiliaryEnabled?: any;
  resolveSessionFile?: any;
  warn?: any;
} = {}) {
  return {
    path,
    tools: new Map(),
    handlers: new Map([
      [
        "context",
        [
          async (event) => runVisionContextInjection({
            path,
            event,
            sessionPathRef,
            targetModelRef,
            getVisionBridge,
            isVisionAuxiliaryEnabled,
            resolveSessionFile,
            warn,
          }),
        ],
      ],
    ]),
    flags: new Map(),
    shortcuts: new Map(),
    commands: new Map(),
    messageRenderers: new Map(),
  };
}

export function withVisionContextInjectionExtension(resourceLoader, options = {}) {
  return Object.create(resourceLoader, {
    getExtensions: {
      value: () => {
        const base = resourceLoader.getExtensions?.() ?? { extensions: [], errors: [] };
        const extension = createVisionContextInjectionExtension(options);
        return { ...base, extensions: [extension, ...(base.extensions || [])] };
      },
    },
  });
}
