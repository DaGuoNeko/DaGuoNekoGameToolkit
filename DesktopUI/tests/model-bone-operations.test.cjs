const test = require("node:test");
const assert = require("node:assert/strict");
const { boneSelection, duplicateBones, deleteBones, reparentBones } = require("../shared/model-bone-operations.cjs");
const { transformMany } = require("../shared/model-edit.cjs");

const fixture = () => [
  { name: "root", pivot: [0, 1, 0], cubes: [{ dgnId: "c1", origin: [0, 0, 0], size: [1, 2, 3], uv: [0, 0] }] },
  { name: "child", parent: "root", pivot: [0, 2, 0], cubes: [{ dgnId: "c2", origin: [1, 0, 0], pivot: [1, 1, 1], size: [1, 1, 1], uv: [4, 0] }] },
  { name: "leaf", parent: "child", pivot: [1, 2, 3], locators: { eye: { offset: [1, 2, 3] } }, extension: { keep: true } },
  { name: "other", pivot: [3, 2, 1], cubes: [] },
];

test("copying overlapping bone trees copies each descendant once with independent data and unique cube ids", () => {
  const bones = fixture(), before = structuredClone(bones);
  const copied = duplicateBones(bones, ["child", "root", "root"]);
  assert.equal(copied.bones.length, 7);
  const copies = copied.bones.slice(4);
  assert.deepEqual(copied.names, ["root2", "child2"]);
  assert.deepEqual(copies.map(bone => bone.parent), [undefined, "root2", "child2"]);
  const ids = copied.bones.flatMap(bone => (bone.cubes || []).map(cube => cube.dgnId));
  assert.equal(new Set(ids).size, ids.length);
  copies[1].cubes[0].uv[0] = 12; copies[2].locators.eye.offset[0] = 7; copies[2].extension.keep = false;
  assert.deepEqual(bones, before);
  assert.deepEqual(duplicateBones(bones, ["child"]).bones.at(-2).parent, "root", "单独复制子骨骼仍挂在原父级");
});

test("batch deletion keeps unselected descendants and reconnects them to the closest remaining ancestor", () => {
  for (const names of [["child", "root"], ["root", "child"]]) {
    const bones = fixture();
    const deleted = deleteBones(bones, names);
    assert.deepEqual(deleted.map(bone => bone.name), ["leaf", "other"]);
    assert.equal(deleted[0].parent, undefined);
    assert.deepEqual(deleted[0].locators, bones[2].locators);
  }
  assert.equal(deleteBones(fixture(), ["child"])[1].parent, "root");
});

test("reparenting moves only selected roots and rejects descendant destinations and stale selections", () => {
  const bones = fixture();
  const moved = reparentBones(bones, ["root", "child"], "other");
  assert.equal(moved[0].parent, "other"); assert.equal(moved[1].parent, "root");
  assert.equal(moved[0].cubes, bones[0].cubes);
  assert.equal(reparentBones(bones, ["child", "leaf"], "root"), bones);
  for (const parent of ["child", "leaf", "missing"]) assert.throws(() => reparentBones(bones, ["root"], parent), /父级|子级/);
  for (const operation of [duplicateBones, deleteBones, (value, names) => reparentBones(value, names, "")]) {
    assert.throws(() => operation(bones, ["root", "missing"]), /选择已变化/);
    assert.throws(() => operation([{ name: "a", parent: "b" }, { name: "b", parent: "a" }], ["a"]), /层级/);
  }
  assert.deepEqual([...boneSelection(bones, ["root", "child"]).tree], ["root", "child", "leaf"]);
});

test("copy limits and collisions fail safely; moving selected parents and children moves descendants once", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ name: "b" + i }));
  assert.throws(() => duplicateBones(many, ["b0"]), /400/);
  assert.throws(() => duplicateBones([{ name: "a", cubes: Array.from({ length: 1001 }, () => ({})) }], ["a"]), /2000/);
  const bones = fixture();
  for (const names of [["root", "child"], ["child", "root"]]) {
    const shifted = transformMany(bones, names.map(bone => ({ bone, cube: null })), "move", [2, 0, 0]);
    assert.deepEqual(shifted[0].pivot, [2, 1, 0]);
    assert.deepEqual(shifted[1].pivot, [2, 2, 0]);
    assert.deepEqual(shifted[2].pivot, [3, 2, 3]);
    assert.deepEqual(shifted[1].cubes[0].origin, [3, 0, 0]);
    assert.equal(shifted[3], bones[3]);
  }
  const long = "a".repeat(64);
  const copied = duplicateBones([{ name: long }, { name: long.slice(0, 63) + "2" }], [long]);
  assert.equal(copied.names[0], long.slice(0, 63) + "3");
});
