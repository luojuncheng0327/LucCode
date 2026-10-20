import {
  mergeProviderHeaders,
  stripCredentialHeaders,
} from "../shared/provider-auth.ts";

function normalizedCredential(credential: any = {}) {
  const credentialSource = credential.credentialSource || credential.credential_source || "";
  return {
    api: credential.api || "",
    apiKey: credential.apiKey ?? credential.api_key ?? "",
    baseUrl: credential.baseUrl ?? credential.base_url ?? "",
    headers: credential.headers && typeof credential.headers === "object" ? credential.headers : {},
    credentialSource,
    accountId: credential.accountId || credential.account_id || credential.accountID || "",
  };
}

function modelWithoutCredentialMetadata(model: any) {
  const clean = { ...(model || {}) };
  delete clean.headers;
  delete clean.accountId;
  delete clean.account_id;
  delete clean.accountID;
  return clean;
}

/**
 * Pure composition boundary for a selected Luc model and its resolved provider
 * credential lane. It does not read registry state or refresh credentials.
 */
export function composeResolvedModelExecution({
  model,
  credential,
}: {
  model: any;
  credential?: any;
}) {
  const cred = normalizedCredential(credential);
  const provider = model?.provider || "";
  const stripsModelCredentials = cred.credentialSource === "auth-storage"
    || cred.credentialSource === "explicit-utility-override";

  let headers = cred.credentialSource === "explicit-utility-override"
    ? {}
    : mergeProviderHeaders(cred.headers, model?.headers);
  if (cred.credentialSource === "auth-storage") {
    headers = stripCredentialHeaders(headers);
  }

  const cleanModel = stripsModelCredentials ? modelWithoutCredentialMetadata(model) : model;
  const modelBaseUrl = model?.baseUrl ?? model?.base_url ?? "";
  // Selected models are normalized after provider catalog loading, so their
  // protocol/base URL is the execution contract. Credential metadata only
  // owns the endpoint when it is inherently dynamic (OAuth resourceUrl) or an
  // explicit utility override chosen by the user.
  const credentialOwnsEndpoint = cred.credentialSource === "auth-storage"
    || cred.credentialSource === "explicit-utility-override";
  const baseUrl = credentialOwnsEndpoint
    ? (cred.baseUrl || modelBaseUrl)
    : (modelBaseUrl || cred.baseUrl);
  const hasCredentialHeaders = Object.keys(cred.headers).length > 0;
  const canReuseModel = !stripsModelCredentials && !hasCredentialHeaders && !cred.accountId;
  let resolvedModel = canReuseModel
    ? model
    : {
        ...cleanModel,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(cred.accountId ? { accountId: cred.accountId } : {}),
      };
  if (Object.keys(headers).length === 0 && resolvedModel?.headers) {
    resolvedModel = { ...resolvedModel };
    delete resolvedModel.headers;
  }

  return {
    model: resolvedModel,
    provider,
    api: model?.api || cred.api,
    apiKey: cred.apiKey,
    baseUrl,
    headers,
    ...(cred.credentialSource ? { credentialSource: cred.credentialSource } : {}),
    ...(cred.accountId ? { accountId: cred.accountId } : {}),
  };
}

/** Shape accepted directly by callText while retaining the full execution model. */
export function callTextConfigFromResolvedModel(resolved: any) {
  return {
    api: resolved?.api || "",
    apiKey: resolved?.apiKey ?? resolved?.api_key ?? "",
    baseUrl: resolved?.baseUrl ?? resolved?.base_url ?? "",
    headers: resolved?.headers && typeof resolved.headers === "object" ? resolved.headers : {},
    model: resolved?.model || null,
  };
}

/** Map either utility role from ExecutionRouter's dual-model result to callText. */
export function callTextConfigFromUtilityConfig(config: any, role = "utility") {
  if (role !== "utility" && role !== "utility_large") {
    throw new Error(`Unsupported utility role "${String(role)}"`);
  }
  const large = role === "utility_large";
  return callTextConfigFromResolvedModel({
    model: large ? config?.utility_large : config?.utility,
    api: large ? config?.large_api : config?.api,
    api_key: large ? config?.large_api_key : config?.api_key,
    base_url: large ? config?.large_base_url : config?.base_url,
    headers: large ? config?.large_headers : config?.headers,
  });
}
