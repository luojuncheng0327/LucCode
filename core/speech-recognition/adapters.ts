import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DEFAULT_MIME = "audio/wav";

export const openaiSpeechRecognitionAdapter = {
  id: "openai",
  name: "OpenAI Speech Recognition",
  protocolId: "openai-audio-transcriptions",
  types: ["speechRecognition"],
  async transcribe(input) {
    const { file, model, credentials } = input;
    const fetchImpl = resolveFetch(input);
    const baseUrl = trimTrailingSlash(credentials?.baseUrl || input.provider?.baseUrl || "https://api.openai.com/v1");
    const form = new FormData();
    form.set("model", model.id);
    if (input.language) form.set("language", input.language);
    form.set("file", await audioFileBlob(file), path.basename(file.filePath || file.realPath || "audio.wav"));
    const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials?.apiKey || ""}`,
      },
      body: form,
    });
    const body = await parseJsonResponse(response);
    assertOk(response, body, "OpenAI transcription failed");
    return {
      text: String(body.text || "").trim(),
      ...(input.language ? { language: input.language } : {}),
    };
  },
};

export const mimoSpeechRecognitionAdapter = {
  id: "mimo",
  name: "MiMo Speech Recognition",
  protocolId: "mimo-chat-completions-asr",
  types: ["speechRecognition"],
  async transcribe(input) {
    const fetchImpl = resolveFetch(input);
    const baseUrl = trimTrailingSlash(input.credentials?.baseUrl || input.provider?.baseUrl || "https://api.xiaomimimo.com/v1");
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "api-key": input.credentials?.apiKey || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model.id,
        messages: [audioChatMessage(audioDataUrl(input.file))],
        asr_options: {
          language: input.language || "auto",
        },
      }),
    });
    const body = await parseJsonResponse(response);
    assertOk(response, body, "MiMo transcription failed");
    return {
      text: extractChatCompletionText(body),
      language: input.language || "auto",
    };
  },
};

export const dashscopeSpeechRecognitionAdapter = {
  id: "dashscope",
  name: "DashScope Qwen ASR",
  protocolId: "dashscope-qwen-asr-chat",
  types: ["speechRecognition"],
  async transcribe(input) {
    const fetchImpl = resolveFetch(input);
    const baseUrl = trimTrailingSlash(input.credentials?.baseUrl || input.provider?.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1");
    const asrOptions = {
      ...(input.language ? { language: input.language } : {}),
      enable_itn: false,
    };
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.credentials?.apiKey || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model.id,
        messages: [audioChatMessage(audioDataUrl(input.file))],
        stream: false,
        asr_options: asrOptions,
      }),
    });
    const body = await parseJsonResponse(response);
    assertOk(response, body, "DashScope transcription failed");
    return {
      text: extractChatCompletionText(body),
      ...(input.language ? { language: input.language } : {}),
    };
  },
};

export const volcengineSpeechRecognitionAdapter = {
  id: "volcengine-speech",
  name: "Volcengine BigASR Speech Recognition",
  protocolId: "volcengine-bigasr-transcription",
  types: ["speechRecognition"],
  async transcribe(input) {
    const fetchImpl = resolveFetch(input);
    const baseUrl = trimTrailingSlash(input.credentials?.baseUrl || input.provider?.baseUrl || "https://openspeech.bytedance.com");
    const apiKey = input.credentials?.apiKey || "";
    const response = await fetchImpl(`${baseUrl}/api/v3/auc/bigmodel/recognize/flash`, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Sequence": "-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user: { uid: apiKey },
        audio: { data: audioBase64(input.file) },
        request: {
          model_name: "bigmodel",
        },
      }),
    });
    const body = await parseJsonResponse(response);
    const statusCode = response.headers?.get?.("X-Api-Status-Code");
    if (statusCode && statusCode !== "20000000") {
      throw new Error(`Volcengine transcription failed: ${statusCode}`);
    }
    assertOk(response, body, "Volcengine transcription failed");
    return {
      text: String(body?.result?.text || "").trim(),
      ...(Number.isFinite(Number(body?.audio_info?.duration)) ? { durationMs: Number(body.audio_info.duration) } : {}),
      ...(input.language ? { language: input.language } : {}),
    };
  },
};

export const builtinSpeechRecognitionAdapters = [
  openaiSpeechRecognitionAdapter,
  mimoSpeechRecognitionAdapter,
  dashscopeSpeechRecognitionAdapter,
  volcengineSpeechRecognitionAdapter,
];

function resolveFetch(input) {
  if (typeof input.fetch === "function") return input.fetch;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("fetch is unavailable for speech recognition adapter");
}

async function audioFileBlob(file) {
  const filePath = file?.realPath || file?.filePath;
  if (!filePath) throw new Error("audio file path is required");
  const bytes = fs.readFileSync(filePath);
  return new Blob([bytes], { type: file.mime || DEFAULT_MIME });
}

function audioBase64(file) {
  const filePath = file?.realPath || file?.filePath;
  if (!filePath) throw new Error("audio file path is required");
  return fs.readFileSync(filePath).toString("base64");
}

function audioDataUrl(file) {
  return `data:${file?.mime || DEFAULT_MIME};base64,${audioBase64(file)}`;
}

function audioChatMessage(dataUrl) {
  return {
    role: "user",
    content: [{
      type: "input_audio",
      input_audio: { data: dataUrl },
    }],
  };
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function assertOk(response, body, fallbackMessage) {
  if (response.ok) return;
  const message = body?.error?.message || body?.message || body?.error || fallbackMessage;
  throw new Error(String(message));
}

function extractChatCompletionText(body) {
  const text = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.delta?.content ?? "";
  return String(text).trim();
}
