function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeProvider(provider: any) {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function normalizeModelId(modelId: any) {
  return typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
}

function ollamaModelText(modelId: string) {
  const id = normalizeModelId(modelId);
  if (!id) return "";
  const slashBare = id.includes("/") ? id.split("/").pop() || id : id;
  const tagBare = slashBare.split(":")[0] || slashBare;
  return `${id} ${slashBare} ${tagBare}`;
}

const OLLAMA_VISION_MODEL_PATTERNS = [
  /(^|[\s/_.:-])(?:llava|bakllava)(?=$|[\s/_.:-])/,
  /(^|[\s/_.:-])minicpm[-_.]?v(?=$|[\s/_.:-]|\d)/,
  /(^|[\s/_.:-])moondream(?=$|[\s/_.:-]|\d)/,
  /(^|[\s/_.:-])llama(?:3(?:\.2|p2)?|v3p2)?[\w_.:-]*vision(?=$|[\s/_.:-])/,
  /(^|[\s/_.:-])phi[\w_.:-]*vision(?=$|[\s/_.:-])/,
  /(^|[\s/_.:-])granite[\w_.:-]*vision(?=$|[\s/_.:-])/,
  /(^|[\s/_.:-])qwen[\w_.:-]*(?:vl|vision)(?=$|[\s/_.:-]|\d)/,
  /(^|[\s/_.:-])gemma3(?=$|[\s/_.:-])/,
];

export function inferOllamaModelMetadata(provider: any, modelId: any): Record<string, any> | null {
  if (normalizeProvider(provider) !== "ollama") return null;
  const text = ollamaModelText(modelId);
  if (!text) return null;
  if (!OLLAMA_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return { image: true };
}

export function enrichOllamaModelMetadata(provider: any, model: any) {
  const id = isPlainObject(model) ? model.id : model;
  const inferred = inferOllamaModelMetadata(provider, id);
  if (!inferred) return model;
  if (!isPlainObject(model)) return { id, ...inferred };
  if (model.image !== undefined || model.vision !== undefined) return model;
  return { ...model, ...inferred };
}
