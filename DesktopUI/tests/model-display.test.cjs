const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { displayPresets, normalizeDisplay, displayPose, assignDisplay, clearDisplay } = require("../shared/model-display.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { readGeometry, saveGeometry } = require("../electron/domains/profiles/content-files.cjs");

test("display slots keep Blockbench order and only store explicit values", () => {
  assert.deepEqual(Object.keys(displayPresets), ["thirdperson_righthand", "thirdperson_lefthand", "firstperson_righthand", "firstperson_lefthand", "ground", "gui", "head", "fixed"]);
  assert.deepEqual(displayPose({}, "gui"), displayPresets.gui);
  const saved = assignDisplay({}, "gui", { scale: [1, 1, 1] });
  assert.deepEqual(saved.gui.rotation, displayPresets.gui.rotation);
  assert.deepEqual(saved.gui.scale, [1, 1, 1]);
  assert.deepEqual(clearDisplay(saved, "gui"), {});
  assert.throws(() => normalizeDisplay({ watermark: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] } }), /槽位/);
  assert.throws(() => assignDisplay({}, "fixed", { scale: [0, 1, 1] }), /缩放/);
});

test("bbmodel display round-trips without the bone axis flip", () => {
  const display = { gui: { rotation: [30, 225, 0], translation: [1, -2, 3], scale: [0.625, 0.625, 0.625] } };
  const model = exportProject({ identifier: "geometry.demo", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }], display });
  assert.deepEqual(model.display.gui.translation, [1, -2, 3]);
  assert.deepEqual(importProject(model).display, display);
  assert.deepEqual(importProject(exportProject({ identifier: "geometry.demo", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [] }] })).display, {});
});

test("geometry save keeps display outside minecraft:geometry and can clear it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-display-"));
  const pack = path.join(root, "pack");
  await fs.mkdir(pack);
  const geo = path.join(pack, "model.geo.json");
  const bones = [{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1] }] }];
  await fs.writeFile(geo, JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.demo", texture_width: 16, texture_height: 16 }, bones }] }, null, 2));
  const library = { async list() { return { mods: [{ path: root, available: true }] }; } };
  try {
    const display = { head: displayPresets.head };
    await saveGeometry(library, { path: geo, identifier: "geometry.demo", bones, textureWidth: 16, textureHeight: 16, display }, null, null);
    const text = await fs.readFile(geo, "utf8");
    const stored = JSON.parse(text);
    assert.deepEqual(stored.dgn_display["geometry.demo"].head, displayPresets.head);
    assert.equal(stored["minecraft:geometry"][0].description.dgn_display, undefined);
    assert.deepEqual((await readGeometry(library, geo, null, null)).geometries[0].display, display);
    await saveGeometry(library, { path: geo, identifier: "geometry.demo", bones, display: {} }, null, null);
    const cleared = JSON.parse(await fs.readFile(geo, "utf8"));
    assert.equal(cleared.dgn_display, undefined);
    assert.deepEqual((await readGeometry(library, geo, null, null)).geometries[0].bones[0].name, "body");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
