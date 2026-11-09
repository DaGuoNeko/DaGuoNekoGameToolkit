const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { worldDataFixture } = require("./fixtures/world-data.cjs"), { zipMap } = require("./fixtures/map-world.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { scanWorldData } = require("../electron/domains/worlds/world-data.cjs");
const { queryWorldData } = require("../shared/world-data-model.cjs");
const { WorldDataStore } = require("../electron/domains/worlds/world-data-store.cjs");
test("unchanged directory reuses a fingerprint without decoding, scope and source changes invalidate it", async t => {
  const source = artifactPath("world"); await worldDataFixture(source);
  const args = { source, dataRoot: artifactPath("scratch"), scope: "gameplay" };
  const start = performance.now(), first = await scanWorldData(args), coldMs = performance.now() - start;
  const stages = [], warm = performance.now();
  const cached = await scanWorldData({ ...args, reuseFingerprint: first.fingerprint, onProgress: stage => stages.push(stage) });
  t.diagnostic(JSON.stringify({ coldMs: Math.round(coldMs), validationMs: Math.round(performance.now() - warm) }));
  assert.deepEqual(cached, { source, reused: true }); assert(!stages.includes("核对存档模组与启用清单"));
  assert.notEqual((await scanWorldData({ ...args, scope: "world", reuseFingerprint: first.fingerprint })).fingerprint, first.fingerprint);
  await fs.writeFile(path.join(source, "world_behavior_packs.json"), "[]", "utf8");
  const changed = await scanWorldData({ ...args, reuseFingerprint: first.fingerprint });
  assert.notEqual(changed.fingerprint, first.fingerprint); assert.equal(changed.capabilities.npc.state, "disabled");
  await fs.writeFile(path.join(source, ".daguoneko-versions.json"), JSON.stringify({ schema: 1, minimum: "3.10.0.1", maximum: "" }), "utf8");
  assert.notEqual((await scanWorldData({ ...args, reuseFingerprint: changed.fingerprint })).fingerprint, changed.fingerprint);
});
test("unchanged archive reuse does not extract a second copy", async () => {
  const root = artifactPath("archive"), source = path.join(root, "source"); await worldDataFixture(source);
  const archive = path.join(root, "world.mcworld"); await zipMap(source, archive);
  const first = await scanWorldData({ source: archive, dataRoot: path.join(root, "first") });
  const unused = path.join(root, "not-extracted");
  assert.deepEqual(await scanWorldData({ source: archive, dataRoot: unused, reuseFingerprint: first.fingerprint }), { source: archive, reused: true });
  await assert.rejects(fs.stat(unused), { code: "ENOENT" });
});
test("cached summaries retain snapshot metadata and respect eviction and write invalidation", async t => {
  const store = new WorldDataStore(path.resolve("electron/domains/worlds/world-data-compute-worker.cjs")); t.after(() => store.dispose());
  const snapshot = { source: "fixture", generatedAt: "original-time", fingerprint: "original-fingerprint", objects: [{ id: "one", kind: "command", value: { Command: "say hi" } }], relations: [] };
  await store.request("put", { requestId: "old", snapshot });
  const summary = await store.request("summary", { requestId: "old" });
  assert.equal(summary.objectCount, 1); assert.equal(summary.fingerprint, snapshot.fingerprint); assert.equal(summary.generatedAt, snapshot.generatedAt);
  for (let i = 0; i < 4; i++) await store.request("put", { requestId: "new" + i, snapshot });
  await assert.rejects(store.request("summary", { requestId: "old" }), /过期/);
  await store.request("invalidate-source", { source: "fixture" });
  await assert.rejects(store.request("summary", { requestId: "new3" }), /过期/);
});
test("list summaries do not serialize nested detail values", () => {
  const nested = { toJSON() { throw Error("detail serialization"); } };
  const snapshot = { objects: [{ id: "one", kind: "world", value: { nested }, evidence: {} }], relations: [] };
  assert.equal(queryWorldData(snapshot).rows.length, 1);
  assert.throws(() => queryWorldData(snapshot, { id: "one" }), /detail serialization/);
});
