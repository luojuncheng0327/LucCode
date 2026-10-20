export type StudioConnectionKind = 'local' | 'lan' | 'custom_remote' | 'relay' | 'cloud';
export type ServerTrustState = 'local' | 'lan' | 'tunnel' | 'cloud';
export type ConnectionCredentialKind = 'none' | 'loopback_token' | 'device_credential' | 'user_session';
export type OfficialServiceKind = 'relay' | 'cloud_studio' | 'inference' | 'billing';

export type StudioConnectionTransport =
  | 'loopback'
  | 'trusted_lan'
  | 'user_managed_tunnel'
  | 'official_relay'
  | 'official_cloud';

export type StudioAccessActorKind =
  | 'anonymous'
  | 'local_user'
  | 'device'
  | 'account_user'
  | 'platform_account';

export type StudioAccessDataOwner = 'user_server' | 'luc_cloud_studio';

export type StudioAccessCapability =
  | 'chat'
  | 'resources.read'
  | 'resources.write'
  | 'files.read'
  | 'files.write'
  | 'files.openLocal'
  | 'tools.run'
  | 'plugins.use'
  | 'studio.owner'
  | 'settings.read'
  | 'settings.write'
  | 'providers.manage'
  | 'secrets.write'
  | 'bridge.manage';

export interface StudioConnectionProfile {
  kind: StudioConnectionKind;
  transport: StudioConnectionTransport;
  credentialKinds: ConnectionCredentialKind[];
  trustState: ServerTrustState;
  remoteReachable: boolean;
  requiresDevicePairing: boolean;
  requiresPlatformAccount: boolean;
  dataOwner: StudioAccessDataOwner;
  officialServiceKind: OfficialServiceKind | null;
}

export interface StudioAccessConnection {
  connectionId: string;
  kind: StudioConnectionKind;
  serverId: string;
  userId?: string;
  studioId: string;
  baseUrl: string;
  wsUrl: string;
  token: string | null;
  authState: string;
  trustState: ServerTrustState;
  credentialKind: ConnectionCredentialKind;
  platformAccountId?: string | null;
  officialServiceKind?: OfficialServiceKind | null;
  capabilities: string[];
}

export interface StudioAccessGrant {
  grantId: string;
  connectionId: string;
  actorKind: StudioAccessActorKind;
  scope: {
    serverId: string;
    userId: string | null;
    studioId: string;
  };
  transport: StudioConnectionTransport;
  dataOwner: StudioAccessDataOwner;
  localOnly: boolean;
  capabilities: StudioAccessCapability[];
}

export const STUDIO_ACCESS_CAPABILITIES: readonly StudioAccessCapability[] = Object.freeze([
  "chat",
  "resources.read",
  "resources.write",
  "files.read",
  "files.write",
  "files.openLocal",
  "tools.run",
  "plugins.use",
  "studio.owner",
  "settings.read",
  "settings.write",
  "providers.manage",
  "secrets.write",
  "bridge.manage",
] as const);

const CONNECTION_PROFILES = Object.freeze({
  local: Object.freeze({
    kind: "local" as StudioConnectionKind,
    transport: "loopback" as StudioConnectionTransport,
    credentialKinds: Object.freeze(["loopback_token"] as ConnectionCredentialKind[]),
    trustState: "local" as ServerTrustState,
    remoteReachable: false,
    requiresDevicePairing: false,
    requiresPlatformAccount: false,
    dataOwner: "user_server" as StudioAccessDataOwner,
    officialServiceKind: null as OfficialServiceKind | null,
  }),
  lan: Object.freeze({
    kind: "lan" as StudioConnectionKind,
    transport: "trusted_lan" as StudioConnectionTransport,
    credentialKinds: Object.freeze(["device_credential", "user_session"] as ConnectionCredentialKind[]),
    trustState: "lan" as ServerTrustState,
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: false,
    dataOwner: "user_server" as StudioAccessDataOwner,
    officialServiceKind: null as OfficialServiceKind | null,
  }),
  custom_remote: Object.freeze({
    kind: "custom_remote" as StudioConnectionKind,
    transport: "user_managed_tunnel" as StudioConnectionTransport,
    credentialKinds: Object.freeze(["device_credential", "user_session"] as ConnectionCredentialKind[]),
    trustState: "tunnel" as ServerTrustState,
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: false,
    dataOwner: "user_server" as StudioAccessDataOwner,
    officialServiceKind: null as OfficialServiceKind | null,
  }),
  relay: Object.freeze({
    kind: "relay" as StudioConnectionKind,
    transport: "official_relay" as StudioConnectionTransport,
    credentialKinds: Object.freeze(["user_session"] as ConnectionCredentialKind[]),
    trustState: "tunnel" as ServerTrustState,
    remoteReachable: true,
    requiresDevicePairing: true,
    requiresPlatformAccount: true,
    dataOwner: "user_server" as StudioAccessDataOwner,
    officialServiceKind: "relay" as OfficialServiceKind | null,
  }),
  cloud: Object.freeze({
    kind: "cloud" as StudioConnectionKind,
    transport: "official_cloud" as StudioConnectionTransport,
    credentialKinds: Object.freeze(["user_session"] as ConnectionCredentialKind[]),
    trustState: "cloud" as ServerTrustState,
    remoteReachable: true,
    requiresDevicePairing: false,
    requiresPlatformAccount: true,
    dataOwner: "luc_cloud_studio" as StudioAccessDataOwner,
    officialServiceKind: "cloud_studio" as OfficialServiceKind | null,
  }),
});

