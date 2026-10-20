import { MediaAdapterRegistry } from "./media-adapter-registry.ts";
import { builtinSpeechRecognitionAdapters } from "./speech-recognition/adapters.ts";
import { createModuleLogger } from "../lib/debug-log.ts";

const CAPABILITY = "speech_recognition";

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionRef(input: any = {}) {
  const rawRef = input.sessionRef && typeof input.sessionRef === "object" ? input.sessionRef : null;
  const sessionId = textOrNull(input.sessionId) || textOrNull(rawRef?.sessionId);
  const sessionPath =
    textOrNull(input.sessionPath)
    || textOrNull(rawRef?.sessionPath)
    || textOrNull(rawRef?.path);
  const legacySessionPath =
    textOrNull(input.legacySessionPath)
    || textOrNull(rawRef?.legacySessionPath)
    || (sessionId && sessionPath ? sessionPath : null);
  const sessionRef = sessionId
    ? {
      sessionId,
      ...(sessionPath ? { sessionPath } : {}),
      ...(legacySessionPath ? { legacySessionPath } : {}),
    }
    : null;
  return { sessionId, sessionPath, sessionRef };
}
const log = createModuleLogger("speech-recognition");

export class SpeechRecognitionService {
  declare _emitEvent: any;
  declare _fetch: any;
  declare _logger: any;
  declare _prefs: any;
  declare _providers: any;
  declare _registry: any;
  declare _sessionFiles: any;
  constructor({
    providerRegistry,
    preferences,
    sessionFiles,
    emitEvent,
    fetch,
    logger = log,
    adapters = builtinSpeechRecognitionAdapters,
  }: any = {}) {
    if (!providerRegistry) throw new Error("SpeechRecognitionService requires providerRegistry");
    if (!preferences) throw new Error("SpeechRecognitionService requires preferences");
    if (!sessionFiles) throw new Error("SpeechRecognitionService requires sessionFiles");
    this._providers = providerRegistry;
    this._prefs = preferences;
    this._sessionFiles = sessionFiles;
    this._emitEvent = typeof emitEvent === "function" ? emitEvent : () => {};
    this._fetch = fetch;
    this._logger = logger;
    this._registry = new MediaAdapterRegistry();
    for (const adapter of adapters || []) this.registerAdapter(adapter);
  }

  registerAdapter(adapter) {
    this._registry.register(adapter);
  }

  unregisterAdapter(adapterId) {
    this._registry.unregister(adapterId);
  }

  hasAdapterForModel(providerId, model) {
    if (!model?.protocolId) return false;
    return Boolean(this._registry.getProtocol(model.protocolId) || this._registry.get(providerId));
  }

  listProviders() {
    const next: any = {};
    for (const provider of this._providers.getMediaProviders(CAPABILITY) || []) {
      const providerId = provider.providerId;
      const models = (provider.models || [])
        .map((model) => ({
          ...model,
          adapterAvailable: this.hasAdapterForModel(providerId, model),
        }))
        .filter((model) => model.adapterAvailable);
      if (!models.length) continue;
      const credentialStatus = this._providers.getMediaProviderCredentialStatus?.(providerId, CAPABILITY) || {};
      next[providerId] = {
        ...provider,
        ...credentialStatus,
        models,
        availableModels: models.map((model) => ({
          id: model.id,
          name: model.displayName || model.name || model.id,
        })),
      };
    }
    return {
      providers: next,
      config: this.getConfig(),
    };
  }

  getConfig() {
    return this._prefs.getSpeechRecognitionConfig?.() || { enabled: false };
  }

  setConfig(patch) {
    const next = normalizeSpeechRecognitionConfigPatch(patch, this.getConfig());
    if (next.defaultModel) {
      const listed = this.listProviders().providers;
      const provider = listed[next.defaultModel.provider];
      if (!provider?.models?.some((model) => model.id === next.defaultModel.id)) {
        throw new Error("speech recognition default model is unavailable");
      }
    }
    return this._prefs.setSpeechRecognitionConfig?.(next) || next;
  }

  async queueVoiceTranscription({ sessionId, sessionPath, sessionRef, fileId, language }: any = {}) {
    Promise.resolve()
      .then(() => this.transcribeVoiceAttachment({ sessionId, sessionPath, sessionRef, fileId, language }))
      .catch((err) => {
        this._logger?.warn?.(`voice transcription queue failed for ${fileId || "(missing fileId)"}: ${err?.message || err}`);
      });
  }

