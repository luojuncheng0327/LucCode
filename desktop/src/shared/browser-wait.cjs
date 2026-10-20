const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_QUIET_MS = 500;
const DEFAULT_STABLE_SAMPLES = 3;

const READ_BROWSER_STATE_SCRIPT = `
(() => {
  if (!window.__lucBrowserWaitState) {
    const state = { mutationAt: Date.now(), observer: null };
    try {
      state.observer = new MutationObserver(() => {
        state.mutationAt = Date.now();
      });
      state.observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    } catch {}
    window.__lucBrowserWaitState = state;
  }
  const body = document.body;
  const root = document.documentElement;
  const text = ((body && body.innerText) || (root && root.innerText) || "").trim();
  const height = Math.max(
    body ? body.scrollHeight || 0 : 0,
    root ? root.scrollHeight || 0 : 0
  );
  const mutationAt = window.__lucBrowserWaitState.mutationAt || Date.now();
  return {
    readyState: document.readyState,
    elementCount: document.getElementsByTagName("*").length,
    textLength: text.length,
    bodyHeight: height,
    mutationAgeMs: Date.now() - mutationAt,
  };
})()
`;

function normalizeWaitState(state) {
  const value = String(state || "").toLowerCase();
  if (value === "idle") return "stable";
  if (value === "domcontentloaded" || value === "load" || value === "stable" || value === "networkidle") {
    return value;
  }
  return "stable";
}

function signatureOf(sample) {
  return [
    sample?.readyState || "",
    sample?.elementCount || 0,
    sample?.textLength || 0,
    sample?.bodyHeight || 0,
  ].join(":");
}

function isReadyForState(sample, state) {
  if (!sample) return false;
  if (state === "domcontentloaded") return sample.readyState === "interactive" || sample.readyState === "complete";
  if (state === "load") return sample.readyState === "complete";
  return sample.readyState !== "loading";
}

async function waitForBrowserState(webContents, opts = {}) {
  const state = normalizeWaitState(opts.state);
  const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const pollMs = Math.max(25, Number(opts.pollMs ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS);
  const quietMs = Math.max(0, Number(opts.quietMs ?? DEFAULT_QUIET_MS) || DEFAULT_QUIET_MS);
  const stableSamples = Math.max(1, Number(opts.stableSamples ?? DEFAULT_STABLE_SAMPLES) || DEFAULT_STABLE_SAMPLES);
  const started = Date.now();
  let last = null;
  let lastSignature = "";
  let sameCount = 0;

  while (Date.now() - started <= timeoutMs) {
    last = await webContents.executeJavaScript(READ_BROWSER_STATE_SCRIPT);
    const ready = isReadyForState(last, state);
    if (ready && (state === "domcontentloaded" || state === "load")) {
      return buildDiagnostics({ state, started, last, timedOut: false, reason: "state-ready" });
    }

    if (ready) {
      const signature = signatureOf(last);
      sameCount = signature === lastSignature ? sameCount + 1 : 1;
      lastSignature = signature;
      if (sameCount >= stableSamples || Number(last.mutationAgeMs || 0) >= quietMs) {
        return buildDiagnostics({ state, started, last, timedOut: false, reason: state === "networkidle" ? "stable-fallback" : "dom-stable" });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return buildDiagnostics({ state, started, last, timedOut: true, reason: "timeout" });
}

function buildDiagnostics({ state, started, last, timedOut, reason }) {
  return {
    state,
    timedOut,
    reason,
    elapsedMs: Date.now() - started,
    lastReadyState: last?.readyState || "",
    lastElementCount: Number(last?.elementCount || 0),
    lastTextLength: Number(last?.textLength || 0),
    lastBodyHeight: Number(last?.bodyHeight || 0),
    lastMutationAgeMs: Number(last?.mutationAgeMs || 0),
  };
}

module.exports = {
  READ_BROWSER_STATE_SCRIPT,
  normalizeWaitState,
  waitForBrowserState,
};
