import crypto from "crypto";
import fs from "fs";
import path from "path";
import { callText as defaultCallText } from "./llm-client.ts";
import { callTextConfigFromResolvedModel } from "./model-execution-config.ts";
import {
  prepareSingleModelImageInputForPrompt,
} from "./model-image-preprocess.ts";
import { modelSupportsImage } from "./message-sanitizer.ts";
import { getVisionCapabilities, modelSupportsDirectImageInput } from "../shared/model-capabilities.ts";

export const VISION_CONTEXT_START = "<vision-context>";
export const VISION_CONTEXT_END = "</vision-context>";
export const VISUAL_PRIMITIVES_START = "<visual-primitives";
export const VISUAL_PRIMITIVES_END = "</visual-primitives>";

const MAX_NOTE_CHARS = 3200;
const MAX_CACHE_ENTRIES = 256;
const MAX_VISUAL_PRIMITIVES = 16;
const MAX_PRIMITIVE_REF_CHARS = 96;
const VISION_ANALYSIS_TIMEOUT_MS = 120_000;
const VISION_NOTES_FILE = "session-vision-notes.json";
const AUXILIARY_VISION_SYSTEM_PROMPT = [
  "You are Luc's auxiliary vision model.",
  "Analyze the supplied image for the target model and follow the requested output format exactly.",
  "Do not mention hidden reasoning, internal tools, or that another model will read your answer.",
].join("\n");