export function getStudioConnectionProfile(kind: StudioConnectionKind): StudioConnectionProfile {
  const profile = CONNECTION_PROFILES[kind];
  if (!profile) throw new Error(`unknown StudioConnection kind: ${kind}`);
  return {
    ...profile,
    credentialKinds: [...profile.credentialKinds],
  };
}

export function validateStudioConnectionTrust(connection: StudioAccessConnection): void {
  const profile = getStudioConnectionProfile(connection.kind);

  if (connection.kind === "local") {
    if (!isLoopbackUrl(connection.baseUrl) || !isLoopbackUrl(connection.wsUrl)) {
      throw new Error("local connection must use loopback baseUrl and wsUrl");
    }
  } else if (connection.credentialKind === "loopback_token") {
    throw new Error(`${connection.kind} connection must not use loopback_token`);
  }

  if (!profile.credentialKinds.includes(connection.credentialKind)) {
    throw new Error(
      `${connection.kind} connection requires credentialKind=${profile.credentialKinds.join("|")}`,
    );
  }

  if (connection.trustState !== profile.trustState) {
    throw new Error(`${connection.kind} connection requires trustState=${profile.trustState}`);
  }

  if ((connection.officialServiceKind ?? null) !== profile.officialServiceKind) {
    const value = profile.officialServiceKind === null ? "null" : profile.officialServiceKind;
    throw new Error(`${connection.kind} connection requires officialServiceKind=${value}`);
  }

  if (profile.requiresPlatformAccount && !connection.platformAccountId) {
    throw new Error(`${connection.kind} connection requires platformAccountId`);
  }
}

export function deriveStudioAccessGrant(connection: StudioAccessConnection): StudioAccessGrant {
  validateStudioConnectionTrust(connection);
  const profile = getStudioConnectionProfile(connection.kind);
  return {
    grantId: `access:${connection.connectionId}:${connection.studioId}`,
    connectionId: connection.connectionId,
    actorKind: actorKindForConnection(connection),
    scope: {
      serverId: connection.serverId,
      userId: connection.userId ?? null,
      studioId: connection.studioId,
    },
    transport: profile.transport,
    dataOwner: profile.dataOwner,
    localOnly: profile.transport === "loopback",
    capabilities: deriveCapabilities(connection, profile),
  };
}

function deriveCapabilities(connection: StudioAccessConnection, profile: StudioConnectionProfile): StudioAccessCapability[] {
  if (profile.kind === "local") {
    return [...STUDIO_ACCESS_CAPABILITIES];
  }

  const requested = new Set(connection.capabilities);
  const allowed = new Set<StudioAccessCapability>();
  if (requested.has("chat")) allowed.add("chat");
  if (requested.has("resources")) allowed.add("resources.read");
  if (requested.has("files") || requested.has("files.read")) allowed.add("files.read");
  if (requested.has("files") || requested.has("files.write")) allowed.add("files.write");
  if (requested.has("tools")) allowed.add("tools.run");
  if (requested.has("plugins") || requested.has("plugins.use")) allowed.add("plugins.use");
  if (requested.has("studio.owner")) allowed.add("studio.owner");
  if (requested.has("settings") || requested.has("settings.read")) allowed.add("settings.read");
  if (requested.has("settings") || requested.has("settings.write")) allowed.add("settings.write");
  if (requested.has("providers.manage")) allowed.add("providers.manage");
  if (requested.has("secrets.write")) allowed.add("secrets.write");
  if (requested.has("bridge.manage")) allowed.add("bridge.manage");

  return STUDIO_ACCESS_CAPABILITIES.filter((capability) => allowed.has(capability));
}

function actorKindForConnection(connection: StudioAccessConnection): StudioAccessActorKind {
  switch (connection.credentialKind) {
    case "loopback_token":
      return "local_user";
    case "device_credential":
      return "device";
    case "user_session":
      if (!connection.platformAccountId && !connection.officialServiceKind) {
        return "account_user";
      }
      return "platform_account";
    case "none":
    default:
      return "anonymous";
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}
