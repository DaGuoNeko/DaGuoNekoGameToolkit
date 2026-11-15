const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultViews, validateViews, normalizeViews } = require("../shared/model-views.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

test("view sessions reject unknown fields and repair a corrupt record to the default", () => {
  const saved = defaultViews();
  saved.quad = true;
  saved.active = 2;
  saved.slots[0] = { view: "north", custom: true, position: [1, 2, 3], target: [0, 1, 0], span: 4.5, zoom: 1.25 };
  assert.deepEqual(validateViews(saved).slots[0].position, [1, 2, 3]);
  for (const value of [null, [], { ...saved, extra: 1 }, { ...saved, active: 4 }, { ...saved, slots: saved.slots.slice(0, 3) }]) assert.throws(() => validateViews(value), /视角/);
  const broken = defaultViews();
  broken.slots[1].position = [1e9, 0, 0];
  assert.deepEqual(normalizeViews(broken), defaultViews());
  assert.deepEqual(normalizeViews(undefined), defaultViews());
});

test("saved camera sessions survive restart and invalid records do not overwrite the file", async () => {
  const root = artifactPath("views");
  const store = new WorkspaceStore(root);
  await store.load();
  const session = defaultViews();
  session.quad = true;
  session.active = 1;
  session.slots[1] = { view: "west", custom: true, position: [4, 5, 6], target: [0, 1, 0], span: 8, zoom: 2 };
  await store.saveModelViews(session);
  const reopened = new WorkspaceStore(root);
  await reopened.load();
  assert.deepEqual((await reopened.readModelViews()).views, session);
  const file = require("node:path").join(root, "settings.json");
  const fs = require("node:fs/promises");
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  disk.settings.ModelStudioViews = { quad: "yes" };
  const raw = JSON.stringify(disk);
  await fs.writeFile(file, raw, "utf8");
  const broken = new WorkspaceStore(root);
  await broken.load();
  assert.match(broken.warning, /视角含无效数据/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  assert.deepEqual((await broken.readModelViews()).views, defaultViews());
});
