const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AutomationRouter } = require("../electron/domains/automation/automation-router.cjs");
const { validate } = require("../electron/domains/automation/automation-tools.cjs");
const { runContentCommand } = require("../electron/domains/profiles/content-commands.cjs");
const json = (value) => JSON.parse(value.content[0].text);

test("content MCP schemas stay inside registered content and confirmed writes", () => {
  validate("list_content", {});
  validate("read_content", { view: "files", limit: 1 });
  assert.throws(() => validate("save_geometry", { path: "C:/model.geo.json", identifier: "geometry.a", bones: [] }), /参数无效/);
  assert.throws(() => validate("read_content", { limit: 101 }), /参数无效/);
  assert.throws(() => validate("list_models", { path: "C:/outside" }), /参数无效/);
});

test("content reads omit previews and do not scan a missing world", async () => {
  let scanned = false;
  const scan = {
    generatedAt: "t", summary: { assetCount: 2 }, issues: [], limits: {}, sources: [{ id: "s" }],
    packs: [{ id: "p", assets: [{ preview: "hidden" }], entries: [] }],
    assets: [{ type: "texture", path: "a.png", preview: "data:image/png;base64,AAAA" }],
    entries: [
      { type: "model", identifier: "geometry.a", label: "A", texture: { path: "t.png", preview: "hide" } },
      { type: "item", identifier: "ns:item", label: "Item" },
    ],
  };
  const router = new AutomationRouter({
    modLibrary: {},
    contentIndex: { scan: async () => { scanned = true; return scan; } },
    studioRoot: path.join(os.tmpdir(), "dgn-unused-studio"),
  });
  const listed = json(await router.call("list_content", {}));
  assert.equal(scanned, true);
  assert.equal(listed.packs[0].assets, undefined);
  assert.equal(JSON.stringify(listed).includes("preview"), false);
  const page = json(await router.call("read_content", { type: "model" }));
  assert.equal(page.total, 1);
  assert.equal(page.rows[0].texture.path, "t.png");
  assert.equal(page.rows[0].texture.preview, undefined);
  await assert.rejects(runContentCommand("content.scan", { worldId: "missing" }, {
    worlds: {
      read: async () => ({}),
      find: () => ({ id: "missing", name: "missing" }),
      inspect: async () => ({ deleted: false, ready: false, present: true }),
    },
    contentIndex: { scan: async () => { throw new Error("should not scan"); } },
  }), /尚未生成/);
  await assert.rejects(new AutomationRouter({}).call("list_skins", {}), /不支持/);
});

test("model creation replays the same request and skin reads return an image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mcp-model-"));
  let created = 0;
  try {
    const router = new AutomationRouter({
      modLibrary: { list: async () => ({ mods: [] }) },
      contentIndex: { scan: async () => ({}) },
      studioRoot: root,
      skins: {
        image: async (id) => id === "skin" ? "data:image/png;base64,AQID" : "",
        create: async () => { created += 1; return { skin: { id: "new" } }; },
      },
    });
    const args = { instanceId: router.instanceId, requestId: "create-model", confirmed: true, identifier: "geometry.mcp_demo" };
    const first = json(await router.call("create_model", args));
    const second = json(await router.call("create_model", args));
    assert.equal(second.path, first.path);
    assert.equal(json(await router.call("list_models", {})).models.length, 1);
    await assert.rejects(router.call("create_model", { ...args, identifier: "geometry.other" }), /另一组写入参数/);
    const image = await router.call("read_skin", { id: "skin" });
    assert.equal(image.content[0].type, "image");
    assert.equal(image.content[0].data, "AQID");
    const skinArgs = { instanceId: router.instanceId, requestId: "create-skin", confirmed: true, name: "甲", author: "乙" };
    await router.call("create_skin", skinArgs);
    await router.call("create_skin", skinArgs);
    assert.equal(created, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("controller MCP tools reuse the model path guard and revision save", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mcp-controller-"));
  const geo = path.join(root, "model.geo.json");
  const library = { list: async () => ({ mods: [{ path: root, available: true }] }) };
  try {
    await fs.writeFile(geo, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.demo" }, bones: [] }] }));
    const router = new AutomationRouter({ modLibrary: library, contentIndex: { scan: async () => ({}) }, studioRoot: path.join(root, "studio") });
    const createArgs = { instanceId: router.instanceId, requestId: "controller-create", confirmed: true, modelPath: geo, name: "mob" };
    const created = json(await router.call("create_controller", createArgs));
    const listed = json(await router.call("list_controllers", { path: geo }));
    assert.deepEqual(listed.controllers, [{ path: created.path, id: "controller.animation.mob" }]);
    const read = json(await router.call("read_controller", { path: created.path }));
    const saved = json(await router.call("save_controller", {
      instanceId: router.instanceId, requestId: "controller-save", confirmed: true,
      path: created.path, revision: read.revision, document: read.document,
    }));
    assert.match(saved.revision, /^[a-f0-9]{64}$/);
    await fs.appendFile(created.path, "\n");
    await assert.rejects(router.call("save_controller", {
      instanceId: router.instanceId, requestId: "controller-stale", confirmed: true,
      path: created.path, revision: read.revision, document: read.document,
    }), /已变化/);
    const foreign = path.join(os.tmpdir(), "foreign.animation_controllers.json");
    await fs.writeFile(foreign, JSON.stringify({ animation_controllers: {} }));
    await assert.rejects(router.call("read_controller", { path: foreign }), /只能修改|只能读取/);
    await fs.rm(foreign, { force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
