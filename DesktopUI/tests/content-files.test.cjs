const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { saveManifest, readGeometry, saveGeometry, createModel, deleteModel, listTextures, readTexture, saveTexture, createTexture, listModels, createAnimation, listAnimations, readAnimation, deleteAnimation, renameAnimation, duplicateAnimation } = require("../electron/domains/profiles/content-files.cjs");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-content-"));
  const pack = path.join(root, "npcB");
  await fs.mkdir(pack);
  await fs.writeFile(path.join(pack, "manifest.json"), JSON.stringify({ header: { name: "旧名", version: [1, 0, 0] } }, null, 2));
  const geo = path.join(pack, "model.geo.json");
  await fs.writeFile(geo, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.demo", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1] }] }] }] }, null, 2));
  const library = { async list() { return { mods: [{ path: root, available: true }] }; } };
  return { root, pack, geo, library, async cleanup() { await fs.rm(root, { recursive: true, force: true }); } };
}

test("manifest name and version stay inside the registered mod", async () => {
  const sample = await fixture();
  try {
    const saved = await saveManifest(sample.library, { directory: sample.pack, manifestFile: "manifest.json", name: "新名", version: [1, 2, 3] });
    assert.equal(saved.name, "新名");
    const savedText = JSON.parse(await fs.readFile(path.join(sample.pack, "manifest.json"), "utf8"));
    assert.equal(savedText.header.name, "新名");
    assert.deepEqual(savedText.header.version, [1, 2, 3]);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-outside-"));
    await fs.writeFile(path.join(outside, "manifest.json"), "{}");
    await assert.rejects(saveManifest(sample.library, { directory: outside, manifestFile: "manifest.json", name: "新名", version: [1, 0, 0] }), /只能修改/);
    await fs.rm(outside, { recursive: true, force: true });
  } finally { await sample.cleanup(); }
});

test("deleting an animation removes one clip, or the file when it is the last", async () => {
  const sample = await fixture();
  try {
    const created = await createAnimation(sample.library, { modelPath: sample.geo, name: "wave" }, null, null);
    await deleteAnimation(sample.library, { path: created.path, id: created.id }, null, null);
    await assert.rejects(readAnimation(sample.library, created.path, created.id));
    const shared = path.join(sample.pack, "group.animation.json");
    await fs.writeFile(shared, JSON.stringify({ animations: { "animation.a": { loop: true }, "animation.b": { loop: false } } }, null, 2));
    const renamed = await renameAnimation(sample.library, { path: shared, id: "animation.a", name: "player.wave" }, null, null);
    assert.equal(renamed.id, "animation.player.wave");
    assert.equal((await readAnimation(sample.library, shared, "animation.player.wave")).animation.loop, true);
    const copied = await duplicateAnimation(sample.library, { path: shared, id: "animation.player.wave" }, null, null);
    assert.equal(copied.id, "animation.player.wave2");
    assert.equal((await readAnimation(sample.library, shared, "animation.player.wave2")).animation.loop, true);
    await assert.rejects(renameAnimation(sample.library, { path: shared, id: "animation.b", name: "player.wave" }, null, null), /同名/);
    const entity = path.join(sample.pack, "mob.entity.json");
    const controller = path.join(sample.pack, "mob.animation_controllers.json");
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-anim-outside-"));
    const outside = path.join(outsideRoot, "other.entity.json");
    await fs.writeFile(entity, JSON.stringify({ "minecraft:client_entity": { description: { animations: { wave: "animation.b" }, scripts: { animate: ["animation.b"] } } } }));
    await fs.writeFile(controller, JSON.stringify({ animation_controllers: { "controller.animation.mob": { states: { default: { animations: ["animation.b", "animation.bx"] } } } } }));
    await fs.writeFile(outside, JSON.stringify({ animations: { wave: "animation.b" } }));
    const linked = await renameAnimation(sample.library, { path: shared, id: "animation.b", name: "walk" }, null, null);
    assert.equal(linked.id, "animation.walk");
    assert.equal(linked.references, 2);
    assert.equal(JSON.parse(await fs.readFile(entity, "utf8"))["minecraft:client_entity"].description.animations.wave, "animation.walk");
    assert.deepEqual(JSON.parse(await fs.readFile(controller, "utf8")).animation_controllers["controller.animation.mob"].states.default.animations, ["animation.walk", "animation.bx"]);
    assert.equal(JSON.parse(await fs.readFile(outside, "utf8")).animations.wave, "animation.b");
    await fs.rm(outsideRoot, { recursive: true, force: true });
    await deleteAnimation(sample.library, { path: shared, id: "animation.player.wave" }, null, null);
    await deleteAnimation(sample.library, { path: shared, id: "animation.player.wave2" }, null, null);
    const left = await listAnimations(sample.library, sample.geo);
    assert.deepEqual(left.animations.map(item => item.id), ["animation.walk"]);
    await assert.rejects(deleteAnimation(sample.library, { path: sample.geo, id: "animation.b" }), /只能删除动画文件/);
  } finally { await sample.cleanup(); }
});

