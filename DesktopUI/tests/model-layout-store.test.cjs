const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { WorkspaceStore } = require("../electron/services.cjs");
const { defaultLayout, validateLayout, normalizeLayouts } = require("../shared/model-layout.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

async function fixture(name) {
  const root = artifactPath(name);
  const store = new WorkspaceStore(root);
  await store.load();
  await store.updateSettings({ ThemeHue: 123 });
  return { store, root, file: path.join(root, "settings.json") };
}

test("persistent layout validates modes, numeric ranges and unexpected fields", () => {
  for (const value of [null, [], { left: "280", right: 280, split: 0.5 }, { left: 481, right: 280, split: 0.5 }, { left: 280, right: NaN, split: 0.5 }, { left: 280, right: 280, split: 1.1 }, { left: 280, right: 280, split: 0.5, path: "x" }]) {
    assert.throws(() => validateLayout("edit", value), /布局/);
  }
  assert.throws(() => validateLayout("__proto__", defaultLayout("edit")), /模式/);
  assert.deepEqual(normalizeLayouts({ edit: { left: -5 }, animate: defaultLayout("animate"), unknown: {} }), { animate: defaultLayout("animate") });
});

test("sequential layout writes survive restart and preserve other settings plus unknown disk fields", async () => {
  const { store, root, file } = await fixture("roundtrip");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  disk.settings.futureOption = { keep: 42 }; disk.extension = "keep";
  await fs.writeFile(file, JSON.stringify(disk), "utf8");
  const edit = { left: 330, right: 245, split: 0.4 }, paint = { left: 310, right: 260, split: 0.6 };
  await Promise.all([store.saveModelLayout("edit", edit), store.saveModelLayout("paint", paint), store.saveModelLayout("edit", { ...edit, left: 350 })]);
  const reopened = new WorkspaceStore(root); await reopened.load();
  assert.deepEqual((await reopened.readModelLayouts()).layouts, { edit: { ...edit, left: 350 }, paint });
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.settings.ThemeHue, 123);
  assert.deepEqual(saved.settings.futureOption, { keep: 42 }); assert.equal(saved.extension, "keep");
  assert.ok(await fs.stat(file + ".bak"));
  await reopened.saveModelLayout("edit", defaultLayout("edit"));
  const again = new WorkspaceStore(root); await again.load();
  assert.deepEqual((await again.readModelLayouts()).layouts, { edit: defaultLayout("edit"), paint });
});

test("malformed saved modes use defaults without changing disk until a valid save", async () => {
  const { root, file } = await fixture("invalid");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  disk.settings.ModelStudioLayouts = { edit: { left: "broken" }, paint: defaultLayout("paint") };
  const raw = JSON.stringify(disk); await fs.writeFile(file, raw, "utf8");
  const store = new WorkspaceStore(root); await store.load();
  assert.match(store.warning, /布局含无效数据/);
  assert.deepEqual((await store.readModelLayouts()).layouts, { paint: defaultLayout("paint") });
  assert.equal(await fs.readFile(file, "utf8"), raw);
  await store.saveModelLayout("edit", defaultLayout("edit"));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).settings.ModelStudioLayouts, { paint: defaultLayout("paint"), edit: defaultLayout("edit") });
  assert.equal(await fs.readFile(file + ".bak", "utf8"), raw);
  await store.saveModelLayout("solid", defaultLayout("solid"));
  await store.saveModelLayout("paint", { left: 310, right: 280, split: 0.5 });
  const restarted = new WorkspaceStore(root); await restarted.load();
  assert.equal(restarted.warning, "", "模式字段顺序不能当作异常数据");
  await restarted.saveModelLayout("animate", defaultLayout("animate"));
});

test("write failure keeps store and disk unchanged; retry works after the obstacle is removed", async () => {
  const { store, file } = await fixture("failed");
  const before = await fs.readFile(file, "utf8");
  await fs.mkdir(file + ".bak");
  await assert.rejects(store.saveModelLayout("edit", defaultLayout("edit")));
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual((await store.readModelLayouts()).layouts, {});
  await fs.rmdir(file + ".bak");
  await store.saveModelLayout("edit", { left: 350, right: 280, split: 0.5 });
  assert.equal((await store.readModelLayouts()).layouts.edit.left, 350);
});

test("external settings changes and invalid renderer writes are refused without replacing data", async () => {
  const { store, file } = await fixture("conflict");
  await store.saveModelLayout("edit", defaultLayout("edit"));
  const external = JSON.parse(await fs.readFile(file, "utf8"));
  delete external.settings.ModelStudioLayouts;
  const raw = JSON.stringify(external); await fs.writeFile(file, raw, "utf8");
  await assert.rejects(store.saveModelLayout("paint", defaultLayout("paint")), /外部修改/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  await assert.rejects(store.updateSettings({ ModelStudioLayouts: { edit: { left: Infinity, right: 0, split: 0 } } }), /布局/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
});