function normalizeUserRequest(text) {
  return String(text || "")
    .replace(/\[attached_image:\s*[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function imagePromptCacheKey(img, userRequest, modelSignature = "") {
  const h = crypto.createHash("sha256");
  h.update(img?.mimeType || "image/png");
  h.update("\0");
  h.update(img?.data || "");
  h.update("\0");
  h.update(userRequest || "");
  h.update("\0");
  h.update(modelSignature || "");
  return h.digest("hex");
}

function truncate(text, max = MAX_NOTE_CHARS) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max - 20)}\n[truncated]` : s;
}

function abortError() {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  (err as any).type = "aborted";
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function requiresAuxiliaryVision(model) {
  return Array.isArray(model?.input) && !modelSupportsDirectImageInput(model);
}

function uniquePathsFromText(text) {
  const paths = [];
  const re = /\[attached_image:\s*([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text || ""))) paths.push(m[1].trim());
  return paths;
}

function sessionNotesDir(sessionPath) {
  if (!sessionPath) return null;
  const dir = path.dirname(sessionPath);
  return path.basename(dir) === "archived" ? path.dirname(dir) : dir;
}

function sessionNotesPath(sessionPath) {
  const dir = sessionNotesDir(sessionPath);
  return dir ? path.join(dir, VISION_NOTES_FILE) : null;
}

function sessionNotesKey(sessionPath) {
  return sessionPath ? path.basename(sessionPath) : null;
}

function normalizeSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id || null;
}

function noteCacheKey(sessionKey, imagePath) {
  return sessionKey ? `${sessionKey}\0${imagePath}` : imagePath;
}

function uniqueList(values: any[]) {
  return [...new Set(values.filter(Boolean))] as string[];
}

function emptyNotesSidecar() {
  return { version: 1, sessions: {} };
}

function sessionNotesEntry(sidecar, sessionId, sessionPath) {
  const sessions = sidecar?.sessions && typeof sidecar.sessions === "object"
    ? sidecar.sessions
    : {};
  const legacyKey = sessionNotesKey(sessionPath);
  for (const key of uniqueList([normalizeSessionId(sessionId), legacyKey])) {
    if (sessions[key] && typeof sessions[key] === "object") return { key, entry: sessions[key] };
  }
  for (const [key, entry] of Object.entries(sessions) as any) {
    if (normalizeSessionId(entry?.sessionId) === normalizeSessionId(sessionId)) return { key, entry };
    if (!sessionId && entry?.sessionPath === sessionPath) return { key, entry };
  }
  return null;
}

function valueContainsReference(value, reference, seen = new Set()) {
  if (!reference) return false;
  if (typeof value === "string") return value.includes(reference);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsReference(item, reference, seen));
  }
  return Object.entries(value).some(([key, item]) => (
    key.includes(reference) || valueContainsReference(item, reference, seen)
  ));
}

function readNotesSidecar(filePath) {
  if (!filePath) return emptyNotesSidecar();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return emptyNotesSidecar();
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return { version: 1, sessions: {} };
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return emptyNotesSidecar();
    throw err;
  }
}

function writeNotesSidecar(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

function compactModelRef(model) {
  return model?.id && model?.provider
    ? { id: model.id, provider: model.provider }
    : null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block?.type === "text" ? block.text || "" : "")
    .join("\n");
}

function replaceTextContent(content, replacer) {
  if (typeof content === "string") return replacer(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== "text") return block;
    const text = block.text || "";
    const replaced = replacer(text);
    if (replaced !== text) changed = true;
    return replaced !== text ? { ...block, text: replaced } : block;
  });
  return changed ? next : content;
}

function visionModelCacheSignature(model, visionCapabilities) {
  return JSON.stringify({
    provider: model?.provider || "",
    id: model?.id || "",
    visionCapabilities: visionCapabilities || null,
  });
}

function primitiveBoxOrderLabel(visionCapabilities) {
  return visionCapabilities?.boxOrder === "yxyx"
    ? "[ymin, xmin, ymax, xmax]"
    : "[x1, y1, x2, y2]";
}

function primitivePromptShape(visionCapabilities) {
  const format = visionCapabilities?.outputFormat || "luc";
  if (format === "gemini") {
    return [
      '  "visual_primitives": [',
      '    {"id":"v1","type":"box","label":"short label","box_2d":[0,0,0,0],"confidence":0.0}',
      "  ]",
      "For Gemini-family models, use box_2d with the native [ymin, xmin, ymax, xmax] order normalized to 0-1000.",
    ];
  }
  if (format === "qwen") {
    return [
      '  "visual_primitives": [',
      '    {"id":"v1","label":"short label","bbox_2d":[0,0,0,0],"point_2d":[0,0],"confidence":0.0}',
      "  ]",
      "For Qwen-family models, use bbox_2d as [x1, y1, x2, y2] and point_2d as [x, y], normalized to 0-1000.",
    ];
  }
  if (format === "anchor") {
    return [
      '  "visual_anchors": [',
      '    {"id":"v1","label":"short label","role":"button|text|object|region","center":[0,0],"box":[0,0,0,0],"confidence":0.0}',
      "  ]",
      "For computer-use style models, prefer visual_anchors with center [x, y] for clickable or salient targets, plus box [x1, y1, x2, y2] when visible.",
    ];
  }
  return [
    '  "visual_primitives": [',
    '    {"id":"v1","type":"box","ref":"short label","box":[0,0,0,0],"confidence":0.0}',
    "  ]",
    `For boxes, output the box array as ${primitiveBoxOrderLabel(visionCapabilities)} normalized to 0-1000.`,
  ];
}

function safeSection(value, fallback = "none") {
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item || "").trim()).filter(Boolean).join("; ");
    return joined || fallback;
  }
  const s = String(value || "").trim();
  return s || fallback;
}

function clampNorm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

function normalizeBox(rawBox, visionCapabilities) {
  if (!Array.isArray(rawBox) || rawBox.length !== 4) return null;
  const coords = rawBox.map(clampNorm);
  if (coords.some((n) => n === null)) return null;

  let x1;
  let y1;
  let x2;
  let y2;
  if (visionCapabilities?.boxOrder === "yxyx") {
    [y1, x1, y2, x2] = coords;
  } else {
    [x1, y1, x2, y2] = coords;
  }

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  if (left === right || top === bottom) return null;
  return [left, top, right, bottom];
}

function normalizePoint(rawPoint) {
  if (!Array.isArray(rawPoint) || rawPoint.length !== 2) return null;
  const point = rawPoint.map(clampNorm);
  if (point.some((n) => n === null)) return null;
  return point;
}

function primitiveLabel(raw, fallbackId) {
  const source = raw?.ref ?? raw?.label ?? raw?.text ?? raw?.name ?? raw?.id ?? fallbackId;
  const s = String(source || fallbackId).replace(/\s+/g, " ").trim();
  return s.slice(0, MAX_PRIMITIVE_REF_CHARS) || fallbackId;
}

function primitiveId(raw, index) {
  const candidate = String(raw?.id || `v${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return candidate || `v${index + 1}`;
}

function normalizePrimitive(raw, index, visionCapabilities) {
  if (!raw || typeof raw !== "object") return null;
  const rawBox = raw.box ?? raw.bbox ?? raw.bbox_2d ?? raw.box_2d;
  const rawPoint = raw.point ?? raw.point_2d ?? raw.center;

  const box = visionCapabilities?.boxes ? normalizeBox(rawBox, visionCapabilities) : null;
  if (box) {
    return {
      id: primitiveId(raw, index),
      type: "box",
      ref: primitiveLabel(raw, `v${index + 1}`),
      box,
      confidence: normalizeConfidence(raw.confidence),
      grounding: visionCapabilities?.groundingMode || "native",
    };
  }

  const point = visionCapabilities?.points ? normalizePoint(rawPoint) : null;
  if (point) {
    return {
      id: primitiveId(raw, index),
      type: "point",
      ref: primitiveLabel(raw, `v${index + 1}`),
      point,
      confidence: normalizeConfidence(raw.confidence),
      grounding: visionCapabilities?.groundingMode || "native",
    };
  }

  return null;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeVisualPrimitives(items, visionCapabilities) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (let i = 0; i < items.length && normalized.length < MAX_VISUAL_PRIMITIVES; i++) {
    const primitive = normalizePrimitive(items[i], i, visionCapabilities);
    if (primitive) normalized.push(primitive);
  }
  return normalized;
}

function rawVisualPrimitiveItems(analysis) {
  if (Array.isArray(analysis?.visual_primitives)) return analysis.visual_primitives;
  if (Array.isArray(analysis?.visual_anchors)) return analysis.visual_anchors;
  if (Array.isArray(analysis?.anchors)) return analysis.anchors;
  return [];
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const primary = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(primary);
  } catch {
    const start = primary.indexOf("{");
    const end = primary.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(primary.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function formatVisualPrimitives(primitives, groundingMode = "unavailable") {
  if (!primitives.length) {
    return [
      `${VISUAL_PRIMITIVES_START} coord="norm-1000" box_order="xyxy" grounding="unavailable">`,
      "- unavailable | reason: no valid coordinates",
      VISUAL_PRIMITIVES_END,
    ].join("\n");
  }
  const lines = primitives.map((primitive) => {
    const coord = primitive.type === "box"
      ? `box: [${primitive.box.join(", ")}]`
      : `point: [${primitive.point.join(", ")}]`;
    const confidence = primitive.confidence === null ? "" : ` | confidence: ${primitive.confidence.toFixed(2)}`;
    return `- ${primitive.id} | type: ${primitive.type} | ${coord} | ref: ${primitive.ref}${confidence} | grounding: ${primitive.grounding}`;
  });
  return [
    `${VISUAL_PRIMITIVES_START} coord="norm-1000" box_order="xyxy" grounding="${groundingMode}">`,
    ...lines,
    VISUAL_PRIMITIVES_END,
  ].join("\n");
}

function formatStructuredVisionNote(analysis, visionCapabilities) {
  const primitives = normalizeVisualPrimitives(rawVisualPrimitiveItems(analysis), visionCapabilities);
  const sections = [
    `image_overview: ${safeSection(analysis?.image_overview)}`,
    `visible_text: ${safeSection(analysis?.visible_text)}`,
    `objects_and_layout: ${safeSection(analysis?.objects_and_layout)}`,
    `charts_or_data: ${safeSection(analysis?.charts_or_data)}`,
    `user_request: ${safeSection(analysis?.user_request)}`,
    `user_request_answer: ${safeSection(analysis?.user_request_answer)}`,
    `evidence: ${safeSection(analysis?.evidence)}`,
    `uncertainty: ${safeSection(analysis?.uncertainty)}`,
  ];
  const primitiveBlock = formatVisualPrimitives(primitives, visionCapabilities?.groundingMode);
  return truncate(`${sections.join("\n")}\n\n${primitiveBlock}`);
}

function formatInvalidStructuredNote(rawResponse) {
  const primitiveBlock = formatVisualPrimitives([]);
  return truncate([
    "image_overview: structured vision analysis unavailable.",
    "visible_text: none.",
    "objects_and_layout: none.",
    "charts_or_data: none.",
    "user_request: see original message.",
    "user_request_answer: The auxiliary vision model returned invalid structured JSON, so coordinate evidence was not used.",
    `evidence: raw response excerpt: ${truncate(rawResponse, 700)}`,
    "uncertainty: visual primitives unavailable because the response could not be parsed.",
    "",
    primitiveBlock,
  ].join("\n"));
}

export class VisionBridge {
  declare _analysisByPrompt: any;
  declare _callText: any;
  declare _getActiveAgentId: any;
  declare _getSessionIdForPath: any;
  declare _getUsageLedger: any;
  declare _imagePolicy: any;
  declare _maxCacheEntries: any;
  declare _noteByPath: any;
  declare _now: any;
  declare _resizeImage: any;
  declare _formatDimensionNote: any;
  declare _resolveVisionConfig: any;
  constructor({
    resolveVisionConfig,
    callText = defaultCallText,
    getUsageLedger = null,
    getActiveAgentId = null,
    getSessionIdForPath = null,
    imagePolicy = null,
    resizeImage = null,
    formatDimensionNote = null,
    now = () => Date.now(),
    maxCacheEntries = MAX_CACHE_ENTRIES,
  }: any = {}) {
    this._resolveVisionConfig = resolveVisionConfig || (() => null);
    this._callText = callText;
    this._getUsageLedger = typeof getUsageLedger === "function" ? getUsageLedger : () => null;
    this._getActiveAgentId = typeof getActiveAgentId === "function" ? getActiveAgentId : () => null;
    this._getSessionIdForPath = typeof getSessionIdForPath === "function" ? getSessionIdForPath : () => null;
    this._imagePolicy = imagePolicy || null;
    this._resizeImage = typeof resizeImage === "function" ? resizeImage : null;
    this._formatDimensionNote = typeof formatDimensionNote === "function" ? formatDimensionNote : null;
    this._now = now;
    this._maxCacheEntries = maxCacheEntries;
    this._analysisByPrompt = new Map();
    this._noteByPath = new Map();
  }

  async prepare({ sessionPath, targetModel, text, images, imageAttachmentPaths, signal }: any = {}) {
    if (!images?.length) return { text, images };
    if (!requiresAuxiliaryVision(targetModel)) return { text, images };
    throwIfAborted(signal);

    const config = await this._resolveVisionConfig?.();
    if (!config?.model) {
      throw new Error("vision auxiliary model is required for image input with the current text-only model");
    }
    if (!modelSupportsImage(config.model)) {
      throw new Error("vision auxiliary model must support image input");
    }

    const paths = imageAttachmentPaths?.length ? imageAttachmentPaths : uniquePathsFromText(text);
    const userRequest = normalizeUserRequest(text);
    const notes = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      throwIfAborted(signal);
      const note = await this._analyzeImage(config, img, i, userRequest, signal, sessionPath);
      const imagePath = paths[i];
      if (imagePath) {
        const entry = {
          note,
          sessionId: this._sessionIdForPath(sessionPath),
          sessionPath: sessionPath || null,
          imagePath,
          userRequest,
          visionModel: compactModelRef(config.model),
          targetModel: compactModelRef(targetModel),
          updatedAt: this._now(),
        };
        this._rememberNote(sessionPath, imagePath, entry);
        if (sessionPath) this._persistNote(sessionPath, imagePath, entry);
      }
      notes.push(note);
    }

    return { text, images: undefined, visionNotes: notes };
  }

  async prepareResources({ sessionPath, targetModel, userRequest, text, resources, signal }: any = {}) {
    if (!resources?.length) return { notes: [] };
    if (!requiresAuxiliaryVision(targetModel)) return { notes: [] };
    return this._summarizeResources({
      sessionPath,
      targetModel,
      userRequest: userRequest ?? text,
      resources,
      signal,
    });
  }

  async summarizeResources({ sessionPath, userRequest, text, resources, signal }: any = {}) {
    if (!resources?.length) return { notes: [] };
    return this._summarizeResources({
      sessionPath,
      targetModel: null,
      userRequest: userRequest ?? text,
      resources,
      signal,
    });
  }

  async _summarizeResources({ sessionPath, targetModel, userRequest, resources, signal }: any = {}) {
    throwIfAborted(signal);

    const config = await this._resolveVisionConfig?.();
    if (!config?.model) {
      throw new Error("vision auxiliary model is required for image input with the current text-only model");
    }
    if (!modelSupportsImage(config.model)) {
      throw new Error("vision auxiliary model must support image input");
    }

    const request = normalizeUserRequest(userRequest);
    const notes = [];
    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i];
      const key = String(resource?.key || "").trim();
      const img = resource?.image;
      if (!key || !img) continue;

      const existing = this._lookupNote(sessionPath, key);
      if (existing?.note) {
        notes.push({
          key,
          label: resource?.label || key,
          note: existing.note,
          reused: true,
        });
        continue;
      }

      throwIfAborted(signal);
      const note = await this._analyzeImage(config, img, i, request, signal, sessionPath);
      const entry = {
        note,
        sessionId: this._sessionIdForPath(sessionPath),
        sessionPath: sessionPath || null,
        imagePath: key,
        userRequest: request,
        visionModel: compactModelRef(config.model),
        targetModel: compactModelRef(targetModel),
        updatedAt: this._now(),
      };
      this._rememberNote(sessionPath, key, entry);
      if (sessionPath) this._persistNote(sessionPath, key, entry);
      notes.push({
        key,
        label: resource?.label || key,
        note,
        reused: false,
      });
    }

    return { notes };
  }

  lookupNote(sessionPath, imagePath) {
    return this._lookupNote(sessionPath, imagePath);
  }

  forkSessionNotes({
    sourceSessionId,
    sourceSessionPath,
    targetSessionId,
    targetSessionPath,
    retainedEntries = [],
  }: any = {}) {
    const sourceId = normalizeSessionId(sourceSessionId);
    const targetId = normalizeSessionId(targetSessionId);
    if (!sourceId) throw new Error("sourceSessionId is required to fork vision notes");
    if (!targetId) throw new Error("targetSessionId is required to fork vision notes");
    if (sourceId === targetId) throw new Error("targetSessionId must differ from sourceSessionId");
    if (!path.isAbsolute(sourceSessionPath || "")) throw new Error("sourceSessionPath must be absolute");
    if (!path.isAbsolute(targetSessionPath || "")) throw new Error("targetSessionPath must be absolute");
    if (path.resolve(sourceSessionPath) === path.resolve(targetSessionPath)) {
      throw new Error("targetSessionPath must differ from sourceSessionPath");
    }

    const sourceFilePath = sessionNotesPath(sourceSessionPath);
    const sourceSidecar = readNotesSidecar(sourceFilePath);
    const source = sessionNotesEntry(sourceSidecar, sourceId, sourceSessionPath);
    const sourceImages = source?.entry?.images && typeof source.entry.images === "object"
      ? source.entry.images
      : {};
    const retainedImages = Object.entries(sourceImages).filter(([imagePath]) => (
      valueContainsReference(retainedEntries, imagePath)
    ));
    if (!retainedImages.length) return { notes: 0, keys: [] };

    const targetFilePath = sessionNotesPath(targetSessionPath);
    const targetSidecar = targetFilePath === sourceFilePath
      ? sourceSidecar
      : readNotesSidecar(targetFilePath);
    if (sessionNotesEntry(targetSidecar, targetId, targetSessionPath)) {
      throw new Error("target session vision notes already exist");
    }

    const images = {};
    for (const [imagePath, rawEntry] of retainedImages as any) {
      const entry = {
        ...rawEntry,
        imagePath,
        sessionId: targetId,
        sessionPath: targetSessionPath,
      };
      images[imagePath] = entry;
      this._rememberNote(targetSessionPath, imagePath, entry);
    }
    targetSidecar.sessions[targetId] = {
      sessionId: targetId,
      sessionPath: targetSessionPath,
      images,
    };
    writeNotesSidecar(targetFilePath, targetSidecar);
    return { notes: retainedImages.length, keys: retainedImages.map(([imagePath]) => imagePath) };
  }

  discardForkedSessionNotes({ sessionId, sessionPath }: any = {}) {
    const normalizedId = normalizeSessionId(sessionId);
    if (!normalizedId) throw new Error("sessionId is required to discard forked vision notes");
    if (!path.isAbsolute(sessionPath || "")) throw new Error("sessionPath must be absolute");
    const filePath = sessionNotesPath(sessionPath);
    const sidecar = readNotesSidecar(filePath);
    const found = sessionNotesEntry(sidecar, normalizedId, sessionPath);
    if (!found) return false;
    delete sidecar.sessions[found.key];
    writeNotesSidecar(filePath, sidecar);
    for (const [key, entry] of this._noteByPath) {
      if (normalizeSessionId(entry?.sessionId) === normalizedId || entry?.sessionPath === sessionPath) {
        this._noteByPath.delete(key);
      }
    }
    return true;
  }

  injectNotes(messages, sessionPath = null) {
    if (!Array.isArray(messages)) return { messages, injected: 0 };
    let injected = 0;

    const next = messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      if (msg.role !== "user") return msg;
      const text = contentText(msg.content);
      if (!text || text.includes(VISION_CONTEXT_START)) return msg;
      const entries = uniquePathsFromText(text)
        .map((imagePath) => [imagePath, this._lookupNote(sessionPath, imagePath)])
        .filter(([, entry]) => !!entry);
      if (!entries.length) return msg;

      const noteText = entries.map(([, entry], idx) => {
        return `image_${idx + 1}: ${entry.note}`;
      }).join("\n\n");
      const block = `${VISION_CONTEXT_START}\n${noteText}\n${VISION_CONTEXT_END}\n\n`;

      const replacedContent = replaceTextContent(msg.content, (oldText) => {
        const localPaths = uniquePathsFromText(oldText);
        const localHits = entries.filter(([imagePath]) => localPaths.includes(imagePath));
        if (!localHits.length) return oldText;
        injected += localHits.length;
        return `${block}${oldText}`;
      });
      return replacedContent === msg.content ? msg : { ...msg, content: replacedContent };
    });

    return { messages: injected ? next : messages, injected };
  }

  _sessionRefForPath(sessionPath) {
    const sessionId = this._sessionIdForPath(sessionPath);
    const legacyKey = sessionNotesKey(sessionPath);
    return {
      sessionId,
      sessionPath: sessionPath || null,
      sessionKey: sessionId || legacyKey,
      legacyKey,
    };
  }

  _sessionIdForPath(sessionPath) {
    if (!sessionPath) return null;
    return normalizeSessionId(this._getSessionIdForPath?.(sessionPath));
  }

  _noteCacheKeys(sessionPath, imagePath) {
    const sessionRef = this._sessionRefForPath(sessionPath);
    return uniqueList([
      noteCacheKey(sessionRef.sessionKey, imagePath),
      sessionRef.legacyKey && sessionRef.legacyKey !== sessionRef.sessionKey
        ? noteCacheKey(sessionRef.legacyKey, imagePath)
        : null,
      imagePath,
    ]);
  }

  _rememberNote(sessionPath, imagePath, entry) {
    const sessionRef = this._sessionRefForPath(sessionPath);
    this._noteByPath.set(noteCacheKey(sessionRef.sessionKey, imagePath), entry);
    this._trimNoteCache();
  }

  _cachedNote(sessionPath, imagePath) {
    const sessionRef = this._sessionRefForPath(sessionPath);
    for (const key of this._noteCacheKeys(sessionPath, imagePath)) {
      const entry = this._noteByPath.get(key);
      if (entry && this._entryMatchesSession(entry, sessionRef)) return entry;
    }
    return null;
  }

  _entryMatchesSession(entry, sessionRef) {
    if (!sessionRef.sessionId && !sessionRef.sessionPath) return true;
    if (sessionRef.sessionId && entry?.sessionId) return entry.sessionId === sessionRef.sessionId;
    if (entry?.sessionPath) return entry.sessionPath === sessionRef.sessionPath;
    return !entry?.sessionId;
  }

  _findSidecarNote(sidecar, sessionRef, imagePath) {
    const sessions: Record<string, any> = sidecar?.sessions && typeof sidecar.sessions === "object"
      ? sidecar.sessions
      : {};
    const directKeys = uniqueList([
      sessionRef.sessionKey,
      sessionRef.legacyKey && sessionRef.legacyKey !== sessionRef.sessionKey
        ? sessionRef.legacyKey
        : null,
    ]);
    for (const sessionKey of directKeys) {
      const entry = sessions?.[sessionKey]?.images?.[imagePath] || null;
      if (entry?.note) return { sessionKey, entry };
    }

    if (!sessionRef.sessionId) return null;

    for (const [sessionKey, sessionEntry] of Object.entries(sessions)) {
      const entry = (sessionEntry as any)?.images?.[imagePath] || null;
      if (!entry?.note) continue;
      if ((sessionEntry as any)?.sessionId === sessionRef.sessionId || entry.sessionId === sessionRef.sessionId) {
        return { sessionKey, entry };
      }
    }

    const legacyHits = [];
    for (const [sessionKey, sessionEntry] of Object.entries(sessions)) {
      const entry = (sessionEntry as any)?.images?.[imagePath] || null;
      if (!entry?.note || entry.sessionId) continue;
      if (entry.sessionPath && entry.sessionPath !== sessionRef.sessionPath) continue;
      legacyHits.push({ sessionKey, entry });
    }
    return legacyHits.length === 1 ? legacyHits[0] : null;
  }

  _persistNote(sessionPath, imagePath, entry) {
    const filePath = sessionNotesPath(sessionPath);
    const sessionRef = this._sessionRefForPath(sessionPath);
    if (!filePath || !sessionRef.sessionKey) return;

    const sidecar = readNotesSidecar(filePath);
    const sessionEntry = sidecar.sessions[sessionRef.sessionKey] || { images: {} };
    const images = sessionEntry.images && typeof sessionEntry.images === "object"
      ? sessionEntry.images
      : {};
    const sessionId = sessionRef.sessionId || entry.sessionId || null;
    images[imagePath] = {
      note: entry.note,
      imagePath,
      sessionId,
      sessionPath: entry.sessionPath || sessionPath || null,
      userRequest: entry.userRequest || "",
      visionModel: entry.visionModel || null,
      targetModel: entry.targetModel || null,
      updatedAt: entry.updatedAt,
    };
    sidecar.sessions[sessionRef.sessionKey] = {
      ...sessionEntry,
      sessionId,
      sessionPath: sessionPath || sessionEntry.sessionPath || null,
      images,
    };
    writeNotesSidecar(filePath, sidecar);
  }

  _lookupNote(sessionPath, imagePath) {
    const memoryEntry = this._cachedNote(sessionPath, imagePath);
    if (memoryEntry) {
      return memoryEntry;
    }
    if (!sessionPath) return null;

    const filePath = sessionNotesPath(sessionPath);
    const sessionRef = this._sessionRefForPath(sessionPath);
    if (!filePath || !sessionRef.sessionKey) return null;
    const sidecar = readNotesSidecar(filePath);
    const found = this._findSidecarNote(sidecar, sessionRef, imagePath);
    if (!found?.entry?.note) return null;
    const entry = found.entry;
    const restored = {
      note: entry.note,
      sessionId: entry.sessionId || sessionRef.sessionId || null,
      sessionPath,
      imagePath,
      userRequest: entry.userRequest || "",
      visionModel: entry.visionModel || null,
      targetModel: entry.targetModel || null,
      updatedAt: entry.updatedAt || this._now(),
    };
    this._rememberNote(sessionPath, imagePath, restored);
    if (sessionRef.sessionId && found.sessionKey !== sessionRef.sessionKey) {
      this._persistNote(sessionPath, imagePath, restored);
    }
    return restored;
  }

  async _analyzeImage(config, img, index, userRequest, signal, sessionPath = null) {
    const prepared = await prepareSingleModelImageInputForPrompt({
      image: img,
      index,
      imageCount: 1,
      imagePolicy: this._imagePolicy,
      resizeImage: this._resizeImage,
      formatDimensionNote: this._formatDimensionNote,
      signal,
    });
    const normalizedImg = prepared.image;
    const visionCapabilities = getVisionCapabilities(config.model);
    const key = imagePromptCacheKey(
      normalizedImg,
      userRequest,
      visionModelCacheSignature(config.model, visionCapabilities),
    );
    const cached = this._analysisByPrompt.get(key);
    if (cached) {
      cached.lastUsedAt = this._now();
      return cached.note;
    }

    const note = visionCapabilities
      ? await this._analyzeImageWithPrimitives(config, normalizedImg, userRequest, visionCapabilities, signal, sessionPath)
      : await this._analyzeImageAsNote(config, normalizedImg, userRequest, signal, sessionPath);

    this._analysisByPrompt.set(key, {
      note,
      createdAt: this._now(),
      lastUsedAt: this._now(),
      index,
    });
    this._trimCache();
    return note;
  }

  _usageContextForImageAnalysis(sessionPath) {
    const agentId = this._getActiveAgentId?.() ?? null;
    const sessionId = this._sessionIdForPath(sessionPath);
    return {
      source: {
        subsystem: "vision",
        operation: "analyze_image",
        surface: sessionPath ? "session" : "tool",
        trigger: "user",
      },
      attribution: sessionPath
        ? { kind: "session", ...(sessionId ? { sessionId } : {}), sessionPath, agentId }
        : { kind: "utility", agentId },
    };
  }

  async _analyzeImageAsNote(config, img, userRequest, signal, sessionPath = null) {
    return truncate(await this._callText({
      ...callTextConfigFromResolvedModel(config),
      systemPrompt: AUXILIARY_VISION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Analyze this image for another text-only model.",
              "Return a concise paper note with these exact sections:",
              "image_overview: fixed basic description of what the image is.",
              "visible_text: important OCR or readable text.",
              "objects_and_layout: important objects, positions, counts, and relationships.",
              "charts_or_data: chart/table/data details if present; otherwise say none.",
              "user_request: restate the user's request in one short sentence.",
              "user_request_answer: answer the user's request using the image when possible.",
              "evidence: the visual evidence supporting that answer.",
              "uncertainty: anything unclear, hidden, or guessed.",
              "Do not mention that you are a tool or a separate model.",
              "",
              `User request:\n${userRequest || "(no explicit text request)"}`,
            ].join("\n"),
          },
          img,
        ],
      }],
      timeoutMs: VISION_ANALYSIS_TIMEOUT_MS,
      callPurpose: "auxiliary_vision",
      signal,
      usageLedger: this._getUsageLedger?.(),
      usageContext: this._usageContextForImageAnalysis(sessionPath),
    }));
  }

  async _analyzeImageWithPrimitives(config, img, userRequest, visionCapabilities, signal, sessionPath = null) {
    const primitiveShape = primitivePromptShape(visionCapabilities);
    const responseText = await this._callText({
      ...callTextConfigFromResolvedModel(config),
      systemPrompt: AUXILIARY_VISION_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Analyze this image for another text-only model.",
              "Return only one valid JSON object. Do not wrap it in Markdown.",
              "Use this exact shape:",
              "{",
              '  "image_overview": "fixed basic description of what the image is",',
              '  "visible_text": ["important OCR or readable text"],',
              '  "objects_and_layout": "important objects, positions, counts, and relationships",',
              '  "charts_or_data": "chart/table/data details if present; otherwise none",',
              '  "user_request": "restate the user request in one short sentence",',
              '  "user_request_answer": "answer the user request using the image when possible",',
              '  "evidence": "visual evidence supporting that answer",',
              '  "uncertainty": "anything unclear, hidden, or guessed",',
              ...primitiveShape.slice(0, 3),
              "}",
              primitiveShape[3],
              visionCapabilities.points
                ? "You may include point or center coordinates as [x, y] normalized to 0-1000."
                : "Do not output point primitives.",
              "Include only coordinates that matter for the user request or key spatial evidence.",
              "Do not mention that you are a tool or a separate model.",
              "",
              `User request:\n${userRequest || "(no explicit text request)"}`,
            ].join("\n"),
          },
          img,
        ],
      }],
      timeoutMs: VISION_ANALYSIS_TIMEOUT_MS,
      callPurpose: "auxiliary_vision",
      signal,
      usageLedger: this._getUsageLedger?.(),
      usageContext: this._usageContextForImageAnalysis(sessionPath),
    });

    const analysis = extractJsonObject(responseText);
    if (!analysis) return formatInvalidStructuredNote(responseText);
    return formatStructuredVisionNote(analysis, visionCapabilities);
  }

  _trimCache() {
    if (this._analysisByPrompt.size <= this._maxCacheEntries) return;
    const entries = [...this._analysisByPrompt.entries()]
      .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
    for (const [key] of entries.slice(0, this._analysisByPrompt.size - this._maxCacheEntries)) {
      this._analysisByPrompt.delete(key);
    }
  }

  _trimNoteCache() {
    if (this._noteByPath.size <= this._maxCacheEntries) return;
    const entries = [...this._noteByPath.entries()]
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (const [key] of entries.slice(0, this._noteByPath.size - this._maxCacheEntries)) {
      this._noteByPath.delete(key);
    }
  }
}
