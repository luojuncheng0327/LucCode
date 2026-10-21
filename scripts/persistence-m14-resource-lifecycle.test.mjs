import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LucEngine } from "../core/engine.ts";
import { createResourceCatalogStore } from "../core/resource-catalog-store.ts";

for (const failedComponent of [null, "plugin", "usage"]) {
  test("engine disposes the real catalog even with " + (failedComponent || "no") + " cleanup failure", async (t) => {
    const lucHome = fs.mkdtempSync(path.join(os.tmpdir(), "luc-m14-resource-lifecycle-"));
    const catalog = createResourceCatalogStore({ lucHome });
    t.after(() => {
      catalog.close();
      fs.rmSync(lucHome, { recursive: true, force: true });
    });
    assert.equal(catalog.db.name, path.join(lucHome, "workspace-state", "resources.sqlite"));
    let manifestClosed = false;
    const engine = {
      _resourceCatalog: catalog,
      _pluginManager: failedComponent === "plugin" ? {
        listPlugins: () => [{ id: "fixture", status: "loaded" }],
        unloadPlugin: async () => { throw new Error("plugin cleanup"); },
      } : null,
      _usageLedger: { close: () => { if (failedComponent === "usage") throw new Error("usage cleanup"); } },
      _sessionManifestStore: { close: () => { manifestClosed = true; } },
      _agentMgr: { disposeAll: async () => {} },
      _sessionCoord: { cleanupSession: async () => {} },
      disposeComputerRuntime: async () => {},
    };
    const result = LucEngine.prototype.dispose.call(engine);
    if (failedComponent) await assert.rejects(result, new RegExp(failedComponent + " cleanup"));
    else await result;
    assert.equal(catalog.db.open, false, "catalog connection must be released");
    assert.equal(manifestClosed, true);
  });
}
