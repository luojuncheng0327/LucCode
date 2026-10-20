/**
 * onboarding-actions.ts — API call logic for the onboarding wizard
 */

import { isValidAgentId } from '../../../../shared/agent-id.ts';
import { DEFAULT_HEARTBEAT_INTERVAL_MINUTES } from '../../../../shared/default-workspace-constants.ts';

export type LucFetch = (path: string, opts?: RequestInit) => Promise<Response>;

type JsonObject = Record<string, unknown>;

export interface OnboardingVerificationPlan {
  agentConfig: JsonObject;
  preferenceModels: JsonObject;
  requiredAgentSecretPaths: string[][];
}

export function createOnboardingVerificationPlan(): OnboardingVerificationPlan {
  return { agentConfig: {}, preferenceModels: {}, requiredAgentSecretPaths: [] };
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function responseError(action: string, res: Response, body: unknown): Error {
  const detail = isObject(body)
    ? (typeof body.error === 'string' && body.error.trim())
      || (typeof body.message === 'string' && body.message.trim())
    : '';
  return new Error(detail || `${action} failed with HTTP ${res.status || 'unknown'}`);
}

async function requireResponse(res: Response, action: string): Promise<unknown> {
  const body = await readJson(res);
  if (res.ok !== true) throw responseError(action, res, body);
  return body;
}

async function requireMutation(res: Response, action: string): Promise<unknown> {
  const body = await requireResponse(res, action);
  if (!isObject(body) || body.ok !== true) {
    throw new Error(`${action} was not acknowledged by the server`);
  }
  return body;
}

export function describeOnboardingError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? `${fallback}: ${error.message}`
    : fallback;
}

function agentConfigPath(agentId: string): string {
  if (!isValidAgentId(agentId)) throw new Error('Onboarding target agent is unavailable');
  return `/api/agents/${encodeURIComponent(agentId)}/config`;
}

interface AgentListEntry {
  id: string;
  isPrimary: boolean;
  isCurrent: boolean;
}

export function selectOnboardingAgentId(rawAgents: unknown): string {
  const byId = new Map<string, AgentListEntry>();
  if (Array.isArray(rawAgents)) {
    for (const raw of rawAgents) {
      if (!isObject(raw) || !isValidAgentId(raw.id)) continue;
      const previous = byId.get(raw.id);
      byId.set(raw.id, {
        id: raw.id,
        isPrimary: previous?.isPrimary === true || raw.isPrimary === true,
        isCurrent: previous?.isCurrent === true || raw.isCurrent === true,
      });
    }
  }

  const agents = [...byId.values()];
  const primary = agents.filter(agent => agent.isPrimary);
  if (primary.length === 1) return primary[0].id;
  if (primary.length > 1) throw new Error('Onboarding cannot choose between multiple primary agents');

  const current = agents.filter(agent => agent.isCurrent);
  if (current.length === 1) return current[0].id;
  if (current.length > 1) throw new Error('Onboarding cannot choose between multiple current agents');

  if (agents.length === 1) return agents[0].id;
  if (agents.length === 0) throw new Error('Onboarding could not find a valid agent');
  throw new Error('Onboarding target agent is ambiguous');
}

export async function resolveOnboardingAgentId(lucFetch: LucFetch): Promise<string> {
  const res = await lucFetch('/api/agents?fresh=1');
  const body = await requireResponse(res, 'Loading onboarding agent');
  if (!isObject(body) || !Array.isArray(body.agents)) {
    throw new Error('Loading onboarding agent returned an invalid response');
  }
  return selectOnboardingAgentId(body.agents);
}

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!isObject(value)) return value;
  const clean: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'api_key') continue;
    clean[key] = withoutSecrets(child);
  }
  return clean;
}

function mergeExpected(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value)) {
      const current = isObject(target[key]) ? target[key] as JsonObject : {};
      target[key] = current;
      mergeExpected(current, value);
    } else {
      target[key] = withoutSecrets(value);
    }
  }
}

