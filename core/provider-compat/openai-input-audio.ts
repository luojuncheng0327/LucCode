/**
 * OpenAI input_audio compatibility.
 *
 * Delete condition: remove this module when Pi SDK serializes local audio
 * attachments as input_audio parts for OpenAI Chat Completions audio models.
 */
import {
  MODEL_AUDIO_TRANSPORTS,
  resolveModelAudioInputTransport,
} from "../../shared/model-capabilities.ts";
import { normalizeOpenAIInputAudioPayload } from "./input-audio.ts";

export function matches(model) {
  return resolveModelAudioInputTransport(model) === MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO;
}

export function apply(payload) {
  return normalizeOpenAIInputAudioPayload(payload);
}
