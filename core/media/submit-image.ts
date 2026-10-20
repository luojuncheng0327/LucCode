import {
  bridgeDeliveryTarget,
  buildImageParams,
  createSubmitContext,
  createTaskId,
  imageDeferredMeta,
  isResponseDelivery,
  normalizeSessionRef,
  normalizeMediaDelivery,
  assertAdapterReferenceImageLimit,
  resolveImageTarget,
  runSubmitInBackground,
} from "./image-task-runner.ts";
import { resolveMediaParameters } from "./media-parameters.ts";
import { t } from "../../lib/i18n.ts";

function assertMediaRuntime(ctx) {
  const { registry, store, poller } = ctx?._mediaGen || {};
  if (!registry || !store || !poller) {
    throw new Error(t("plugin.imageGen.notInitialized"));
  }
  return { registry, store, poller };
}

export async function submitImageGeneration({ input = {}, ctx, metadata = null, deliveryTarget = undefined }: any = {}) {
  const { registry, store, poller } = assertMediaRuntime(ctx);
  const sessionTarget = normalizeSessionRef(ctx);
  const { sessionId, sessionPath, sessionRef } = sessionTarget;
  const delivery = normalizeMediaDelivery(input);
  const responseDelivery = isResponseDelivery(delivery);
  if (!sessionId && !sessionPath && !responseDelivery) {
    throw new Error(t("plugin.imageGen.noSessionPath"));
  }

  const submitCtx = createSubmitContext(ctx);
  const target = await resolveImageTarget(input, registry, submitCtx);
  const adapter = target?.adapter || null;
  if (!adapter) throw new Error(t("plugin.imageGen.noProvider"));
  const adapterSubmitCtx = registry.createSubmitContextForAdapter?.(adapter, submitCtx) || submitCtx;

  const count = Math.min(Math.max(input.count || 1, 1), 9);
  const batchId = createTaskId();
  const providerDefaults = submitCtx.config?.get?.("providerDefaults")?.[target.providerId] || {};
  const parameterResolution = resolveMediaParameters({
    kind: "image",
    input,
    providerId: target.providerId,
    model: target.model,
    providerDefaults,
  });
  const params = {
    ...parameterResolution.resolvedParameters,
    ...buildImageParams(input),
    mode: parameterResolution.modeId,
    resolvedParameters: parameterResolution.resolvedParameters,
    providerId: target.providerId,
    ...(target.modelId ? { modelId: target.modelId, model: target.modelId } : {}),
    ...(target.protocolId ? { protocolId: target.protocolId } : {}),
    ...(target.credentialLaneId ? { credentialLaneId: target.credentialLaneId } : {}),
    ...(target.credentialProviderId ? { credentialProviderId: target.credentialProviderId } : {}),
  };
  assertAdapterReferenceImageLimit(adapter, params);

  const resolvedDeliveryTarget = responseDelivery
    ? null
    : deliveryTarget === undefined ? bridgeDeliveryTarget(ctx) : deliveryTarget;
  const deferredMeta = {
    ...imageDeferredMeta({ prompt: input.prompt, deliveryTarget: resolvedDeliveryTarget }),
    ...(metadata ? { metadata } : {}),
  };

  const submitted = [];
  for (let i = 0; i < count; i++) {
    const taskId = createTaskId();
    store.add({
      taskId,
      adapterId: adapter.id,
      providerId: target.providerId,
      modelId: target.modelId,
      protocolId: target.protocolId,
      credentialLaneId: target.credentialLaneId,
      batchId,
      type: "image",
      prompt: input.prompt,
      params,
      sessionId,
      sessionPath,
      sessionRef,
      deliveryMode: delivery.mode,
      delivery,
      ...(resolvedDeliveryTarget ? { deliveryTarget: resolvedDeliveryTarget } : {}),
      ...(metadata ? { metadata } : {}),
      submitState: "submitting",
      adapterTaskId: null,
    });

    if (!responseDelivery) {
      try {
        await ctx.bus.request("deferred:register", {
          taskId,
          sessionId,
          sessionPath,
          sessionRef,
          meta: deferredMeta,
        });
      } catch (err) {
        ctx.log?.warn?.(`deferred:register failed for ${taskId}:`, err);
      }

      try {
        await ctx.bus.request("task:register", {
          taskId,
          type: "media-generation",
          sessionId,
          sessionRef,
          parentSessionPath: sessionPath,
          meta: deferredMeta,
        });
      } catch {
        // TaskRegistry is best-effort visibility; generation delivery still uses deferred results.
      }
    }

    poller.add(taskId);
    submitted.push({ taskId });

    void runSubmitInBackground({
      taskId,
      adapter,
      params,
      submitCtx: adapterSubmitCtx,
      store,
      poller,
      ctx,
    });
  }

  return {
    ok: true,
    kind: "image",
    batchId,
    prompt: input.prompt,
    delivery,
    tasks: submitted,
  };
}
