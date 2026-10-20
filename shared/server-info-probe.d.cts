export type ServerInfoProbeStatus =
  | "alive-same-home"
  | "alive-unauthorized"
  | "not-luc"
  | "dead";

export type ServerInfoProbeResult =
  | { status: "alive-same-home" }
  | { status: "alive-unauthorized" }
  | { status: "not-luc"; detail: string }
  | { status: "dead" };

export const DEFAULT_PROBE_PATH: string;
export const DEFAULT_TIMEOUT_MS: number;

export function probeServerInfo(args: {
  info: { port?: number; token?: string; [key: string]: any } | null | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  probePath?: string;
}): Promise<ServerInfoProbeResult>;

export function isForeignServerBlocking(status: ServerInfoProbeStatus): boolean;

export function describeForeignServerBlock(args: {
  status: ServerInfoProbeStatus;
  info: { ownerKind?: string; version?: string; pid?: number } | null | undefined;
}): string | null;
