const test = require("node:test");
const assert = require("node:assert/strict");
const { renameBone, reparentBone, addBone, removeBone, addCube, moveCube, duplicateSelection, transformSelection, transformMany, snapDelta, mirrorSelection, uvRects, unwrapSelection, rotateFace, scaleFace, editFaceUv, remember, boneTree, parentBones, ensureCubeIds, publishBones, isCubeHidden } = require("../shared/model-edit.cjs");
const { mirrorPaintAt } = require("../shared/model-edit.cjs");

test("renaming a bone updates children and refuses a cycle", () => {
  const renamed = renameBone([
    { name: "body", cubes: [] },
    { name: "arm", parent: "body", cubes: [] },
  ], "body", "torso");
  assert.equal(renamed[1].parent, "torso");
  const added = addBone(renamed, "torso");
  assert.equal(added.bones.at(-1).parent, "torso");
  assert.throws(() => reparentBone(added.bones, "torso", added.name), /子级/);
  const removed = removeBone(added.bones, "torso");
  assert.equal(removed.find(bone => bone.name === "arm").parent, undefined);
  assert.equal(addCube(removed, "arm").find(bone => bone.name === "arm").cubes[0].size[0], 8);
});

test("duplicate copies a cube, or a bone with its children", () => {
  const bones = [
    { name: "body", cubes: [{ origin: [1, 2, 3], size: [4, 5, 6], uv: [7, 8] }] },
    { name: "arm", parent: "body", pivot: [1, 0, 0], cubes: [] },
  ];
  const cube = duplicateSelection(bones, { bone: "body", cube: 0 });
  assert.equal(cube.picked.cube, 1);
  assert.deepEqual(cube.bones[0].cubes[1], bones[0].cubes[0]);
  assert.notEqual(cube.bones[0].cubes[1], bones[0].cubes[0]);
  const copy = duplicateSelection(bones, { bone: "body", cube: null });
  assert.equal(copy.picked.bone, "body2");
  assert.equal(copy.bones.find(item => item.name === "arm").parent, "body");
  assert.equal(copy.bones.find(item => item.name === "arm2").parent, "body2");
});

test("outliner nests children and hides them from the parent list", () => {
  const bones = [
    { name: "arm", parent: "body" },
    { name: "body" },
    { name: "hat", parent: "arm" },
    { name: "loose", parent: "missing" },
  ];
  assert.deepEqual(boneTree(bones).map(item => item.bone.name + ":" + item.depth), ["body:0", "arm:1", "hat:2", "loose:0"]);
  assert.deepEqual(parentBones(bones, "body").map(bone => bone.name), ["loose"]);
  assert.equal(boneTree([{ name: "a", parent: "b" }, { name: "b", parent: "a" }]).length, 2);
});

test("moving a cube keeps its origin on the target bone", () => {
  const bones = [
    { name: "body", cubes: [{ origin: [1, 2, 3], size: [4, 4, 4] }] },
    { name: "arm", cubes: [{ origin: [9, 0, 0], size: [1, 1, 1] }] },
  ];
  const moved = moveCube(bones, "arm", 0, "body");
  assert.equal(moved.picked.cube, 1);
  assert.deepEqual(moved.bones.find(bone => bone.name === "body").cubes[1].origin, [9, 0, 0]);
  assert.equal(moved.bones.find(bone => bone.name === "arm").cubes.length, 0);
  assert.equal(bones[1].cubes.length, 1);
  const ordered = moveCube([
    { name: "body", cubes: [{ origin: [1, 0, 0] }, { origin: [2, 0, 0] }, { origin: [3, 0, 0] }] },
  ], "body", 0, "body", 1);
  assert.deepEqual(ordered.bones[0].cubes.map(cube => cube.origin[0]), [2, 1, 3]);
  assert.equal(ordered.picked.cube, 1);
});

