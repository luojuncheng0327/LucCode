/**
 * ExecutionRouter -- per-agent 角色路由
 *
 * 职责：
 *   - 将 agent 的角色配置（chat/utility/embed 等）解析为执行所需的完整参数
 *   - 输入：role 名称 + agentConfig
 *   - 输出：{ model, provider, api, apiKey, baseUrl, headers }
 *   - 完全不参与模型注册逻辑（这是路由层，不是管理层）
 *
 * 角色路由配置存储格式（preferences.json / config.yaml）：
 *   models.chat           -> "provider/model" 或裸 modelId（向后兼容）
 *   models.utility        -> 同上
 *   models.utility_large  -> 同上
 *   models.embed          -> 同上
 *
 * 设计来源：Luc 自己的三通道 API 概念（两个参考项目都没有）
 */

import { t } from "../lib/i18n.ts";
import { isLocalBaseUrl } from "../shared/net-utils.ts";
import { composeResolvedModelExecution } from "./model-execution-config.ts";

// 角色名称 -> preferences 字段名（SHARED_MODEL_KEYS 兼容）
const ROLE_TO_PREF_KEY = {
  utility: "utility_model",
  utility_large: "utility_large_model",
};

function withCredentialMetadata(model: any, cred: any) {
  const stripsModelCredentials = cred?.credentialSource === "auth-storage"
    || cred?.credentialSource === "explicit-utility-override";
  const modelBase = stripsModelCredentials
    ? (() => {
        const {
          headers: _headers,
          accountId: _accountId,
          account_id: _accountIdSnake,
          accountID: _accountIdLegacy,
          ...rest
        } = model || {};
        return rest;
      })()
    : model;
  const headers = cred?.headers && typeof cred.headers === "object" ? cred.headers : {};
  const next = Object.keys(headers).length > 0
    ? { ...modelBase, headers: { ...(modelBase.headers || {}), ...headers } }
    : modelBase;
  return cred?.accountId ? { ...next, accountId: cred.accountId } : next;
}

function hasCredentialHeaders(cred: any) {
  return !!cred?.headers && typeof cred.headers === "object" && Object.keys(cred.headers).length > 0;
}

function normalizeExecutionCredential(cred: any) {
  if (!cred || typeof cred !== "object") return null;
  return {
    api: cred.api || "",
    apiKey: cred.apiKey ?? cred.api_key ?? "",
    baseUrl: cred.baseUrl ?? cred.base_url ?? "",
    headers: cred.headers && typeof cred.headers === "object" ? cred.headers : {},
    ...(cred.credentialSource || cred.credential_source
      ? { credentialSource: cred.credentialSource || cred.credential_source }
      : {}),
    ...(cred.accountId ? { accountId: cred.accountId } : {}),
  };
}

function hasUtilityApiOverride(utilApiOverride: any) {
  return !!(
    utilApiOverride?.provider
    || utilApiOverride?.api_key
    || utilApiOverride?.base_url
  );
}

export class ExecutionRouter {
  declare _resolveModel: (ref: string) => any;
  declare _resolveProviderCredentialsFresh: any;
  declare _providerRegistry: any;

  /**
   * @param {(ref: string) => object|null} resolveModel - 从 _availableModels 解析模型的函数
   * @param {import('./provider-registry.ts').ProviderRegistry} providerRegistry
   */
  constructor(resolveModel: any, providerRegistry: any, resolveProviderCredentialsFresh: any = null) {
    this._resolveModel = resolveModel;
    this._providerRegistry = providerRegistry;
    this._resolveProviderCredentialsFresh = resolveProviderCredentialsFresh;
  }

