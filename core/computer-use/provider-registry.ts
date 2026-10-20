import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.ts";
import { normalizeComputerProvider } from "./provider-contract.ts";

export class ComputerProviderRegistry {
  declare _providers: Map<string, any>;

  constructor() {
    this._providers = new Map();
  }

  register(provider: any) {
    provider = normalizeComputerProvider(provider);
    if (this._providers.has(provider.providerId)) {
      throw new Error(`Computer provider already registered: ${provider.providerId}`);
    }
    this._providers.set(provider.providerId, provider);
  }

  get(providerId: string) {
    return this._providers.get(providerId) || null;
  }

  has(providerId: string) {
    return this._providers.has(providerId);
  }

  require(providerId: string) {
    const provider = this.get(providerId);
    if (!provider) {
      throw computerUseError(COMPUTER_USE_ERRORS.PROVIDER_UNAVAILABLE, `Computer provider unavailable: ${providerId}`, { providerId });
    }
    return provider;
  }

  list() {
    return [...this._providers.values()];
  }
}
