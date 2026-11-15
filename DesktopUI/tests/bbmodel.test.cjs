const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { importModelProject, prepareModelProject, writeModelProject } = require("../electron/domains/profiles/model-projects.cjs");
const { createModel, createTexture } = require("../electron/domains/profiles/content-files.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

function example() {
  return { identifier: "geometry.demo", textureWidth: 64, textureHeight: 32, bones: [
    { name: "root", pivot: [1, 2, 3], rotation: [10, 20, 30], cubes: [{ origin: [2, 4, 6], size: [3, 5, 7], pivot: [4, 8, 10], rotation: [5, 15, 25], uv: [2, 3], mirror: true, inflate: 0.5 }] },
    { name: "child", parent: "root", pivot: [1, 5, 3], rotation: [0, 0, 0], cubes: [{ origin: [1, 2, 3], size: [2, 3, 4], pivot: [0, 0, 0], rotation: [0, 0, 0], inflate: 0, uv: { north: { uv: [1, 2], uv_size: [3, 4] }, up: { uv: [4, 5], uv_size: [-2, 3] } } }] },
  ], animations: { "animation.wave": { loop: true, animation_length: 2, bones: { root: { rotation: { "0.00": [0, "math.sin(q.anim_time * 360) * 20", 0], "1.00": { post: [10, 20, 30], lerp_mode: "catmullrom" } } }, child: { position: [1, 2, 3] } } } } };
}

test("bbmodel 5.0 uses official Bedrock coordinate and top face conventions", () => {
  const original = example(), snapshot = JSON.stringify(original);
  const model = exportProject(original);
  assert.equal(model.meta.format_version, "5.0");
  assert.deepEqual(model.groups[0].origin, [-1, 2, 3]);
  assert.deepEqual(model.groups[0].rotation, [-10, -20, 30]);
  assert.deepEqual(model.elements[0].from, [-5, 4, 6]);
  assert.deepEqual(model.elements[0].to, [-2, 9, 13]);
  assert.deepEqual(model.elements[0].rotation, [-5, -15, 25]);
  assert.deepEqual(model.elements[1].faces.up.uv, [2, 8, 4, 5]);
  assert.equal(model.animations[0].animators[model.groups[0].uuid].keyframes[0].data_points[0].y, "-(math.sin(q.anim_time * 360) * 20)");
  const restored = importProject(model);
  assert.deepEqual(restored.bones, original.bones);
  assert.deepEqual(restored.animations["animation.wave"].bones.root, original.animations["animation.wave"].bones.root);
  assert.deepEqual(restored.animations["animation.wave"].bones.child.position["0.00"], [1, 2, 3]);
  assert.equal(JSON.stringify(model).includes("dgnId"), false);
  assert.equal(JSON.stringify(original), snapshot);
});

test("bbmodel 4.10 embedded groups keep original animation axis directions", () => {
  const model = { meta: { format_version: "4.10", model_format: "bedrock", box_uv: true }, name: "old", resolution: { width: 16, height: 16 }, elements: [{ uuid: "cube", type: "cube", from: [-4, 0, 0], to: [0, 4, 4], origin: [0, 0, 0], uv_offset: [0, 0] }], outliner: [{ uuid: "group", name: "body", origin: [0, 0, 0], children: ["cube"] }], animations: [{ name: "animation.old", loop: "once", length: 1, animators: { group: { type: "bone", keyframes: [{ time: 0, channel: "rotation", data_points: [{ x: "10", y: "q.anim_time", z: "30" }] }] } } }] };
  const result = importProject(model);
  assert.deepEqual(result.bones[0].cubes[0].origin, [0, 0, 0]);
  assert.deepEqual(result.animations["animation.old"].bones.body.rotation["0.00"], [10, "q.anim_time", 30]);
});

test("unsupported features and broken references fail before conversion", () => {
  for (const [mutate, pattern] of [
    [m => { m.elements[0].type = "mesh"; }, /网格顶点无效/],
    [m => { m.meta.model_format = "java_block"; }, /Bedrock/],
    [m => { m.meta.format_version = "6.0"; }, /格式/],
    [m => { m.groups[0].name = "__proto__"; }, /名称/],
    [m => { m.elements[0].from[0] = NaN; }, /数值/],
    [m => { m.outliner[0].children.push(m.elements[0].uuid); }, /重复/],
    [m => { m.outliner = []; }, /大纲/],
    [m => { m.textures = [{ source: "file:///private.png" }]; }, /内嵌/],
    [m => { m.textures = [{}, {}]; }, /贴图/],
    [m => { m.animations[0].animators.effects = { type: "effect", keyframes: [{ channel: "marker", time: 0, data_points: [{ effect: "spark" }] }] }; }, /效果通道/],
    [m => { Object.values(m.animations[0].animators)[0].keyframes[0].interpolation = "bezier"; }, /贝塞尔.*表达式/],
    [m => { Object.values(m.animations[0].animators)[0].keyframes[0].time = 0.03; }, /0.05/],
    [m => { m.elements[1].faces.up.rotation = 45; }, /旋转角度/],
  ]) {
    const model = exportProject(example()); mutate(model);
    assert.throws(() => importProject(model), pattern);
  }
  const data = example(); data.animations["animation.wave"].particle_effects = { "0.00": { effect: "spark", locator: "lead" } };
  const particleModel = exportProject(data);
  assert.equal(particleModel.animations[0].animators.effects.keyframes[0].channel, "particle");
  assert.equal(particleModel.animations[0].animators.effects.keyframes[0].data_points[0].locator, "lead");
  assert.deepEqual(importProject(particleModel).animations["animation.wave"].particle_effects["0.00"], { effect: "spark", locator: "lead" });
  data.animations["animation.wave"].particle_effects["0.00"].pre_effect_script = "v.x = 1;";
  data.animations["animation.wave"].particle_effects["0.00"].bind_to_actor = true;
  const bound = exportProject(data);
  assert.equal(bound.animations[0].animators.effects.keyframes[0].data_points[0].script, "v.x = 1;");
  assert.equal(bound.animations[0].animators.effects.keyframes[0].data_points[0].bind_to_actor, true);
  assert.deepEqual(importProject(bound).animations["animation.wave"].particle_effects["0.00"], { effect: "spark", locator: "lead", pre_effect_script: "v.x = 1;", bind_to_actor: true });
  delete data.animations["animation.wave"].particle_effects["0.00"].pre_effect_script;
  delete data.animations["animation.wave"].particle_effects["0.00"].bind_to_actor;
  data.animations["animation.wave"].particle_effects["0.00"].script = "q.anim_time";
  assert.throws(() => exportProject(data), /附加字段/);
  delete data.animations["animation.wave"].particle_effects;
  data.animations["animation.wave"].timeline = { "1.00": "/say hi" };
  const timelineModel = exportProject(data);
  assert.equal(timelineModel.animations[0].animators.effects.keyframes[0].channel, "timeline");
  assert.equal(timelineModel.animations[0].animators.effects.keyframes[0].data_points[0].script, "/say hi");
  assert.equal(importProject(timelineModel).animations["animation.wave"].timeline["1.00"], "/say hi");
  data.animations["animation.wave"].timeline["1.00"] = ["/say a", "/say b"];
  assert.throws(() => exportProject(data), /多条指令/);
  delete data.animations["animation.wave"].timeline;
  data.animations["animation.wave"].sound_effects = { "0.00": { effect: "random.click" } };
  const exported = exportProject(data);
  const sounds = exported.animations[0].animators.effects.keyframes;
  assert.equal(sounds[0].channel, "sound");
  assert.equal(sounds[0].data_points[0].effect, "random.click");
  assert.deepEqual(importProject(exported).animations["animation.wave"].sound_effects["0.00"], { effect: "random.click" });
  data.animations["animation.wave"].sound_effects["0.00"] = { effect: "random.click", pitch: 1.5, volume: 0 };
  const leveled = exportProject(data);
  assert.equal(leveled.animations[0].animators.effects.keyframes[0].data_points[0].pitch, 1.5);
  assert.equal(leveled.animations[0].animators.effects.keyframes[0].data_points[0].volume, 0);
  assert.deepEqual(importProject(leveled).animations["animation.wave"].sound_effects["0.00"], { effect: "random.click", pitch: 1.5, volume: 0 });
  data.animations["animation.wave"].sound_effects["0.00"].pitch = "math.random(0,1)";
  assert.throws(() => exportProject(data), /音高/);
  data.animations = {}; data.bones[0].parent = "child";
  assert.throws(() => exportProject(data), /循环/);
});

test("bbmodel retains face UV rotation through both directions", () => {
  const original = example();
  original.bones[1].cubes[0].uv.up.uv_rotation = 90;
  original.bones[1].cubes[0].uv.north.uv_rotation = 270;
  const model = exportProject(original);
  assert.equal(model.elements[1].faces.up.rotation, 90);
  assert.equal(model.elements[1].faces.north.rotation, 270);
  assert.deepEqual(importProject(model).bones[1].cubes[0].uv, original.bones[1].cubes[0].uv);
});

test("sound lists round-trip and unsupported sound data is rejected rather than truncated", () => {
  const source = example();
  source.animations["animation.wave"].sound_effects = { "0.50": [{ effect: "first" }, { effect: "second" }], "1.00": { effect: "last" } };
  const model = exportProject(source);
  assert.equal(model.animations[0].animators.effects.keyframes[0].data_points.length, 2);
  assert.deepEqual(importProject(model).animations["animation.wave"].sound_effects, source.animations["animation.wave"].sound_effects);
  for (const mutate of [
    value => { value.animations[0].animators.effects.keyframes[0].data_points.push({ effect: "other", file: "/external.wav" }); },
    value => { value.animations[0].animators.effects.keyframes[0].data_points = []; },
    value => { value.animations[0].animators.effects.keyframes.push(value.animations[0].animators.effects.keyframes[0]); },
  ]) {
    const broken = structuredClone(model); mutate(broken); assert.throws(() => importProject(broken), /声音/);
  }
  source.animations["animation.wave"].sound_effects["0.50"][0].note = "must not vanish";
  assert.throws(() => exportProject(source), /附加字段/);
});

test("bbmodel locator elements and legacy group locators use the same axis flip", () => {
  const original = example();
  original.bones[0].locators = { lead: { offset: [1, 2, 3], rotation: [10, 20, 30] }, eye: { offset: [0, 4, 0], ignore_inherited_scale: true } };
  const model = exportProject(original);
  const lead = model.elements.find(item => item.name === "lead");
  assert.equal(lead.type, "locator");
  assert.deepEqual(lead.position, [-1, 2, 3]);
  assert.deepEqual(lead.rotation, [-10, -20, 30]);
  assert.equal(model.outliner[0].children.includes(lead.uuid), true);
  assert.deepEqual(importProject(model).bones[0].locators, original.bones[0].locators);
  const legacy = exportProject(example());
  legacy.groups[0].locators = { lead: { position: [4, 0, -2], rotation: [0, 5, 0], ignore_inherited_scale: false } };
  assert.deepEqual(importProject(legacy).bones[0].locators.lead, { offset: [-4, 0, -2], rotation: [0, -5, 0] });
  lead.visibility = false;
  assert.throws(() => importProject(model), /定位器/);
});

test("import creates an isolated draft, embeds texture and backs up overwritten exports", async () => {
  const root = artifactPath("data"), studio = path.join(root, "studio");
  const library = { list: async () => ({ mods: [] }) };
  const created = await createModel({ identifier: "geometry.source" }, studio);
  const texture = await createTexture(library, { modelPath: created.path, width: 64, height: 32, name: "image" }, null, studio);
  const pixels = await fs.readFile(texture.path);
  const model = exportProject({ ...example(), texture: "data:image/png;base64," + pixels.toString("base64") });
  const source = path.join(root, "external.bbmodel");
  const original = JSON.stringify(model, null, 2);
  await fs.writeFile(source, original, "utf8");
  const result = await importModelProject(source, studio);
  assert.notEqual(path.dirname(result.path), path.dirname(created.path));
  assert.equal(await fs.readFile(source, "utf8"), original);
  assert.equal(await fs.readFile(path.join(path.dirname(result.path), "source.bbmodel"), "utf8"), original);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(result.path), "textures/texture.png")), pixels);
  const geometry = JSON.parse(await fs.readFile(result.path, "utf8"))["minecraft:geometry"][0];
  const bytes = await prepareModelProject(library, { path: result.path, identifier: result.identifier, bones: geometry.bones, textureWidth: 64, textureHeight: 32, texture: model.textures[0].source }, null, studio);
  assert.equal(JSON.parse(bytes).textures[0].source, model.textures[0].source);
  const output = path.join(root, "export.bbmodel");
  await writeModelProject(output, bytes);
  await writeModelProject(output, bytes);
  const backups = (await fs.readdir(root)).filter(name => name.startsWith("export.bbmodel.") && name.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(root, backups[0])), bytes);
  const again = await importModelProject(output, studio);
  assert.deepEqual(JSON.parse(await fs.readFile(again.path, "utf8"))["minecraft:geometry"][0].bones, geometry.bones);
  const before = await fs.readdir(studio);
  model.elements[0].type = "mesh";
  await fs.writeFile(source, JSON.stringify(model), "utf8");
  await assert.rejects(importModelProject(source, studio), /网格顶点无效/);
  assert.deepEqual(await fs.readdir(studio), before);
  await assert.rejects(prepareModelProject(library, { path: source }, null, studio), /只能修改/);
  await assert.rejects(writeModelProject(path.join(root, "bad.json"), bytes), /bbmodel/);
  model.elements[0].type = "cube";
  model.resolution.width = 32;
  await fs.writeFile(source, JSON.stringify(model), "utf8");
  await assert.rejects(importModelProject(source, studio), /尺寸/);
  assert.deepEqual(await fs.readdir(studio), before);
  const link = path.join(root, "linked");
  await fs.symlink(studio, link, "junction");
  await assert.rejects(importModelProject(source, link));
  await assert.rejects(writeModelProject(path.join(link, "redirected.bbmodel"), bytes), /重定向/);
  const invalidPng = structuredClone(model);
  invalidPng.resolution.width = 64;
  invalidPng.textures[0].source = "data:image/png;base64," + Buffer.from("invalid").toString("base64");
  await fs.writeFile(source, JSON.stringify(invalidPng), "utf8");
  await assert.rejects(importModelProject(source, studio), /PNG/);
  assert.deepEqual(await fs.readdir(studio), before);
});