  _resolveUtilityModels(agentConfig, sharedModels, options: any = {}) {
    const cfg = agentConfig || {};
    const requireUtilityLarge = options?.requireUtilityLarge !== false;
    const chatModelRef = cfg.models?.chat || null;
    const utilityModelRef = sharedModels?.utility || cfg.models?.utility || chatModelRef;
    const largeModelRef = sharedModels?.utility_large || cfg.models?.utility_large || chatModelRef;

    if (!utilityModelRef) throw new Error(t("error.noUtilityModel"));
    if (requireUtilityLarge && !largeModelRef) throw new Error(t("error.noUtilityLargeModel"));

    const utilModel = this._resolveModel(utilityModelRef);
    if (!utilModel) throw new Error(t("error.modelNotFound", { id: utilityModelRef }));
    const largeModel = largeModelRef ? this._resolveModel(largeModelRef) : null;
    if (largeModelRef && !largeModel) throw new Error(t("error.modelNotFound", { id: largeModelRef }));
    return { utilityModelRef, largeModelRef, utilModel, largeModel };
  }

  async _freshCredentials(provider) {
    if (typeof this._resolveProviderCredentialsFresh !== "function") {
      throw new Error(`Fresh credential resolver is required for provider "${provider}"`);
    }
    return normalizeExecutionCredential(await this._resolveProviderCredentialsFresh(provider));
  }

