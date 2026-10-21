import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChannel, appendMessage, parseChannel } from "../lib/channels/channel-store.ts";
import { PERSISTENT_STORES } from "../shared/persistence/store-registry.ts";
import { createDataEpochCheckpointProvider } from "../core/data-epoch-checkpoint-provider.ts";

test("channel registry captures the Markdown file actually written by its owner", async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "luc-channel-contract-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const channel = await createChannel(path.join(homeDir, "channels"), { id: "fixture", name: "Fixture", description: "test", members: ["agent-a", "agent-b"], intro: "hello" });
  await appendMessage(channel.filePath, "agent-a", "preserved message");
  const bytes = fs.readFileSync(channel.filePath);
  assert.ok(parseChannel(bytes.toString("utf8")).messages.some((message) => message.body === "preserved message"));
  const provider = createDataEpochCheckpointProvider();
  const receipt = await provider.create({ homeDir, fromEpoch: 1, toEpoch: 2, transitionId: "channel-contract-fixture", affectedStoreIds: ["channels"] });
  await provider.verify(receipt);
  const metadata = JSON.parse(fs.readFileSync(path.join(receipt.dir, "metadata.json"), "utf8"));
  assert.ok(metadata.items.some((item) => item.relPath === "channels/ch_fixture.md"), "checkpoint must contain runtime Markdown, not miss it behind a YAML pattern");
  const descriptor = PERSISTENT_STORES.find((store) => store.id === "channels");
  assert.equal(descriptor.format, "markdown");
  assert.deepEqual(descriptor.pathPatterns, ["channels/{channelId}.md"]);
  assert.deepEqual(fs.readFileSync(channel.filePath), bytes);
});
