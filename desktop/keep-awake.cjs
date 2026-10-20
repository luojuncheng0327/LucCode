"use strict";

const KEEP_AWAKE_TYPE = "prevent-app-suspension";

function createKeepAwakeManager({ powerSaveBlocker, log = console } = {}) {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function") {
    throw new Error("createKeepAwakeManager requires Electron powerSaveBlocker");
  }

  let enabled = false;
  let blockerId = null;

  function active() {
    if (blockerId === null) return false;
    if (typeof powerSaveBlocker.isStarted !== "function") return true;
    try {
      return powerSaveBlocker.isStarted(blockerId) === true;
    } catch {
      return false;
    }
  }

  function status() {
    return {
      enabled,
      active: active(),
      blockerId,
      type: KEEP_AWAKE_TYPE,
    };
  }

  function stopCurrent() {
    if (blockerId === null) return;
    const id = blockerId;
    blockerId = null;
    try {
      powerSaveBlocker.stop(id);
    } catch (err) {
      log?.warn?.(`[desktop] keep awake stop failed: ${err?.message || String(err)}`);
    }
  }

  function setEnabled(nextEnabled) {
    if (nextEnabled !== true) {
      enabled = false;
      stopCurrent();
      return status();
    }

    if (active()) {
      enabled = true;
      return status();
    }

    stopCurrent();
    enabled = false;
    blockerId = powerSaveBlocker.start(KEEP_AWAKE_TYPE);
    enabled = true;
    return status();
  }

  return {
    getStatus: status,
    setEnabled,
    dispose: () => setEnabled(false),
  };
}

module.exports = {
  KEEP_AWAKE_TYPE,
  createKeepAwakeManager,
};