function recordAgentConfig(plan: OnboardingVerificationPlan | undefined, patch: JsonObject): void {
  if (!plan) return;
  mergeExpected(plan.agentConfig, withoutSecrets(patch) as JsonObject);
}

function recordPreferenceModels(plan: OnboardingVerificationPlan | undefined, patch: JsonObject): void {
  if (!plan) return;
  mergeExpected(plan.preferenceModels, withoutSecrets(patch) as JsonObject);
}

function recordRequiredAgentSecret(plan: OnboardingVerificationPlan | undefined, path: string[]): void {
  if (!plan) return;
  const serialized = JSON.stringify(path);
  if (!plan.requiredAgentSecretPaths.some(existing => JSON.stringify(existing) === serialized)) {
    plan.requiredAgentSecretPaths.push(path);
  }
}

function valueAtPath(root: unknown, path: string[]): unknown {
  let value = root;
  for (const segment of path) {
    if (!isObject(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function findMismatch(actual: unknown, expected: unknown, path: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path;
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = findMismatch(actual[index], expected[index], `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return path;
    for (const [key, value] of Object.entries(expected)) {
      const mismatch = findMismatch(actual[key], value, `${path}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return Object.is(actual, expected) ? null : path;
}

interface VerifyOnboardingPersistenceParams {
  lucFetch: LucFetch;
  agentId: string;
  verificationPlan: OnboardingVerificationPlan;
}

export async function verifyOnboardingPersistence({
  lucFetch,
  agentId,
  verificationPlan,
}: VerifyOnboardingPersistenceParams): Promise<void> {
  const configRes = await lucFetch(agentConfigPath(agentId));
  const config = await requireResponse(configRes, 'Verifying onboarding settings');
  if (!isObject(config)) throw new Error('Verifying onboarding settings returned an invalid response');

  const configMismatch = findMismatch(config, verificationPlan.agentConfig, 'agent config');
  if (configMismatch) {
    throw new Error(`Saved onboarding settings were not found at ${configMismatch}`);
  }
  for (const secretPath of verificationPlan.requiredAgentSecretPaths) {
    const value = valueAtPath(config, secretPath);
    if (typeof value !== 'string' || !value) {
      throw new Error(`Saved onboarding settings were not found at agent config.${secretPath.join('.')}`);
    }
  }

  if (Object.keys(verificationPlan.preferenceModels).length === 0) return;
  const preferencesRes = await lucFetch('/api/preferences/models');
  const preferences = await requireResponse(preferencesRes, 'Verifying onboarding model preferences');
  if (!isObject(preferences)) {
    throw new Error('Verifying onboarding model preferences returned an invalid response');
  }
  const preferenceMismatch = findMismatch(preferences, verificationPlan.preferenceModels, 'model preferences');
  if (preferenceMismatch) {
    throw new Error(`Saved onboarding settings were not found at ${preferenceMismatch}`);
  }
}

// ── Test connection ──

interface TestConnectionParams {
  lucFetch: LucFetch;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

export async function testConnection({ lucFetch, providerUrl, providerApi, apiKey }: TestConnectionParams): Promise<TestResult> {
  const res = await lucFetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await readJson(res);
  if (res.ok === true && isObject(data) && data.ok === true) {
    return { ok: true, text: t('onboarding.provider.testSuccess') };
  }
  const message = isObject(data) && typeof data.error === 'string' && data.error.trim()
    ? data.error
    : t('onboarding.provider.testFailed');
  return { ok: false, text: message };
}

// ── Save provider ──

interface SaveProviderParams {
  lucFetch: LucFetch;
  agentId: string;
  providerName: string;
  providerUrl: string;
  apiKey: string;
  providerApi: string;
  verificationPlan?: OnboardingVerificationPlan;
}

export async function saveProvider({
  lucFetch,
  agentId,
  providerName,
  providerUrl,
  apiKey,
  providerApi,
  verificationPlan,
}: SaveProviderParams): Promise<void> {
  const patch = {
    api: { provider: providerName },
    providers: {
      [providerName]: {
        base_url: providerUrl,
        api_key: apiKey,
        api: providerApi,
      },
    },
  };
  const res = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireMutation(res, 'Saving provider settings');
  recordAgentConfig(verificationPlan, patch);
  if (apiKey) recordRequiredAgentSecret(verificationPlan, ['providers', providerName, 'api_key']);
}

// ── Load models ──

interface LoadModelsParams {
  lucFetch: LucFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  maxTokens?: number | null;
  maxOutputTokens?: number | null;
  image?: boolean;
  vision?: boolean;
  video?: boolean;
  audio?: boolean;
  reasoning?: boolean;
}

export interface LoadModelsResult {
  models: DiscoveredModel[];
  error?: string;
}

export async function loadModels({ lucFetch, providerName, providerUrl, providerApi, apiKey }: LoadModelsParams): Promise<LoadModelsResult> {
  const res = await lucFetch('/api/providers/fetch-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: providerName,
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await readJson(res);
  if (res.ok !== true) {
    return { models: [], error: responseError('Loading provider models', res, data).message };
  }
  if (!isObject(data)) {
    return { models: [], error: 'Loading provider models returned an invalid response' };
  }
  if (typeof data.error === 'string' && data.error) {
    return { models: [], error: data.error };
  }
  return { models: Array.isArray(data.models) ? data.models as DiscoveredModel[] : [] };
}

// ── Save model + utility models ──

export interface AddedModelObject {
  id: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  image?: boolean;
  video?: boolean;
  audio?: boolean;
  reasoning?: boolean;
}

export type AddedModelEntry = string | AddedModelObject;

interface SaveModelParams {
  lucFetch: LucFetch;
  agentId: string;
  selectedModel: string;
  providerName: string;
  addedModels: AddedModelEntry[];
  selectedUtility: string;
  selectedUtilityLarge: string;
  verificationPlan?: OnboardingVerificationPlan;
}

function compactModelEntry(entry: AddedModelEntry): AddedModelEntry {
  if (typeof entry === 'string') return entry;
  const next: AddedModelObject = { id: entry.id };
  const name = entry.name?.trim();
  if (name) next.name = name;
  if (typeof entry.context === 'number' && Number.isFinite(entry.context)) next.context = entry.context;
  if (typeof entry.maxOutput === 'number' && Number.isFinite(entry.maxOutput)) next.maxOutput = entry.maxOutput;
  if (typeof entry.image === 'boolean') next.image = entry.image;
  if (typeof entry.video === 'boolean') next.video = entry.video;
  if (typeof entry.audio === 'boolean') next.audio = entry.audio;
  if (typeof entry.reasoning === 'boolean') next.reasoning = entry.reasoning;
  return Object.keys(next).length === 1 ? next.id : next;
}

export async function saveModel({
  lucFetch,
  agentId,
  selectedModel,
  providerName,
  addedModels,
  selectedUtility,
  selectedUtilityLarge,
  verificationPlan,
}: SaveModelParams): Promise<void> {
  // Save chat model
  const chatModelPatch = { models: { chat: { id: selectedModel, provider: providerName } } };
  const chatModelRes = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatModelPatch),
  });
  await requireMutation(chatModelRes, 'Saving chat model');
  recordAgentConfig(verificationPlan, chatModelPatch);

  // Save only the user's explicit Added Models selection to provider.
  const modelEntries = addedModels.map(compactModelEntry);
  const providerModelsPatch = { providers: { [providerName]: { models: modelEntries } } };
  const providerModelsRes = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(providerModelsPatch),
  });
  await requireMutation(providerModelsRes, 'Saving provider models');
  recordAgentConfig(verificationPlan, providerModelsPatch);

  // Save utility models to global preferences
  if (selectedUtility || selectedUtilityLarge) {
    const utilityModels: Record<string, { id: string; provider: string }> = {};
    if (selectedUtility) utilityModels.utility = { id: selectedUtility, provider: providerName };
    if (selectedUtilityLarge) utilityModels.utility_large = { id: selectedUtilityLarge, provider: providerName };
    const preferencesPatch = { models: utilityModels };
    const preferencesRes = await lucFetch('/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preferencesPatch),
    });
    await requireMutation(preferencesRes, 'Saving utility models');
    recordPreferenceModels(verificationPlan, preferencesPatch);
  }
}

// ── Save locale ──

export async function saveLocale(
  lucFetch: LucFetch,
  agentId: string,
  locale: string,
  verificationPlan?: OnboardingVerificationPlan,
): Promise<void> {
  const patch = { locale };
  const res = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireMutation(res, 'Saving language');
  recordAgentConfig(verificationPlan, patch);
}

// ── Save identity ──

interface SaveOnboardingIdentityParams {
  lucFetch: LucFetch;
  agentId: string;
  userName: string;
  agentName: string;
  memoryEnabled: boolean;
  verificationPlan?: OnboardingVerificationPlan;
}

export async function saveOnboardingIdentity({
  lucFetch,
  agentId,
  userName,
  agentName,
  memoryEnabled,
  verificationPlan,
}: SaveOnboardingIdentityParams): Promise<void> {
  const trimmedUserName = userName.trim();
  const trimmedAgentName = agentName.trim();
  const body: {
    user: { name: string };
    agent?: { name: string };
    memory: { enabled: boolean };
  } = { user: { name: trimmedUserName }, memory: { enabled: memoryEnabled } };
  if (trimmedAgentName) {
    body.agent = { name: trimmedAgentName };
  }

  const patch = {
    user: body.user,
    ...(body.agent ? { agent: body.agent } : {}),
    memory: body.memory,
  };
  const res = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireMutation(res, 'Saving names and memory settings');
  recordAgentConfig(verificationPlan, patch);
}

export async function saveUserName(
  lucFetch: LucFetch,
  agentId: string,
  name: string,
  verificationPlan?: OnboardingVerificationPlan,
): Promise<void> {
  const patch = { user: { name } };
  const res = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireMutation(res, 'Saving user name');
  recordAgentConfig(verificationPlan, patch);
}

// ── Workspace ──

export async function loadDefaultWorkspace(lucFetch: LucFetch): Promise<string> {
  const res = await lucFetch('/api/config/default-workspace');
  const data = await requireResponse(res, 'Loading default workspace');
  if (!isObject(data)) throw new Error('Loading default workspace returned an invalid response');
  if (typeof data.error === 'string' && data.error) throw new Error(data.error);
  return typeof data.path === 'string' ? data.path : '';
}

async function ensureDefaultWorkspace(lucFetch: LucFetch): Promise<string> {
  const res = await lucFetch('/api/config/default-workspace', { method: 'POST' });
  const data = await requireMutation(res, 'Creating default workspace');
  return isObject(data) && typeof data.path === 'string' ? data.path : '';
}

interface SaveWorkspaceParams {
  lucFetch: LucFetch;
  agentId: string;
  workspacePath: string;
  defaultPath: string;
  verificationPlan?: OnboardingVerificationPlan;
}

export async function saveWorkspace({
  lucFetch,
  agentId,
  workspacePath,
  defaultPath,
  verificationPlan,
}: SaveWorkspaceParams): Promise<void> {
  const selected = workspacePath.trim();
  if (!selected) throw new Error('workspacePath is required');

  if (selected === defaultPath) {
    await ensureDefaultWorkspace(lucFetch);
  }

  const patch = {
    desk: {
      home_folder: selected,
      heartbeat_enabled: false,
      heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
    },
  };
  const res = await lucFetch(agentConfigPath(agentId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  await requireMutation(res, 'Saving workspace');
  recordAgentConfig(verificationPlan, patch);
}
