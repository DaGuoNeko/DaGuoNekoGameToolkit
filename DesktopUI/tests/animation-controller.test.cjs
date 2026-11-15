const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createController, addState, removeState, setStateAnimations, addTransition, removeTransition, animationsOf, transitionsOf } = require("../shared/animation-controller.cjs");
const { createControllerFile, readController, saveController } = require("../electron/domains/profiles/content-files.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { importModelProject, prepareModelProject } = require("../electron/domains/profiles/model-projects.cjs");

test("controller states keep animations and drop transfers to a deleted state", () => {
  let doc = createController(null, "mob");
  doc = addState(doc, "controller.animation.mob", "walk");
  doc = setStateAnimations(doc, "controller.animation.mob", "default", ["animation.idle"]);
  doc = addTransition(doc, "controller.animation.mob", "default", "walk", "query.is_moving");
  doc.animation_controllers["controller.animation.mob"].states.walk.on_entry = ["event.walk"];
  doc = removeState(doc, "controller.animation.mob", "walk");
  const state = doc.animation_controllers["controller.animation.mob"].states.default;
  assert.deepEqual(animationsOf(state), ["animation.idle"]);
  assert.deepEqual(transitionsOf(state), []);
  assert.equal(doc.animation_controllers["controller.animation.mob"].initial_state, "default");
  assert.throws(() => addTransition(createController(null, "mob"), "controller.animation.mob", "default", "default", "1"), /自己/);
  assert.throws(() => removeTransition(createController(null, "mob"), "controller.animation.mob", "default", "walk"), /不存在/);
});

test("bbmodel keeps a bedrock controller object and an array of controllers", async () => {
  const bones = [{ name: "body", pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }];
  const controllers = addState(setStateAnimations(createController(null, "mob"), "controller.animation.mob", "default", ["animation.idle"]), "controller.animation.mob", "walk").animation_controllers;
  const project = exportProject({ identifier: "geometry.ctrl", textureWidth: 16, textureHeight: 16, bones, controllers });
  assert.deepEqual(importProject(project).controllers["controller.animation.mob"].states.default.animations, ["animation.idle"]);
  const array = structuredClone(project);
  array.animation_controllers = [{ name: "controller.animation.mob", initial_state: "walk", states: project.animation_controllers["controller.animation.mob"].states }];
  assert.equal(importProject(array).controllers["controller.animation.mob"].initial_state, "walk");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-bb-controller-"));
  const file = path.join(root, "in.bbmodel");
  await fs.writeFile(file, JSON.stringify(project));
  const library = { async list() { return { mods: [{ path: root, available: true }] }; } };
  try {
    const created = await importModelProject(file, root);
    const written = JSON.parse(await fs.readFile(path.join(path.dirname(created.path), "model.animation_controllers.json"), "utf8"));
    assert.deepEqual(written.animation_controllers["controller.animation.mob"].states.default.animations, ["animation.idle"]);
    const bytes = await prepareModelProject(library, { path: created.path, identifier: "geometry.ctrl", bones, textureWidth: 16, textureHeight: 16, texture: "", display: {} }, null, null);
    assert.equal(JSON.parse(bytes.toString("utf8")).animation_controllers["controller.animation.mob"].states.walk.animations.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("controller file is created beside the model and rejects another root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-controller-"));
  const geo = path.join(root, "model.geo.json");
  await fs.writeFile(geo, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.demo" }, bones: [] }] }));
  const library = { async list() { return { mods: [{ path: root, available: true }] }; } };
  try {
    const created = await createControllerFile(library, { modelPath: geo, name: "mob" }, null, null);
    assert.equal(created.id, "controller.animation.mob");
    const read = await readController(library, created.path, null, null);
    const next = addState(read.document, created.id, "walk");
    await saveController(library, { path: created.path, document: next, revision: read.revision }, null, null);
    const again = await readController(library, created.path, null, null);
    assert.equal(again.document.animation_controllers[created.id].states.walk.animations.length, 0);
    const beforeConflict = await fs.readFile(created.path);
    await assert.rejects(saveController(library, { path: created.path, document: read.document, revision: read.revision }), /已变化/);
    assert.deepEqual(await fs.readFile(created.path), beforeConflict);
    assert.deepEqual(JSON.parse(await fs.readFile(created.path + ".bak", "utf8")), read.document);
    await assert.rejects(saveController(library, { path: created.path, document: next }), /已变化/);
    await fs.writeFile(created.path, "{ invalid");
    await assert.rejects(readController(library, created.path), /JSON/);
    await assert.rejects(createControllerFile(library, { modelPath: geo, name: "second" }), /JSON/);
    assert.equal(await fs.readFile(created.path, "utf8"), "{ invalid");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-outside-"));
    const foreign = path.join(outside, "model.geo.json");
    await fs.writeFile(foreign, "{}");
    await assert.rejects(createControllerFile(library, { modelPath: foreign, name: "mob" }, null, null), /只能修改/);
    await fs.rm(outside, { recursive: true, force: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