test("viewport transforms move a subtree, rotate one element, and scale around its pivot", () => {
  const bones = [
    { name: "body", pivot: [0, 1, 0], cubes: [{ origin: [0, 0, 0], size: [8, 8, 8], pivot: [4, 4, 4] }] },
    { name: "arm", parent: "body", pivot: [2, 1, 0], cubes: [{ origin: [2, 0, 0], size: [1, 1, 1] }] },
    { name: "other", pivot: [0, 0, 0], cubes: [{ origin: [5, 0, 0], size: [1, 1, 1] }] },
  ];
  const moved = transformSelection(bones, { bone: "body", cube: null }, "move", [1, 0, 0]);
  assert.deepEqual(moved.find(bone => bone.name === "body").pivot, [1, 1, 0]);
  assert.deepEqual(moved.find(bone => bone.name === "body").cubes[0].origin, [1, 0, 0]);
  assert.deepEqual(moved.find(bone => bone.name === "arm").pivot, [3, 1, 0]);
  assert.deepEqual(moved.find(bone => bone.name === "other").cubes[0].origin, [5, 0, 0]);
  const rotated = transformSelection(bones, { bone: "arm", cube: 0 }, "rotate", [0, 90, 0]);
  assert.deepEqual(rotated.find(bone => bone.name === "arm").cubes[0].rotation, [0, 90, 0]);
  assert.deepEqual(rotated.find(bone => bone.name === "arm").cubes[0].origin, [2, 0, 0]);
  const scaled = transformSelection(bones, { bone: "body", cube: 0 }, "scale", [8, 0, 0]);
  assert.deepEqual(scaled.find(bone => bone.name === "body").cubes[0].origin, [-4, 0, 0]);
  assert.deepEqual(scaled.find(bone => bone.name === "body").cubes[0].size, [16, 8, 8]);
  assert.deepEqual(scaled.find(bone => bone.name === "body").cubes[0].pivot, [4, 4, 4]);
  const pivoted = transformSelection(bones, { bone: "body", cube: 0 }, "pivot", [1, 0, 0]);
  assert.deepEqual(pivoted.find(bone => bone.name === "body").cubes[0].pivot, [5, 4, 4]);
  assert.deepEqual(pivoted.find(bone => bone.name === "body").cubes[0].origin, [0, 0, 0]);
  assert.deepEqual(pivoted.find(bone => bone.name === "arm").pivot, [2, 1, 0]);
  const bare = transformSelection([{ name: "body", pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [8, 8, 8] }] }], { bone: "body", cube: 0 }, "pivot", [0, 1, 0]);
  assert.deepEqual(bare[0].cubes[0].pivot, [4, 5, 4]);
  assert.deepEqual(bare[0].cubes[0].origin, [0, 0, 0]);
  const boneOnly = transformSelection(bones, { bone: "body", cube: null }, "pivot", [0, 2, 0]);
  assert.deepEqual(boneOnly.find(bone => bone.name === "body").pivot, [0, 3, 0]);
  assert.deepEqual(boneOnly.find(bone => bone.name === "body").cubes[0].origin, [0, 0, 0]);
  assert.deepEqual(boneOnly.find(bone => bone.name === "arm").pivot, [2, 1, 0]);
});

test("history keeps one step per change and drops undone redos", () => {
  let state = remember([], -1, "a");
  state = remember(state.stack, state.cursor, "b");
  state = remember(state.stack, state.cursor, "c");
  state = remember(state.stack, state.cursor, "c");
  assert.deepEqual(state.stack, ["a", "b", "c"]);
  state = remember(state.stack, 1, "d");
  assert.deepEqual(state.stack, ["a", "b", "d"]);
  assert.equal(state.cursor, 2);
});

test("cube visibility follows the cube when it is reordered", () => {
  const bones = ensureCubeIds([
    { name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1] }, { origin: [2, 0, 0], size: [1, 1, 1] }] },
    { name: "arm", cubes: [] },
  ]);
  const first = bones[0].cubes[0].dgnId;
  const moved = moveCube(bones, "body", 0, "body", 1);
  const cubes = moved.bones.find(bone => bone.name === "body").cubes;
  assert.equal(cubes[1].dgnId, first);
  assert.equal(isCubeHidden([first], "body", cubes[1], 1), true);
  assert.equal(isCubeHidden([first], "body", cubes[0], 0), false);
  const copied = ensureCubeIds(duplicateSelection(moved.bones, { bone: "body", cube: 1 }).bones);
  const ids = copied.find(bone => bone.name === "body").cubes.map(cube => cube.dgnId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(publishBones(copied).some(bone => (bone.cubes || []).some(cube => cube.dgnId)), false);
});

