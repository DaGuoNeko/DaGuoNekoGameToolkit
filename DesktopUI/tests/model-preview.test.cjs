const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { faceUvCorners } = require("../shared/model-edit.cjs");
const { curveSamples, trackOf, sampleTrack } = require("../src/features/skins/npc-clip.cjs");
const output = artifactPath("build/model-view.cjs");
buildSync({ entryPoints: [require.resolve("../src/features/skins/npc-model-view.jsx")], bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "silent" });
const { buildModel, applyClip } = require(output);
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");

test("controller mix reaches real Three.js bones including static pivots and channel defaults", () => {
  const built = buildModel({ tw: 16, th: 16, bones: [{ name: "body", pivot: [16, 32, 0], rotation: [10, 0, 0], cubes: [] }, { name: "child", parent: "body", pivot: [16, 48, 0], cubes: [] }] });
  const pose = controllerPose({ states: { default: { animations: ["animation.a", { "animation.b": 0.5 }] } } }, "default", {
    "animation.a": controllerClip({ bones: { body: { rotation: [0, 20, 0], position: [16, 0, 0], scale: [2, 1, 1] } } }),
    "animation.b": controllerClip({ bones: { body: { rotation: [0, 40, 0], scale: [3, 1, 1] }, child: { position: [0, 16, 0] } } }),
  }, 0);
  applyClip(built.groups, pose.clip, pose.time);
  const body = built.groups.get("body"), child = built.groups.get("child");
  assert.ok(Math.abs(body.rotation.x - Math.PI / 18) < 1e-8);
  assert.ok(Math.abs(body.rotation.y - 40 * Math.PI / 180) < 1e-8);
  assert.deepEqual(body.position.toArray(), [2, 2, 0]);
  assert.deepEqual(body.scale.toArray(), [4, 1, 1]);
  assert.deepEqual(child.position.toArray(), [0, 1.5, 0]);
  applyClip(built.groups, null, 0);
  assert.deepEqual(body.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(body.position.toArray(), [1, 2, 0]);
});

test("shortest Euler transition preserves real hierarchy and base rotations", () => {
  const bones = [{ name: "parent", pivot: [0, 1, 0], rotation: [20, 30, 10], cubes: [] }, { name: "child", parent: "parent", pivot: [0, 3, 0], rotation: [5, 10, 15], cubes: [] }];
  const actual = buildModel({ tw: 16, th: 16, bones }), expected = buildModel({ tw: 16, th: 16, bones });
  const controller = { states: { a: { animations: ["animation.a"], blend_transition: 2, blend_via_shortest_path: true }, b: { animations: ["animation.b"] } } };
  const make = rotation => controllerClip({ bones: { child: { rotation } } });
  const result = controllerPose(controller, "b", { "animation.a": make([170, -170, 350]), "animation.b": make([-170, 170, 10]) }, 1, { state: "a", time: 2, duration: 2 });
  applyClip(actual.groups, result.clip, 0); applyClip(expected.groups, make([180, -180, 360]), 0);
  actual.root.updateMatrixWorld(true); expected.root.updateMatrixWorld(true);
  for (const name of ["parent", "child"]) {
    const a = actual.groups.get(name).matrixWorld.elements, b = expected.groups.get(name).matrixWorld.elements;
    a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-10));
  }
});

test("real geometry UV vertices rotate by quarter turns, including signed UV sizes", () => {
  assert.deepEqual(faceUvCorners([2, 3, 8, 4], 90), [[2, 7], [2, 3], [10, 7], [10, 3]]);
  for (const rotation of [0, 90, 180, 270]) {
    const rect = [10, 12, -8, -4];
    const built = buildModel({ tw: 64, th: 64, bones: [{ name: "body", cubes: [{ origin: [0, 0, 0], size: [8, 12, 4], uv: { north: { uv: rect.slice(0, 2), uv_size: rect.slice(2), uv_rotation: rotation } } }] }] });
    const uv = built.meshes[0].geometry.attributes.uv;
    const actual = [20, 21, 22, 23].map(index => [uv.getX(index) * 64, uv.getY(index) * 64]);
    assert.deepEqual(actual, faceUvCorners(rect, rotation));
    for (const mesh of built.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});

test("curve drawing samples the same linear and Catmull-Rom functions as playback", () => {
  const values = { "0": [0, 0, 0], "1": [0, 0, 0], "2": { post: [10, 0, 0], lerp_mode: "catmullrom" }, "3": [0, 0, 0] };
  const keys = trackOf(values), points = curveSamples(keys, 3, 0);
  assert.ok(points.length > 100);
  assert.equal(points.find(([t]) => t === 1.5)[1], sampleTrack(keys, 1.5)[0]);
  assert.notEqual(points.find(([t]) => t === 1.5)[1], 5);
  for (const [time, value] of points) assert.equal(value, sampleTrack(keys, time)[0]);
  const linear = curveSamples(trackOf({ 0: [0, 0, 0], 1: [10, 0, 0] }), 1, 0);
  assert.equal(linear.find(([t]) => t === 0.5)[1], 5);
});

test("face texture mode creates independent materials and hides absent faces without changing NPC previews", () => {
  const bones = [{ name: "body", cubes: [{ origin: [0,0,0], size: [2,2,2], uv: { south: { uv:[0,0], uv_size:[2,2], dgn_texture:"textures/red.png" }, east: { uv:[0,0], uv_size:[2,2], dgn_texture:"textures/blue.png" } } }] }];
  const model=buildModel({tw:16,th:16,bones,faceTextures:true});
  const materials=model.meshes[0].material;
  assert.equal(materials.length,6);assert.equal(materials[0].userData.textureKey,"textures/blue.png");assert.equal(materials[4].userData.textureKey,"textures/red.png");
  assert.equal(materials[1].visible,false);assert.equal(materials[4].visible,true);
  for(const mesh of model.meshes){mesh.geometry.dispose();for(const material of mesh.material)material.dispose();}
  const npc=buildModel({tw:16,th:16,bones});assert.equal(Array.isArray(npc.meshes[0].material),false);npc.meshes[0].geometry.dispose();npc.meshes[0].material.dispose();
});

test("step graph has a vertical jump and preserves pre/post values", () => {
  const keys = trackOf({ 0: [0, 0, 0], 1: { pre: [0, 0, 0], post: [10, 0, 0] }, 2: [10, 0, 0] });
  const points = curveSamples(keys, 2, 0);
  assert.deepEqual(points.filter(([time]) => time === 1), [[1, 0], [1, 10]]);
  assert.equal(points.filter(([time]) => time < 1).every(([, value]) => value === 0), true);
  assert.deepEqual(curveSamples([], 1, 0), []);
});
