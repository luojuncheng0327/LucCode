"use strict";

/**
 * shared/server-info-probe.cjs — token-authenticated liveness probe for
 * `server-info.json` entries.
 *
 * Threat model (同宅防线 / same-LUC_HOME mutual exclusion):
 * A single LUC_HOME can be opened by more than one kernel binary on the
 * same machine — `luc serve` (standalone CLI) and the desktop app are the
 * two shipped entry points, and a user can start either one first. If two
 * kernels hold the same SQLite files / session JSONLs / server-info.json
 * open at once, concurrent writes corrupt state silently. The existing
 * defenses (desktop's own `verifyReusableServerInfo` reuse check, the
 * `resolveStaleServerInfoDisposition` residual-process disposition, and
 * bare-port EADDRINUSE) all leave one hole open: a residual process that is
 * alive, cannot be verified as *this* desktop's own reusable server, but
 * does not conflict on the desired port — that branch used to fall through
 * to spawning a second server anyway, because "port doesn't conflict" was
 * being used as a proxy for "safe to start alongside it". It isn't: the
 * residual process may well be a live, healthy kernel on the very same
 * LUC_HOME, just listening on a different port (e.g. `luc serve` started
 * first, desktop started second).
 *
 * This module closes that hole with a single, reusable question: "is the
 * process described by this server-info.json record still alive, and is it
 * provably the same home?" Provably means it accepts the 128-bit
 * SERVER_TOKEN written into that very server-info.json — anyone who can
 * present that token has already had filesystem read access to this
 * LUC_HOME, so a token match is as strong an identity signal as this
 * machine can offer locally.
 *
 * Why not trust the bare PID (the classic postmaster.pid mistake)? PIDs
 * get recycled by the OS; a dead kernel's PID can be reassigned to an
 * unrelated process by the time the next kernel starts, and a naive
 * "is this PID alive" check would then block startup forever on a false
 * positive, or (worse) silently coexist with a process that merely reused
 * the number. Requiring the process behind the PID to also answer a
 * token-authenticated HTTP call removes that whole class of misjudgment:
 * a residual lock is trusted only if it can prove it is still speaking for
 * the same home, not merely occupying the same process table slot.
 *
 * probeServerInfo() classifies the record into exactly four states:
 *   - "alive-same-home"   — the endpoint answered 200 with a body shaped
 *                            like this server's own identity route, using
 *                            the token from server-info.json. This is
 *                            unambiguously the same home, still running.
 *   - "alive-unauthorized"— something answered on that port and rejected
 *                           the token the way this codebase's auth
 *                           middleware rejects bad bearer tokens (403 with
 *                           an `error`/`reason` body). Most likely a Luc
 *                           kernel whose token has since rotated, or a
 *                           different LUC_HOME's kernel that happens to be
 *                           listening on the same port. Either way it is
 *                           not verifiably foreign, so it is treated as
 *                           blocking too (see isForeignServerBlocking).
 *   - "not-luc"           — something answered, but neither the 200 nor
 *                            the 403 shape matches what this server ever
 *                            produces (e.g. an unrelated HTTP service
 *                            occupies that port, or a stale record points
 *                            at a totally different process by now).
 *   - "dead"                — no response at all (connection refused,
 *                              reset, or timed out). The residual lock file
 *                              is provably stale.
 *
 * "not-luc" and "dead" both mean the recorded server-info.json cannot be
 * defended as still representing a live kernel — callers are expected to
 * delete the stale record and proceed, the same "self-cleaning" affordance
 * Postgres's postmaster.pid never had (its crash-residue lock requires a
 * human to delete the file by hand).
 */

const DEFAULT_PROBE_PATH = "/api/server/identity";
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * @param {{ info: { port?: number, token?: string, [key: string]: any } | null | undefined,
 *            timeoutMs?: number,
 *            fetchImpl?: typeof fetch,
 *            probePath?: string }} args
 * @returns {Promise<{ status: "alive-same-home" } | { status: "alive-unauthorized" } | { status: "not-luc", detail: string } | { status: "dead" }>}
 */
async function probeServerInfo({ info, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, probePath = DEFAULT_PROBE_PATH } = {}) {
  const port = Number(info && info.port);
  const token = typeof (info && info.token) === "string" ? info.token : "";
  if (!Number.isInteger(port) || port <= 0 || !token) {
    // No coordinates to probe at all — nothing to distinguish from "dead".
    return { status: "dead" };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("server-info-probe: no fetch implementation available (pass fetchImpl in this runtime)");
  }

  let res;
  try {
    res = await doFetch(`http://127.0.0.1:${port}${probePath}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "dead" };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 200) {
    if (body && typeof body === "object" && typeof body.serverId === "string" && body.serverId) {
      return { status: "alive-same-home" };
    }
    return { status: "not-luc", detail: `200 response did not match the server-identity shape: ${safeDescribe(body)}` };
  }

  if (res.status === 403) {
    if (body && typeof body === "object" && (typeof body.reason === "string" || typeof body.error === "string")) {
      return { status: "alive-unauthorized" };
    }
    return { status: "not-luc", detail: `403 response did not match the auth-rejection shape: ${safeDescribe(body)}` };
  }

  return { status: "not-luc", detail: `unexpected HTTP status ${res.status}` };
}

/**
 * Two of the four probe states must block a second kernel from starting:
 * a confirmed same-home kernel (alive-same-home), and a kernel that
 * answered but rejected our token (alive-unauthorized) — the latter is not
 * provably foreign, so it is not safe to treat as "someone else's server"
 * either. Only "not-luc" and "dead" are safe to clean up and proceed past.
 * @param {string} status
 */
function isForeignServerBlocking(status) {
  return status === "alive-same-home" || status === "alive-unauthorized";
}

/**
 * Formats the bilingual rejection message shown to the user when a probe
 * blocks startup. Kept as a pure function (no I/O) so its exact wording is
 * unit-testable without spinning up a real HTTP server.
 * @param {{ status: string, info: { ownerKind?: string, version?: string, pid?: number } | null | undefined }} args
 * @returns {string | null}
 */
function describeForeignServerBlock({ status, info }) {
  const ownerKind = (info && info.ownerKind) || "unknown";
  const version = (info && info.version) || "unknown";
  const pid = info && Number.isInteger(info.pid) ? info.pid : "unknown";

  if (status === "alive-same-home") {
    return (
      `检测到同一数据目录已有内核在运行（ownerKind=${ownerKind}, version=${version}, pid=${pid}）。要接管请先退出它，再重新启动。\n`
      + `A LucCode kernel is already running against this data directory (ownerKind=${ownerKind}, version=${version}, pid=${pid}). Quit it first, then start this one again.`
    );
  }
  if (status === "alive-unauthorized") {
    return (
      `该端口上有一个内核在响应，但无法用本机记录的凭据验证它的身份（token 可能已轮换，或另一个 Luc 数据目录的内核占用了这个端口）。请先排查（ownerKind=${ownerKind}, pid=${pid}），确认安全后再启动。\n`
      + `A kernel on that port responded but could not be authenticated with the credentials recorded locally (the token may have rotated, or a kernel from a different LUC_HOME is holding that port). Investigate first (ownerKind=${ownerKind}, pid=${pid}) before starting.`
    );
  }
  return null;
}

function safeDescribe(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  DEFAULT_PROBE_PATH,
  DEFAULT_TIMEOUT_MS,
  probeServerInfo,
  isForeignServerBlocking,
  describeForeignServerBlock,
};
