const test = require("node:test"), assert = require("node:assert/strict");
const { worldVertices, moveCubesKeepingPose } = require("./fixtures/model-positions.cjs");
const { moveCubes } = require("../shared/model-cube-operations.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const fixture = () => [
  { name: "root", pivot: [3, -2, 5], rotation: [15, 30, -10], cubes: [] },
  { name: "arm", parent: "root", pivot: [-4, 8, 1], rotation: [20, -45, 12], cubes: [{ name: "a", dgnId: "c1", origin: [-5, 3, -2], size: [3, 8, 4], rotation: [10, -25, 40], uv: [0, 0], inflate: 0.2, mirror: true, extension: { keep: 42 } }] },
  { name: "wrist", parent: "arm", pivot: [-4, 14, 1], rotation: [-20, 18, 35], cubes: [{ name: "b", dgnId: "c2", origin: [-6, 13, -2], size: [4, 2, 3], pivot: [1, 10, 5], rotation: [-12, 60, 20], uv: { north: { uv: [4, 5], uv_size: [-4, 2], uv_rotation: 90 } } }] },
  { name: "destination", parent: "root", pivot: [8, 2, -5], rotation: [40, 23, -50], cubes: [{ name: "stay", dgnId: "c3", origin: [4, 0, 0], size: [2, 3, 4], uv: [1, 2] }] },
];
function sameVertices(actual, expected, tolerance = 1e-7) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const name of Object.keys(expected)) for (let i = 0; i < expected[name].length; i++) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(actual[name][i][axis] - expected[name][i][axis]) <= tolerance, `${name} vertex ${i} axis ${axis}`);
}

test("rest-pose reparent preserves actual rendered vertices for nested rotated bones and leaves other fields intact", () => {
  const bones = fixture(), original = structuredClone(bones), before = worldVertices(bones);
  const moved = moveCubesKeepingPose(bones, ["c1", "c2"], "destination", "c3");
  sameVertices(worldVertices(moved.bones), before); assert.deepEqual(bones, original);
  assert.deepEqual(moved.ids, ["c1", "c2"]); assert.deepEqual(moved.picked, { bone: "destination", cube: 1 });
  for (const source of [bones[1].cubes[0], bones[2].cubes[0]]) {
    const copy = moved.bones[3].cubes.find(cube => cube.dgnId === source.dgnId);
    const { origin: a, rotation: b, pivot: c, ...beforeFields } = source, { origin: d, rotation: e, pivot: f, ...afterFields } = copy;
    assert.deepEqual(afterFields, beforeFields);
  }
  assert.strictEqual(moved.bones[3].cubes[2], bones[3].cubes[0]);
  assert.notDeepEqual(worldVertices(moveCubes(bones, ["c1"], "destination").bones).a, before.a);
  sameVertices(worldVertices(moveCubesKeepingPose(moveCubesKeepingPose(moved.bones, ["c1"], "arm").bones, ["c2"], "wrist").bones), before);
});

test("near singular rotations, signed sizes and absent bone pivots keep the same surface geometry", () => {
  for (const y of [0, 45, 89.99999, 90, -90, 179.99999]) {
    const bones = [{ name: "from", rotation: [37, y, -52], cubes: [{ name: "item", dgnId: "c1", origin: [1, 2, 3], size: [-3, 7, 2], inflate: -0.1, uv: [0, 0] }] }, { name: "to", rotation: [-15, -y, 27], cubes: [] }];
    sameVertices(worldVertices(moveCubesKeepingPose(bones, ["c1"], "to").bones), worldVertices(bones));
  }
  const bones = fixture();
  assert.strictEqual(moveCubesKeepingPose(bones, ["c3"], "destination").bones, bones);
  const two = structuredClone(bones[3].cubes[0]); two.dgnId = "c4"; two.name = "second"; bones[3].cubes.push(two);
  const moved = moveCubesKeepingPose(bones, ["c4"], "destination", "c3");
  assert.strictEqual(moved.bones[3].cubes[0], two); sameVertices(worldVertices(moved.bones), worldVertices(bones));
});

test("invalid hierarchy or transforms reject the whole move without partial changes", () => {
  for (const modify of [
    bones => { bones[0].parent = "wrist"; }, bones => { bones[1].parent = "missing"; },
    bones => { bones[1].rotation[1] = NaN; }, bones => { bones[2].cubes[0].origin[0] = Infinity; },
    bones => { bones[3].scale = [1, 2, 1]; }, bones => { bones[1].binding = "q.item_slot"; },
    bones => { bones.push({ name: "root", cubes: [] }); },
  ]) { const bones = fixture(); modify(bones); const before = structuredClone(bones); assert.throws(() => moveCubesKeepingPose(bones, ["c1", "c2"], "destination")); assert.deepEqual(bones, before); }
  assert.throws(() => moveCubesKeepingPose(fixture(), ["missing"], "destination"), /已变化/);
});

test("pose-preserving output keeps its rendered geometry through bbmodel roundtrip", () => {
  const bones = fixture(), moved = moveCubesKeepingPose(bones, ["c1", "c2"], "destination");
  const project = exportProject({ identifier: "geometry.pose", bones: moved.bones, textureWidth: 64, textureHeight: 64 });
  const imported = importProject(project).bones;
  for (const bone of imported) (bone.cubes || []).forEach((cube, index) => { cube.name = moved.bones.find(item => item.name === bone.name).cubes[index].name; });
  sameVertices(worldVertices(imported), worldVertices(bones), 1e-6);
});