test("mirroring across a bone pivot copies the cube to the other side", () => {
  const bones = [{
    name: "body",
    pivot: [0, 0, 0],
    cubes: [{ origin: [2, 0, 0], size: [2, 2, 2], rotation: [0, 30, 10], mirror: false, dgnId: "c1" }],
  }];
  const mirrored = mirrorSelection(bones, [{ bone: "body", cube: 0 }], 0);
  const copy = mirrored.bones[0].cubes[1];
  assert.deepEqual(copy.origin, [-4, 0, 0]);
  assert.deepEqual(copy.size, [2, 2, 2]);
  assert.deepEqual(copy.rotation, [0, -30, -10]);
  assert.equal(copy.mirror, true);
  assert.equal(copy.dgnId, undefined);
  assert.deepEqual(bones[0].cubes[0].origin, [2, 0, 0]);
  const moved = transformMany(mirrored.bones, [{ bone: "body", cube: 0 }, { bone: "body", cube: 1 }], "move", [1, 0, 0]);
  assert.deepEqual(moved[0].cubes.map(cube => cube.origin[0]), [3, -3]);
  assert.deepEqual(snapDelta([1.2, 0.4, -0.6], 1), [1, 0, -1]);
  assert.deepEqual(snapDelta([10, 0, 0], 0), [10, 0, 0]);
});

test("unwrapping keeps the same box faces as per-face uv", () => {
  const cube = { origin: [0, 0, 0], size: [8, 12, 4], uv: [0, 0] };
  const bones = unwrapSelection([{ name: "body", cubes: [cube] }], [{ bone: "body", cube: 0 }]);
  const faces = bones[0].cubes[0].uv;
  assert.deepEqual(faces.up, { uv: [4, 0], uv_size: [8, 4] });
  assert.deepEqual(faces.north, { uv: [4, 4], uv_size: [8, 12] });
  assert.deepEqual(uvRects(bones[0].cubes[0]), uvRects(cube));
  assert.equal(bones[0].cubes[0].mirror, undefined);
  const again = unwrapSelection(bones, [{ bone: "body", cube: 0 }]);
  assert.equal(again[0].cubes[0], bones[0].cubes[0]);
});

test("rotating one face turns it ninety degrees and four turns restore it", () => {
  const face = { uv: [0, 0], uv_size: [8, 4] };
  let turned = face;
  for (let step = 0; step < 4; step += 1) turned = rotateFace(turned);
  assert.deepEqual(turned, face);
  const once = rotateFace(face);
  assert.deepEqual(once.uv_size, [8, 4]);
  assert.deepEqual(once.uv, [0, 0]);
  assert.equal(once.uv_rotation, 90);
  const bones = [{ name: "body", cubes: [{ uv: { north: face, up: { uv: [1, 1], uv_size: [2, 2] } } }] }];
  const edited = editFaceUv(bones, [{ bone: "body", cube: 0 }], "north", rotateFace);
  assert.deepEqual(edited[0].cubes[0].uv.north, once);
  assert.deepEqual(edited[0].cubes[0].uv.up, bones[0].cubes[0].uv.up);
  assert.deepEqual(scaleFace(face, 2), { uv: [-4, -2], uv_size: [16, 8] });
  const extended = { ...face, uv_rotation: 90, material_instance: "keep", extension: true };
  assert.equal(rotateFace(extended).extension, true);
  assert.equal(scaleFace(extended, 2).uv_rotation, 90);
  assert.equal(scaleFace(extended, 2).material_instance, "keep");
});

test("mirror paint sends an east pixel to the west face and flips a front face", () => {
  const bones = [{ name: "body", cubes: [{ size: [8, 12, 4], uv: [0, 0] }] }];
  assert.deepEqual(mirrorPaintAt(bones, 0, 4), { x: 15, y: 4 });
  assert.deepEqual(mirrorPaintAt(bones, 5, 8), { x: 10, y: 8 });
  assert.equal(mirrorPaintAt(bones, 40, 40), null);
});