  /**
   * 解析角色 -> 完整执行参数
   *
   * @param {string} roleOrRef
   *   角色名（"chat"/"utility"/"utility_large"/"embed"）
   *   或直接是模型引用（"provider/model" 或裸 modelId）
   * @param {object} agentConfig - agent config 对象（来自 config.yaml）
   * @param {object} [sharedModels] - 全局共享角色模型（来自 preferences）
   * @param {object} [utilApiOverride] - utility API 覆盖（来自 preferences）
   * @returns {{ modelId: string, providerId: string, api: string, apiKey: string, baseUrl: string }}
   * @throws 找不到模型或凭证时抛出
   */
  resolve(roleOrRef, agentConfig, sharedModels, utilApiOverride) {
    const modelRef = this._resolveRef(roleOrRef, agentConfig, sharedModels);
    if (!modelRef) {
      throw new Error(t("error.noUtilityModel") + ` (role: ${roleOrRef})`);
    }

    const model = this._resolveModel(modelRef);
    if (!model) {
      throw new Error(t("error.modelNotFound", { id: modelRef }));
    }

    // utility API 覆盖：只在 utility/utility_large 角色时生效
    const isUtilityRole = roleOrRef === "utility" || roleOrRef === "utility_large";
    if (isUtilityRole && utilApiOverride?.api_key) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== model.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: modelRef }));
      }
      const overrideCred = this._providerRegistry.getCredentials(model.provider);
      const effectiveApi = model.api || overrideCred?.api;
      if (!effectiveApi) {
        throw new Error(t("error.providerMissingApi", { provider: model.provider }));
      }
      return {
        modelId: model.id,
        providerId: model.provider,
        api: effectiveApi,
        apiKey: utilApiOverride.api_key,
        baseUrl: utilApiOverride.base_url || model.baseUrl,
        headers: overrideCred?.headers || {},
      };
    }

    const cred = this._providerRegistry.getCredentials(model.provider);
    if (!cred) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }
    const effectiveApi = model.api || cred.api;
    if (!effectiveApi) {
      throw new Error(t("error.providerMissingApi", { provider: model.provider }));
    }
    if (!cred.baseUrl || (!cred.apiKey && !hasCredentialHeaders(cred) && !this._allowsMissingApiKey(model.provider, cred.baseUrl))) {
      throw new Error(t("error.providerMissingCreds", { provider: model.provider }));
    }

    return {
      modelId: model.id,
      providerId: model.provider,
      api: effectiveApi,
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      headers: cred.headers || {},
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
    };
  }

  /**
   * resolveUtilityConfig：解析 utility / utility_large 模型 + 凭证。
   *
   * 返回值的 utility / utility_large 字段是**完整 model 对象**（不再是裸 id 字符串）。
   * 所有 callText 调用方解构出 model 后直接传给 callText，由 callText 内部走 provider-compat。
   *
   * 显示用途（如 server banner）取 .id 字段：utilConfig.utility?.id。
   *
   * @param {object} agentConfig
   * @param {{ utility?: string|object, utility_large?: string|object }} sharedModels
   * @param {{ provider?: string, api_key?: string, base_url?: string }} utilApiOverride
   * @param {{ requireUtilityLarge?: boolean }} options
   * @returns {{
   *   utility: object,
   *   utility_large: object|null,
   *   api_key: string, base_url: string, api: string,
   *   large_api_key: string, large_base_url: string, large_api: string,
   * }}
   */
  resolveUtilityConfig(agentConfig, sharedModels, utilApiOverride, options: any = {}) {
    const { utilityModelRef, utilModel, largeModel } = this._resolveUtilityModels(
      agentConfig,
      sharedModels,
      options,
    );

    // utility 凭证
    let apiKey, baseUrl, api, utilCred;
    if (hasUtilityApiOverride(utilApiOverride)) {
      // 校验 provider 一致性（与原 ModelManager.resolveUtilityConfig 行为一致）
      if (utilApiOverride.provider && utilApiOverride.provider !== utilModel.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModelRef }));
      }
      // utility API 覆盖（用户指定了独立的 utility api endpoint）
      utilCred = this._providerRegistry.getCredentials(utilModel.provider);
      api = utilModel.api || utilCred?.api;
      apiKey = utilApiOverride.api_key || "";
      baseUrl = utilApiOverride.base_url || "";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!baseUrl || (!apiKey && !hasCredentialHeaders(utilCred) && !this._allowsMissingApiKey(utilModel.provider, baseUrl))) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilModel.provider }));
      }
    } else {
      utilCred = this._providerRegistry.getCredentials(utilModel.provider);
      api = utilModel.api || utilCred?.api;
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!utilCred?.baseUrl || (!utilCred.apiKey && !hasCredentialHeaders(utilCred) && !this._allowsMissingApiKey(utilModel.provider, utilCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: utilModel.provider }));
      }
      apiKey = utilCred.apiKey;
      baseUrl = utilCred.baseUrl;
    }

    // utility_large 凭证（provider 相同则复用）
    let large_api_key = largeModel ? apiKey : null;
    let large_base_url = largeModel ? baseUrl : null;
    let large_api = largeModel ? (largeModel.api || api) : null;
    let largeCred = largeModel ? utilCred : null;
    if (largeModel && largeModel.provider !== utilModel.provider) {
      largeCred = this._providerRegistry.getCredentials(largeModel.provider);
      large_api = largeModel.api || largeCred?.api;
      if (!large_api) throw new Error(t("error.providerMissingApi", { provider: largeModel.provider }));
      if (!largeCred?.baseUrl || (!largeCred.apiKey && !hasCredentialHeaders(largeCred) && !this._allowsMissingApiKey(largeModel.provider, largeCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: largeModel.provider }));
      }
      large_api_key = largeCred.apiKey;
      large_base_url = largeCred.baseUrl;
    }

    return {
      utility: withCredentialMetadata(utilModel, utilCred),
      utility_large: largeModel ? withCredentialMetadata(largeModel, largeCred) : null,
      api_key: apiKey,
      base_url: baseUrl,
      api,
      large_api_key,
      large_base_url,
      large_api,
    };
  }

  /**
   * 请求边界专用的 utility 解析。模型选择仍是同步、Luc-owned；只有凭证读取
   * 进入异步 fresh resolver。显式 utility API override 完整保留，并跳过其
   * provider 的 OAuth refresh。
   */
  async resolveUtilityConfigFresh(agentConfig, sharedModels, utilApiOverride, options: any = {}) {
    const { utilityModelRef, utilModel, largeModel } = this._resolveUtilityModels(
      agentConfig,
      sharedModels,
      options,
    );
    const usesOverride = hasUtilityApiOverride(utilApiOverride);

    let utilCred;
    let apiKey;
    let baseUrl;
    let api;
    if (usesOverride) {
      if (utilApiOverride.provider && utilApiOverride.provider !== utilModel.provider) {
        throw new Error(t("error.utilityApiProviderMismatch", { model: utilityModelRef }));
      }
      utilCred = {
        api: this._providerRegistry.get(utilModel.provider)?.api || "",
        apiKey: "",
        baseUrl: "",
        headers: {},
        credentialSource: "explicit-utility-override",
      };
      api = utilModel.api || utilCred.api;
      apiKey = utilApiOverride.api_key || "";
      baseUrl = utilApiOverride.base_url || "";
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!baseUrl || (!apiKey && !hasCredentialHeaders(utilCred) && !this._allowsMissingApiKey(utilModel.provider, baseUrl))) {
        throw new Error(t("error.utilityApiMissingCreds", { provider: utilModel.provider }));
      }
    } else {
      utilCred = await this._freshCredentials(utilModel.provider);
      api = utilModel.api || utilCred?.api;
      if (!api) throw new Error(t("error.providerMissingApi", { provider: utilModel.provider }));
      if (!utilCred?.baseUrl || (!utilCred.apiKey && !hasCredentialHeaders(utilCred) && !this._allowsMissingApiKey(utilModel.provider, utilCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: utilModel.provider }));
      }
      apiKey = utilCred.apiKey;
      baseUrl = utilCred.baseUrl;
    }

    let large_api_key = largeModel ? apiKey : null;
    let large_base_url = largeModel ? baseUrl : null;
    let large_api = largeModel ? (largeModel.api || api) : null;
    let largeCred = largeModel ? utilCred : null;
    if (largeModel && largeModel.provider !== utilModel.provider) {
      largeCred = await this._freshCredentials(largeModel.provider);
      large_api = largeModel.api || largeCred?.api;
      if (!large_api) throw new Error(t("error.providerMissingApi", { provider: largeModel.provider }));
      if (!largeCred?.baseUrl || (!largeCred.apiKey && !hasCredentialHeaders(largeCred) && !this._allowsMissingApiKey(largeModel.provider, largeCred.baseUrl))) {
        throw new Error(t("error.providerMissingCreds", { provider: largeModel.provider }));
      }
      large_api_key = largeCred.apiKey;
      large_base_url = largeCred.baseUrl;
    }

    const utilExecution = composeResolvedModelExecution({ model: utilModel, credential: utilCred });
    const largeExecution = largeModel
      ? composeResolvedModelExecution({ model: largeModel, credential: largeCred })
      : null;

    return {
      utility: utilExecution.model,
      utility_large: largeExecution?.model || null,
      api_key: apiKey,
      base_url: baseUrl,
      api,
      headers: utilExecution.headers,
      large_api_key,
      large_base_url,
      large_api,
      large_headers: largeExecution?.headers || null,
    };
  }

  /**
   * 将角色名或模型引用解析为实际模型 ref 字符串
   * @private
   */
  _resolveRef(roleOrRef, agentConfig, sharedModels) {
    const cfg = agentConfig || {};

    // 内置角色名的查找顺序：sharedModels -> agentConfig.models
    switch (roleOrRef) {
      case "chat":
        return cfg.models?.chat || null;
      case "utility":
        return sharedModels?.utility || cfg.models?.utility || null;
      case "utility_large":
        return sharedModels?.utility_large || cfg.models?.utility_large || null;
      case "embed":
        return cfg.embedding_api?.model || null;
      default:
        // 不是内置角色名，当作模型引用直接用
        return roleOrRef;
    }
  }

  _allowsMissingApiKey(provider, baseUrl) {
    return this._providerRegistry?.allowsMissingApiKey?.(provider, baseUrl)
      ?? isLocalBaseUrl(baseUrl);
  }
}
