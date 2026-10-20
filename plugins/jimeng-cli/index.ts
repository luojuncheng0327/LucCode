/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createJimengImageAdapter,
  createJimengVideoAdapter,
} from "./adapters/dreamina.ts";
import {
  createDreaminaCapabilityDiscovery,
  resolveDreaminaExecutable,
} from "./lib/dreamina-capabilities.ts";

export default class JimengCliPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("jimeng-cli plugin loaded without event bus");
      return;
    }

    const resolveCommand = () => resolveDreaminaExecutable();
    const discovery = createDreaminaCapabilityDiscovery({ resolveCommand });
    const source = {
      refresh: (options: any) => discovery.refresh(options),
    };
    const sourceResult = await bus.request("provider:register-runtime-media-capability-source", {
      providerId: "jimeng-cli",
      source,
    });
    if (sourceResult?.ok === false) {
      throw new Error(sourceResult.error || "failed to register jimeng-cli runtime capabilities");
    }
    this.register?.(() => {
      bus.request("provider:unregister-runtime-media-capability-source", {
        providerId: "jimeng-cli",
      }).catch(() => {});
    });

    const getCapabilitySnapshot = (options: any) => discovery.refresh(options);
    const adapters = [
      createJimengImageAdapter({ resolveCommand, getCapabilitySnapshot }),
      createJimengVideoAdapter({ resolveCommand, getCapabilitySnapshot }),
    ];

    for (const adapter of adapters) {
      const result = await bus.request("media-gen:register-adapter", { adapter });
      if (result?.ok === false) {
        throw new Error(result.error || `failed to register ${adapter.id}`);
      }
      log?.info?.(`jimeng-cli adapter registered: ${adapter.id}`);
      this.register?.(() => {
        bus.request("media-gen:unregister-adapter", { adapterId: adapter.id }).catch(() => {});
      });
    }
  }
}
