const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const nbt = require("prismarine-nbt");
const { worldDataFixture } = require("./fixtures/world-data.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { scanWorldData } = require("../electron/domains/worlds/world-data.cjs");
const { parseNbtRecord } = require("../electron/domains/worlds/world-data-codec.cjs");
const { detectCapabilities } = require("../shared/world-data-capabilities.cjs");
const { businessObjects, references, queryWorldData, summarizeSnapshot, compareWorldData } = require("../shared/world-data-model.cjs");
const { describeObject } = require("../shared/world-data-presentation.cjs");
const caps = { npc: { state: "enabled" }, quest: { state: "enabled" }, library: { state: "enabled" } };

test("installed but inactive mods and stale ExtraData do not enable business views", async () => {
  const root = artifactPath("inactive"); await worldDataFixture(root, { enabledMods: false });
  const result = await scanWorldData({ source: root, dataRoot: artifactPath("unused") });
  assert.equal(result.complete, true); assert.equal(result.extraData, true); assert.equal(result.edition, "netease");
  for (const kind of ["npc", "quest", "dialogue", "library", "attributes"]) {
    assert(!result.availableKinds.includes(kind)); assert(!result.objects.some(row => row.kind === kind));
  }
  assert(result.objects.some(row => row.kind === "extra" && row.name === "Quest_Engine_Data"));
  assert(!result.relations.some(row => /^(library|quest|dialogue):/.test(row.target)));
  assert(result.objects.some(row => row.kind === "entity"));
});
test("active mods can have no saved data; ExtraData is optional", async () => {
  const root = artifactPath("no-extra"); await worldDataFixture(root, { extra: false });
  const result = await scanWorldData({ source: root, dataRoot: artifactPath("unused-2") });
  assert.equal(result.extraData, false); assert.equal(result.complete, true);
  assert(!result.availableKinds.includes("extra")); assert(result.availableKinds.includes("quest"));
  assert(!result.objects.some(row => row.kind === "quest" || row.kind === "npc"));
});
test("binding version, duplicate UUID and missing lists fail closed", () => {
  const pack = { id: "fixture", kind: "behavior", version: [1, 0, 0], assets: ["customNPCScripts/modMain.py", "customNPCScripts/customNPCServerSystem/customNPCServerSystem.py"].map(relative => ({ relative, size: 10 })) };
  assert.equal(detectCapabilities([pack], [{ pack_id: "fixture", version: [1, 0, 0] }]).npc.state, "enabled");
  assert.equal(detectCapabilities([pack], [{ pack_id: "fixture", version: [2, 0, 0] }]).npc.state, "version-mismatch");
  assert.equal(detectCapabilities([pack, pack], [{ pack_id: "fixture", version: [1, 0, 0] }]).npc.state, "ambiguous");
  assert.equal(detectCapabilities([pack], null).npc.state, "unconfirmed");
  assert.equal(detectCapabilities([{ ...pack, assets: [] }], [{ pack_id: "fixture", version: [1, 0, 0] }]).npc.state, "disabled");
});
test("corrupt enablement list leaves raw data available and marks partial coverage", async () => {
  const root = artifactPath("bad-list"); await worldDataFixture(root);
  await fs.writeFile(path.join(root, "world_behavior_packs.json"), "{}", "utf8");
  const result = await scanWorldData({ source: root, dataRoot: artifactPath("unused-3") });
  assert.equal(result.complete, false); assert.equal(result.capabilities.npc.state, "unconfirmed");
  assert(result.objects.some(row => row.kind === "extra"));
});
test("Java string named scriptData remains a string", () => {
  const bytes = nbt.writeUncompressed(nbt.comp({ scriptData: nbt.string("ordinary Java data") }));
  const parsed = parseNbtRecord(bytes, { little: false });
  assert.equal(parsed.value.scriptData, "ordinary Java data"); assert.equal(parsed.types["/scriptData"], "string");
});
test("business projections retain types and per-owner identities", () => {
  const record = { id: "a", identity: "player:a", types: { "/scriptData/Quest_Engine_Player_Data/count": "long" }, value: { scriptData: { Quest_Engine_Player_Data: { count: "9007199254740993" } } }, evidence: {} };
  const a = businessObjects(record, caps), b = businessObjects({ ...record, id: "b", identity: "player:b" }, caps);
  assert.notEqual(a[0].identity, b[0].identity); assert.equal(a[1].types["/count"], "long");
  assert.notEqual(a[0].id, a[1].id);
  assert.equal(a[1].value.count, "9007199254740993");
});
test("field pagination reads escaped paths without prototype traversal or oversized values", () => {
  const result = { objects: [{ id: "one", value: { "a/b": { "~key": Array.from({ length: 120 }, (_, i) => i) }, text: "x".repeat(20000) }, types: { "/text": "string" } }] };
  const page = queryWorldData(result, { view: "fields", id: "one", field: "/a~1b/~0key", offset: 100, limit: 20 });
  assert.equal(page.total, 120); assert.equal(page.rows[0].preview, "100");
  const text = queryWorldData(result, { view: "fields", id: "one", field: "/text" }).rows[0];
  assert.equal(text.preview.length, 8192); assert.equal(text.truncated, true); assert.equal(text.type, "string");
  assert.throws(() => queryWorldData(result, { view: "fields", id: "one", field: "/__proto__" }), /不存在/);
  assert.throws(() => queryWorldData(result, { view: "fields", id: "one", field: "text" }), /路径/);
});
test("reverse references and summaries include structured command callbacks", () => {
  const objects = [{ id: "command", identity: "command:0:0,0,0", kind: "command", name: "入口方块", value: { Command: "miao:cmd 指令库 init 0 @s" } }, { id: "library", identity: "library:init", name: "初始化", kind: "library", value: { commands: [{ cmd: "cmd(next)", delay_ticks: 3 }] } }];
  const result = { objects, relations: references(objects, caps) };
  const incoming = queryWorldData(result, { view: "relations", id: "library", direction: "incoming" });
  assert.equal(incoming.total, 1); assert.equal(incoming.rows[0].fromName, "入口方块");
  assert.equal(queryWorldData(result, { view: "relations", id: "library", direction: "outgoing" }).rows[0].target, "library:next");
  assert.equal(describeObject(objects[1]).sections[0].rows[0].note, "延迟 3 脚本刻");
  assert(!queryWorldData(result).rows[0].summary.sections);
  assert(queryWorldData(result, { id: "library" }).rows[0].summary.sections.length);
  assert.equal(summarizeSnapshot(result).objectCount, 2); assert.equal(summarizeSnapshot(result).relations, undefined);
});
test("comparison explains slot changes and does not claim removals across coverage or mod changes", () => {
  const object = { id: "chest", identity: "container:0:1,2,3", kind: "container", name: "箱子", value: { Items: [{ Slot: 0, Name: "fixture:apple", Count: 1 }] } };
  const before = { complete: true, scope: "all", capabilities: caps, objects: [object] }, after = structuredClone(before);
  after.objects[0].value.Items[0].Count = 5;
  const field = compareWorldData(before, after).changes[0].fields[0];
  assert.equal(field.path, "/Items/0/Count"); assert.equal(field.label, "容器物品 / 0 / 物品数量");
  const partial = compareWorldData(before, { ...before, capabilities: {}, objects: [] });
  assert.equal(partial.partial, true); assert.equal(partial.changes[0].status, "not-observed-right");
  before.objects[0].value.Items.push({ Slot: 8, Name: "fixture:stone", Count: 4 });
  const reordered = structuredClone(before); reordered.objects[0].value.Items.reverse();
  assert.equal(compareWorldData(before, reordered).changes.length, 0);
});
