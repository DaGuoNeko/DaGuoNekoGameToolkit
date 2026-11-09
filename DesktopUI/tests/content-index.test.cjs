const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { ContentIndex } = require("../electron/domains/profiles/content-index.cjs");

test("content index scans pack metadata and common Bedrock content types", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-content-index-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const behavior = path.join(root, "behavior_packs", "items");
  const resource = path.join(root, "resource_packs", "resources");
  await fs.mkdir(path.join(behavior, "netease_items_behaviors"), { recursive: true });
  await fs.mkdir(path.join(resource, "textures", "items"), { recursive: true });
  await fs.mkdir(path.join(resource, "models"), { recursive: true });
  await fs.writeFile(path.join(behavior, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "内容行为包", uuid: "11111111-1111-4111-8111-111111111111", version: [1, 2, 3] }, modules: [{ type: "data", uuid: "22222222-2222-4222-8222-222222222222", version: [1, 2, 3] }] }));
  await fs.writeFile(path.join(resource, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "内容资源包", uuid: "33333333-3333-4333-8333-333333333333", version: [1, 2, 3] }, modules: [{ type: "resources", uuid: "44444444-4444-4444-8444-444444444444", version: [1, 2, 3] }] }));
  await fs.writeFile(path.join(behavior, "netease_items_behaviors", "items.json"), `{
    // JSONC is accepted by existing pack tooling.
    "netease:demo_item": { "identifier": "netease:demo_item" }
  }`);
  await fs.writeFile(path.join(resource, "models", "demo.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.netease_demo" } }] }));
  await fs.mkdir(path.join(resource, "texts"), { recursive: true });
  await fs.writeFile(path.join(resource, "texts", "zh_CN.lang"), "item.netease:demo_item.name=演示物品\n");
  await fs.writeFile(path.join(resource, "item_texture.json"), JSON.stringify({ texture_data: { "netease:demo_item": { textures: "textures/items/demo" } } }));
  await fs.writeFile(path.join(resource, "textures", "items", "demo.png"), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(resource, "broken.json"), "{ broken");
  const index = new ContentIndex({ list: async () => ({ mods: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "测试内容", path: root, available: true, error: "" }] }) });
  const result = await index.scan();
  assert.equal(result.summary.sourceCount, 1);
  assert.equal(result.summary.packCount, 2);
  assert.equal(result.summary.counts.item, 1);
  assert.equal(result.summary.counts.model, 1);
  assert.equal(result.summary.counts.texture, 1);
  assert.ok(result.assets.some(asset => asset.identifiers.includes("netease:demo_item")));
  assert.ok(result.assets.some(asset => asset.identifiers.includes("geometry.netease_demo")));
  const item = result.entries.find(entry => entry.identifier === "netease:demo_item");
  assert.equal(item.displayName, "演示物品");
  assert.equal(item.texture.path.replaceAll("\\", "/").endsWith("textures/items/demo.png"), true);
  assert.equal(result.packs.find(pack => pack.name === "内容资源包").id, "33333333-3333-4333-8333-333333333333");
  assert.ok(result.issues.some(issue => issue.code === "invalid-json"));
  const targeted = await index.scan({ root, packId: "33333333-3333-4333-8333-333333333333", sourceId: "world", sourceName: "目标存档" });
  assert.equal(targeted.summary.packCount, 1);
  assert.equal(targeted.packs[0].name, "内容资源包");
});

test("content index marks duplicate identifiers without changing source files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-content-duplicate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, uuid] of [["A", "11111111-1111-4111-8111-111111111111"], ["B", "22222222-2222-4222-8222-222222222222"]]) {
    const dir = path.join(root, "behavior_packs", name);
    await fs.mkdir(path.join(dir, "items"), { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ header: { name, uuid, version: [1, 0, 0] }, modules: [{ type: "data", uuid: uuid.replace(/[1-2]/g, "3"), version: [1, 0, 0] }] }));
    await fs.writeFile(path.join(dir, "items", "item.json"), JSON.stringify({ identifier: "demo:shared" }));
  }
  const index = new ContentIndex({ list: async () => ({ mods: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "重复测试", path: root, available: true }] }) });
  const result = await index.scan();
  assert.equal(result.summary.duplicateCount, 1);
  assert.ok(result.issues.some(issue => issue.code === "duplicate-identifier"));
  assert.equal(result.assets.filter(asset => asset.status === "warning").length, 2);
  const again = await index.scan();
  assert.deepEqual({ ...again, generatedAt: null }, { ...result, generatedAt: null });
  const edited = path.join(root, "behavior_packs/A/items/item.json");
  await fs.writeFile(edited, JSON.stringify({ identifier: "demo:changed" }));
  const updated = await index.scan();
  assert.equal(updated.summary.duplicateCount, 0);
  assert(updated.assets.some(asset => asset.identifiers.includes("demo:changed")));
  await fs.rename(edited, edited + ".old");
  await fs.writeFile(edited, "{ broken");
  assert((await index.scan()).issues.some(issue => issue.code === "invalid-json"));
  await fs.writeFile(edited, JSON.stringify({ identifier: "demo:shared" }));
  assert.equal((await index.scan()).summary.duplicateCount, 1);
});