  async transcribeAudio(payload: any = {}) {
    const {
      fileId,
      language,
      providerId,
      provider,
      modelId,
      model,
    } = payload;
    const sessionTarget = normalizeSessionRef(payload);
    const { sessionId, sessionPath, sessionRef } = sessionTarget;
    if ((!sessionId && !sessionPath) || !fileId) {
      throw new Error("sessionId or sessionPath and fileId are required for audio transcription");
    }

    const file = this._sessionFiles.get(fileId, { sessionId, sessionPath });
    if (!file) throw new Error(`session file not found: ${fileId}`);

    const providerRef = providerId || provider || null;
    const modelRef = modelId || model || null;
    const config = this.getConfig();
    const defaultModel = config.defaultModel || null;
    const targetProvider = providerRef || defaultModel?.provider || null;
    const targetModel = modelRef || defaultModel?.id || null;
    if (!targetProvider || !targetModel) {
      throw new Error("speech recognition model is not configured");
    }

    const target = this._providers.resolveMediaModel({
      providerId: targetProvider,
      modelId: targetModel,
      capability: CAPABILITY,
    });
    const adapter = this._registry.getProtocol(target.model.protocolId) || this._registry.get(target.providerId);
    if (!adapter?.transcribe) throw new Error(`No speech recognition adapter registered for protocol "${target.model.protocolId}"`);

    const pending = this._updateTranscription({ sessionId, sessionPath }, fileId, {
      status: "pending",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(language ? { language } : {}),
    });
    this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, pending.transcription);

    try {
      const credentialProviderId = target.credentialLane?.providerId || target.providerId;
      const credentials = this._providers.getCredentials(credentialProviderId) || {};
      const result = await adapter.transcribe({
        file,
        provider: target.provider,
        model: target.model,
        credentials,
        language,
        fetch: this._fetch,
      });
      const ready = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "ready",
        text: result.text || "",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(result.language ? { language: result.language } : language ? { language } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, ready.transcription);
      return ready.transcription;
    } catch (err) {
      const failed = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "failed",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(language ? { language } : {}),
        error: err?.message || String(err),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, failed.transcription);
      return failed.transcription;
    }
  }

  async transcribeVoiceAttachment(payload: any = {}) {
    const { fileId, language } = payload;
    const sessionTarget = normalizeSessionRef(payload);
    const { sessionId, sessionPath, sessionRef } = sessionTarget;
    const config = this.getConfig();
    if (!config.enabled || !config.defaultModel) return { status: "skipped", reason: "disabled" };
    if ((!sessionId && !sessionPath) || !fileId) {
      throw new Error("sessionId or sessionPath and fileId are required for voice transcription");
    }

    const file = this._sessionFiles.get(fileId, { sessionId, sessionPath });
    if (!file) throw new Error(`session file not found: ${fileId}`);
    if (file.presentation !== "voice-input") return { status: "skipped", reason: "not_voice_input" };

    const target = this._providers.resolveMediaModel({
      providerId: config.defaultModel.provider,
      modelId: config.defaultModel.id,
      capability: CAPABILITY,
    });
    const adapter = this._registry.getProtocol(target.model.protocolId) || this._registry.get(target.providerId);
    if (!adapter?.transcribe) throw new Error(`No speech recognition adapter registered for protocol "${target.model.protocolId}"`);

    const pending = this._updateTranscription({ sessionId, sessionPath }, fileId, {
      status: "pending",
      providerId: target.providerId,
      modelId: target.model.id,
      protocolId: target.model.protocolId,
      ...(language ? { language } : {}),
    });
    this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, pending.transcription);

    try {
      const credentialProviderId = target.credentialLane?.providerId || target.providerId;
      const credentials = this._providers.getCredentials(credentialProviderId) || {};
      const result = await adapter.transcribe({
        file,
        provider: target.provider,
        model: target.model,
        credentials,
        language,
        fetch: this._fetch,
      });
      const ready = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "ready",
        text: result.text || "",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(result.language ? { language: result.language } : language ? { language } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, ready.transcription);
      return ready.transcription;
    } catch (err) {
      const failed = this._updateTranscription({ sessionId, sessionPath }, fileId, {
        status: "failed",
        providerId: target.providerId,
        modelId: target.model.id,
        protocolId: target.model.protocolId,
        ...(language ? { language } : {}),
        error: err?.message || String(err),
      });
      this._emitTranscriptionUpdate({ sessionId, sessionPath, sessionRef }, fileId, failed.transcription);
      return failed.transcription;
    }
  }

  _updateTranscription(sessionRef, fileId, transcription) {
    return this._sessionFiles.updateTranscription(fileId, transcription, sessionRef);
  }

  _emitTranscriptionUpdate(sessionRef, fileId, transcription) {
    const { sessionId, sessionPath } = normalizeSessionRef(sessionRef);
    this._emitEvent({
      type: "voice_transcription_update",
      ...(sessionId ? { sessionId } : {}),
      sessionPath,
      fileId,
      transcription,
    }, sessionPath);
  }
}

function normalizeSpeechRecognitionConfigPatch(patch, current: any = {}) {
  const body = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    next.enabled = body.enabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(body, "defaultModel")) {
    const value = body.defaultModel;
    if (value === null || value === undefined) {
      delete next.defaultModel;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      const id = typeof value.id === "string" ? value.id.trim() : "";
      if (!provider || !id) throw new Error("speechRecognition.defaultModel requires provider and id");
      next.defaultModel = { provider, id };
    } else {
      throw new Error("speechRecognition.defaultModel must be an object");
    }
  }
  if (!next.enabled) {
    return {
      enabled: false,
      ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
    };
  }
  return {
    enabled: true,
    ...(next.defaultModel ? { defaultModel: next.defaultModel } : {}),
  };
}
