const test = require("node:test"), assert = require("node:assert/strict");
const { duplicateCubes, deleteCubes, moveCubes } = require("../shared/model-cube-operations.cjs");
const { ensureCubeIds, publishBones } = require("../shared/model-edit.cjs");
const fixture = () => [{ name: "body", pivot: [0, 6, 0], extra: true, cubes: [
  { dgnId: "c1", origin: [0, 0, 0], size: [2, 3, 4], uv: [0, 0], extension: { keep: [42] } },
  { dgnId: "c2", origin: [4, 0, 0], size: [2, 3, 4], uv: [1, 2] },
] }, { name: "arm", parent: "body", cubes: [{ dgnId: "c3", origin: [8, 0, 0], size: [2, 3, 4], uv: { north: { uv: [4, 4], uv_size: [-2, 4], uv_rotation: 90, extension: true } }, mirror: true, inflate: 0.25 }] }, { name: "empty", cubes: [] }];

test("batch copy keeps per-bone order and deep data, selects only fresh IDs and preserves every original ID", () => {
  const bones = fixture(), original = structuredClone(bones), result = duplicateCubes(bones, ["c3", "c1", "c3"]);
  assert.deepEqual(bones, original); assert.equal(result.ids.length, 2); assert.deepEqual(result.picked, { bone: "arm", cube: 1 });
  assert.deepEqual(result.bones.map(bone => bone.cubes.length), [3, 2, 0]);
  assert.equal(result.bones[1].cubes[0].dgnId, "c3"); assert.strictEqual(result.bones[2], bones[2]);
  const ids = result.bones.flatMap(bone => bone.cubes.map(cube => cube.dgnId)); assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(publishBones(result.bones)[0].cubes[2], publishBones(bones)[0].cubes[0]);
  assert.deepEqual(publishBones(result.bones)[1].cubes[1], publishBones(bones)[1].cubes[0]);
  result.bones[0].cubes[2].extension.keep.push(99); result.bones[1].cubes[1].uv.north.uv[0] = 88; assert.deepEqual(bones, original);
  const again = duplicateCubes(result.bones, result.ids); assert.equal(again.ids.some(id => ids.includes(id)), false);
});

test("batch delete removes only selected cubes and retains empty bones, hierarchy and unknown data", () => {
  const bones = fixture(), original = structuredClone(bones), result = deleteCubes(bones, ["c1", "c3", "c1"]);
  assert.deepEqual(bones, original); assert.deepEqual(result.map(bone => bone.name), ["body", "arm", "empty"]);
  assert.deepEqual(result[0].cubes, [bones[0].cubes[1]]); assert.deepEqual(result[1].cubes, []); assert.equal(result[1].parent, "body"); assert.equal(result[0].extra, true);
  assert.strictEqual(result[2], bones[2]);
});

test("stale or ambiguous selections and over-limit copies fail before any mutation", () => {
  const bones = fixture(), original = structuredClone(bones);
  for (const operation of [duplicateCubes, deleteCubes]) {
    for (const ids of [[], ["c1", "missing"], [null], "c1"]) assert.throws(() => operation(bones, ids));
    const duplicate = structuredClone(bones); duplicate[1].cubes[0].dgnId = "c1"; assert.throws(() => operation(duplicate, ["c1"]), /重复/);
  }
  const full = [{ name: "body", cubes: Array.from({ length: 2000 }, (_, i) => ({ dgnId: "c" + i, origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] })) }];
  assert.throws(() => duplicateCubes(full, ["c0"]), /2000/); assert.equal(full[0].cubes.length, 2000); assert.deepEqual(bones, original);
});

test("ID stamping reserves existing later IDs when new or duplicate cubes appear before them", () => {
  const bones = fixture(); bones[0].cubes.push({ size: [1, 1, 1] }, { ...bones[0].cubes[0] });
  const result = ensureCubeIds(bones), ids = result.flatMap(bone => bone.cubes.map(cube => cube.dgnId));
  assert.equal(result[1].cubes[0].dgnId, "c3"); assert.equal(result[0].cubes[0].dgnId, "c1"); assert.equal(new Set(ids).size, ids.length);
  assert.strictEqual(ensureCubeIds(result), result);
  assert.equal(publishBones(result).some(bone => bone.cubes.some(cube => Object.hasOwn(cube, "dgnId"))), false);
});

test("cross-bone move retains cube objects, IDs, stored transforms and original ordering", () => {
  const bones = fixture(), original = structuredClone(bones), moved = moveCubes(bones, ["c3", "c1"], "empty");
  assert.deepEqual(bones, original); assert.deepEqual(moved.bones.map(bone => bone.cubes.map(cube => cube.dgnId)), [["c2"], [], ["c1", "c3"]]);
  assert.deepEqual(moved.ids, ["c1", "c3"]); assert.deepEqual(moved.picked, { bone: "empty", cube: 1 });
  assert.strictEqual(moved.bones[2].cubes[0], bones[0].cubes[0]); assert.strictEqual(moved.bones[2].cubes[1], bones[1].cubes[0]);
  assert.equal(moved.bones[1].parent, "body"); assert.deepEqual(moved.bones[0].pivot, bones[0].pivot);
});

test("batch insertion removes selected target members before resolving the insertion anchor", () => {
  const bones = fixture(); bones[0].cubes.push({ dgnId: "c4" }, { dgnId: "c5" });
  const before = moveCubes(bones, ["c1", "c4", "c3"], "body", "c2");
  assert.deepEqual(before.bones[0].cubes.map(cube => cube.dgnId), ["c1", "c4", "c3", "c2", "c5"]);
  assert.deepEqual(before.picked, { bone: "body", cube: 2 });
  const end = moveCubes(bones, ["c1", "c4"], "body");
  assert.deepEqual(end.bones[0].cubes.map(cube => cube.dgnId), ["c2", "c5", "c1", "c4"]);
  assert.strictEqual(end.bones[1], bones[1]); assert.strictEqual(end.bones[2], bones[2]);
  assert.strictEqual(moveCubes(bones, ["c1", "c4"], "body", "c4").bones, bones);
  assert.strictEqual(moveCubes(bones, ["c5"], "body").bones, bones);
});

test("move rejects stale selection, stale or foreign anchors and ambiguous destinations without mutation", () => {
  const bones = fixture(), original = structuredClone(bones);
  for (const args of [[["c1", "missing"], "empty"], [["c1"], "unknown"], [["c1"], "body", "c3"], [["c1"], "body", "gone"], [[], "body"]]) assert.throws(() => moveCubes(bones, ...args));
  assert.deepEqual(bones, original);
  const duplicate = [...bones, { name: "empty", cubes: [] }]; assert.throws(() => moveCubes(duplicate, ["c1"], "empty"), /重复/);
  const reordered = moveCubes(bones, ["c2"], "body", "c1");
  assert.deepEqual(reordered.bones[0].cubes.map(cube => cube.dgnId), ["c2", "c1"]);
});