test("a new model stays in the toolbox and can create a blank texture", async () => {
  const sample = await fixture();
  const studio = path.join(sample.root, "studio");
  try {
    const created = await createModel({ identifier: "geometry.demo_new" }, studio);
    assert.equal(created.identifier, "geometry.demo_new");
    assert.equal(created.path.startsWith(path.resolve(studio)), true);
    const again = await createModel({ identifier: "geometry.demo_new" }, studio);
    assert.notEqual(again.path, created.path);
    await assert.rejects(createModel({ identifier: "not-a-geometry" }, studio), /geometry/);
    const texture = await createTexture(sample.library, { modelPath: created.path, name: "skin", width: 16, height: 16 }, null, studio);
    assert.equal(texture.name, "skin.png");
    await assert.rejects(createTexture(sample.library, { modelPath: created.path, name: "../skin", width: 16, height: 16 }, null, studio), /贴图名/);
    const listed = await listTextures(sample.library, created.path, null, studio);
    assert.ok(listed.textures.some(item => item.path === texture.path));
    const read = await readTexture(sample.library, texture.path, null, studio);
    assert.equal(read.dataUrl.startsWith("data:image/png;base64,"), true);
    const bytes = await fs.readFile(texture.path);
    assert.equal(bytes.readUInt32BE(16), 16);
    assert.equal(bytes.readUInt32BE(20), 16);
    const models = await listModels(sample.library, studio);
    assert.ok(models.models.some(item => item.path === created.path && item.draft));
    await deleteModel(sample.library, created.path, studio);
    await assert.rejects(readGeometry(sample.library, created.path, null, studio));
    const stamped = await createModel({ identifier: "geometry.keep_id" }, studio);
    const geometry = await readGeometry(sample.library, stamped.path, null, studio);
    const bones = geometry.geometries[0].bones.map(bone => ({ ...bone, cubes: (bone.cubes || []).map(cube => ({ ...cube, dgnId: "c1" })) }));
    await saveGeometry(sample.library, { path: stamped.path, identifier: stamped.identifier, bones }, null, studio);
    assert.equal((await fs.readFile(stamped.path, "utf8")).includes("dgnId"), false);
  } finally { await sample.cleanup(); }
});

test("geometry cube edits write back to the same identifier", async () => {
  const sample = await fixture();
  try {
    const read = await readGeometry(sample.library, sample.geo);
    const bones = read.geometries[0].bones;
    bones[0].cubes[0].size = [2, 3, 4];
    await saveGeometry(sample.library, { path: sample.geo, identifier: "geometry.demo", bones, textureWidth: 64, textureHeight: 32 });
    const again = await readGeometry(sample.library, sample.geo);
    assert.deepEqual(again.geometries[0].bones[0].cubes[0].size, [2, 3, 4]);
    assert.equal(again.geometries[0].textureHeight, 32);
  } finally { await sample.cleanup(); }
});
