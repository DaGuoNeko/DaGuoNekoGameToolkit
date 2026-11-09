const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { WorldDataStore } = require("../electron/domains/worlds/world-data-store.cjs");
const { queryWorldData, compareWorldData, exportWorldData } = require("../shared/world-data-model.cjs");
const snapshot = value => ({ source: "fixture", scope: "all", complete: true, objects: [{ id: "one", identity: "quest:one", kind: "quest", name: "中文", value: { number: value, text: "0000000000000000001" }, evidence: {}, types: {} }], relations: [] });
test("worker snapshots produce identical queries, comparisons and exports, retain four snapshots", async t => {
  const service = new WorldDataStore(path.resolve("electron/domains/worlds/world-data-compute-worker.cjs")); t.after(() => service.dispose());
  const left = snapshot(1), right = snapshot(2);
  await service.request("put", { requestId: "left", snapshot: left });
  await service.request("put", { requestId: "right", snapshot: right });
  for (const args of [{ query: "中文" }, { query: "number", includeData: true }, { view: "relations" }, { offset: 1 }])
    assert.deepEqual(await service.request("query", { ...args, requestId: "left" }), queryWorldData(left, args));
  assert.deepEqual(await service.request("compare", { left: "left", right: "right" }), compareWorldData(left, right));
  for (const format of ["json", "csv", "svg"]) assert.equal(await service.request("export", { requestId: "left", format }), exportWorldData(left, format));
  assert.equal(await service.request("export", { requestId: "left", compareWith: "right", format: "json" }), exportWorldData(compareWorldData(left, right), "json"));
  await assert.rejects(service.request("query", { requestId: "left", limit: 101 }), /范围/);
  for (let i = 0; i < 3; i++) await service.request("put", { requestId: "extra" + i, snapshot: snapshot(i) });
  await assert.rejects(service.request("query", { requestId: "left" }), /过期/);
  await service.dispose(); await assert.rejects(service.request("query", { requestId: "right" }), /关闭/);
});
