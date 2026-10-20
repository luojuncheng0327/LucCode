/**
 * server-port-selection.ts — loopback 监听端口的选择、迁移与运行期自愈决策
 *
 * 设计约束：
 * - loopback 端口是实现细节，桌面端与 renderer 通过 server-info.json 握手发现
 *   实际端口，CSP 与 CORS 均为 127.0.0.1 通配端口，允许按机随机分配。
 * - 旧默认 14500 是 xpra 的知名默认端口且处于部分安全软件的盯防名单，
 *   Windows 保留端口段（Hyper-V/WinNAT excludedportrange）也时常覆盖它；
 *   固定整数端口会让全部安装共享同一枚地雷。
 * - LAN / custom_remote 的端口是对外契约（配对设备、防火墙规则），永不自动改。
 * - 占用者是另一个 Luc server 时禁止 fallback：同 LUC_HOME 双开会并发写坏
 *   SQLite 与 session 文件，同 home 复用/终止由桌面端启动链负责。
 */
import fs from "fs";
import net from "net";
import path from "path";
import {
  DEFAULT_SERVER_LISTEN_PORT,
  loadServerNetworkConfig,
  saveServerNetworkConfig,
  ensureServerNetworkConfig,
} from "./server-network-config.ts";

export const LOOPBACK_PORT_BAND = { min: 20000, max: 44999 };

const FALLBACK_ERROR_CODES = new Set(["EADDRINUSE", "EACCES", "EPERM"]);

export function randomPortInBand(random: () => number = Math.random): number {
  const span = LOOPBACK_PORT_BAND.max - LOOPBACK_PORT_BAND.min;
  const raw = LOOPBACK_PORT_BAND.min + Math.floor(random() * (span + 1));
  return Math.min(LOOPBACK_PORT_BAND.max, Math.max(LOOPBACK_PORT_BAND.min, raw));
}

export function probeLoopbackListenPort(
  port: number,
  host = "127.0.0.1",
): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const onError = (err: any) => {
      server.removeListener("error", onError);
      resolve({ ok: false, code: err?.code || "UNKNOWN" });
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      server.close(() => resolve({ ok: true }));
    });
  });
}

export async function selectLoopbackListenPort({
  host = "127.0.0.1",
  attempts = 20,
  random = Math.random,
  probe = probeLoopbackListenPort,
  exclude = [],
}: {
  host?: string;
  attempts?: number;
  random?: () => number;
  probe?: typeof probeLoopbackListenPort;
  exclude?: number[];
} = {}): Promise<number | null> {
  const excluded = new Set(exclude);
  for (let i = 0; i < attempts; i++) {
    const candidate = randomPortInBand(random);
    if (excluded.has(candidate)) continue;
    const result = await probe(candidate, host);
    if (result.ok) return candidate;
  }
  return null;
}

export async function ensureServerNetworkConfigWithPortSelection(
  lucHome: string,
  {
    select = selectLoopbackListenPort,
    log = () => {},
    now,
  }: {
    select?: typeof selectLoopbackListenPort;
    log?: (msg: string) => void;
    now?: string;
  } = {},
): Promise<
  | { created: true; migrated: false; port: number }
  | { created: false; migrated: true; from: number; to: number }
  | { created: false; migrated: false }
> {
  const nowIso = now || new Date().toISOString();
  const existing = readExistingConfigOrNull(lucHome);

  if (!existing) {
    const selected = await select({});
    if (selected === null) {
      log(`首启随机选港全部失败，回退到默认端口 ${DEFAULT_SERVER_LISTEN_PORT}`);
      ensureServerNetworkConfig(lucHome, { now: nowIso });
      return { created: true, migrated: false, port: DEFAULT_SERVER_LISTEN_PORT };
    }
    saveServerNetworkConfig(lucHome, {
      schemaVersion: 1,
      mode: "loopback",
      listenHost: "127.0.0.1",
      listenPort: selected,
      customRemote: { enabled: false, baseUrl: null, wsUrl: null },
    }, { now: nowIso });
    return { created: true, migrated: false, port: selected };
  }

  if (existing.mode === "loopback" && existing.listenPort === DEFAULT_SERVER_LISTEN_PORT) {
    const selected = await select({ exclude: [DEFAULT_SERVER_LISTEN_PORT] });
    if (selected === null) {
      log(`存量 loopback+${DEFAULT_SERVER_LISTEN_PORT} 端口迁移选港失败，保留原端口`);
      return { created: false, migrated: false };
    }
    saveServerNetworkConfig(lucHome, { ...existing, listenPort: selected }, { now: nowIso });
    log(`loopback 端口静默迁移: ${DEFAULT_SERVER_LISTEN_PORT} → ${selected}`);
    return { created: false, migrated: true, from: DEFAULT_SERVER_LISTEN_PORT, to: selected };
  }

  return { created: false, migrated: false };
}

function readExistingConfigOrNull(lucHome: string) {
  // loadServerNetworkConfig 会在文件缺失时先 ensure 出默认文件；我们需要区分
  // "文件本就不存在"（走首启选港）与"文件存在"（走迁移/原样判定），所以自己
  // 探测文件是否存在，存在时才调用 load（loadServerNetworkConfig 内部的
  // ensureServerNetworkConfig 对已存在文件是无害的 validate-only 路径）。
  const filePath = path.join(lucHome, "server-network.json");
  if (!fs.existsSync(filePath)) return null;
  return loadServerNetworkConfig(lucHome);
}

export async function isLucServerListeningOnPort({
  port,
  host = "127.0.0.1",
  fetchImpl = fetch,
  timeoutMs = 1500,
}: {
  port: number;
  host?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json: any = await res.json();
    if (!json || typeof json !== "object") return false;
    if (typeof json.version !== "string") return false;
    if (typeof json.status === "string") return true;
    if (json.network || json.networkMode) return true;
    return false;
  } catch {
    return false;
  }
}

export function decideLoopbackBindFallback({
  errCode,
  networkMode,
  envPortPinned,
  lucOnPort,
}: {
  errCode: string;
  networkMode: string;
  envPortPinned: boolean;
  lucOnPort: boolean;
}): "fallback" | "fail-other-luc" | "fail" {
  if (networkMode !== "loopback") return "fail";
  if (envPortPinned) return "fail";
  if (!FALLBACK_ERROR_CODES.has(errCode)) return "fail";
  if (lucOnPort) return "fail-other-luc";
  return "fallback";
}
