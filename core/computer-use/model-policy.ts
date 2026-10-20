import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.ts";
import { modelSupportsDirectImageInput } from "../../shared/model-capabilities.ts";

export function modelSupportsComputerUse(model) {
  return modelSupportsDirectImageInput(model);
}

export function assertComputerUseModelSupported(model) {
  if (modelSupportsComputerUse(model)) return;
  throw computerUseError(
    COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL,
    "Computer Use requires a model with image input support.",
    {
      modelId: model?.id || null,
      provider: model?.provider || null,
      input: Array.isArray(model?.input) ? model.input : null,
    },
  );
}
