const test = require("node:test"), assert = require("node:assert/strict");
const { cubeProperty, selectedCubes, changeCubeProperty, namedCube } = require("../shared/model-cube-properties.cjs");
const source = () => [{ name: "body", pivot: [1, 2, 3], future: true, cubes: [
  { dgnId: "a", origin: [-4, 0, -2], size: [8, 12, 4], uv: [1, 2], extension: { keep: 42 } },
  { dgnId: "b", origin: [8, 2, -1], size: [3, 6, 2], pivot: [10, 3, 0], rotation: [0, 20, 0], inflate: 1, uv: [5, 9], mirror: true },
] }, { name: "arm", parent: "body", cubes: [{ dgnId: "c", origin: [1, 3, 2], size: [2, 3, 4], uv: { north: { uv: [2, 3], uv_size: [-2, 4], uv_rotation: 90, extension: true } } }] }];

test("one component changes across selected bones while all other geometry, UV and metadata remain unchanged", () => {
  const bones = source(), before = structuredClone(bones);
  const next = changeCubeProperty(bones, ["a", "c"], "origin", 0, 5);
  assert.deepEqual(bones, before); assert.deepEqual(next[0].cubes[0], { ...bones[0].cubes[0], origin: [5, 0, -2] });
  assert.strictEqual(next[0].cubes[1], bones[0].cubes[1]); assert.deepEqual(next[1].cubes[0], { ...bones[1].cubes[0], origin: [5, 3, 2] });
  assert.equal(next[1].parent, "body"); assert.deepEqual(next[0].pivot, bones[0].pivot);
  const offset = changeCubeProperty(bones, ["a", "b", "a"], "size", 1, -2, "add");
  assert.deepEqual(offset[0].cubes.map(cube => cube.size), [[8, 10, 4], [3, 4, 2]]);
  assert.deepEqual(offset[0].cubes.map(cube => cube.origin), bones[0].cubes.map(cube => cube.origin));
});

test("default pivots use cube centers and optional defaults do not materialize on no-op edits", () => {
  const bones = source();
  assert.deepEqual(cubeProperty(bones[0].cubes[0], "pivot"), [0, 6, 0]);
  assert.deepEqual(cubeProperty(bones[0].cubes[0], "rotation"), [0, 0, 0]);
  assert.equal(cubeProperty(bones[0].cubes[0], "inflate"), 0);
  assert.strictEqual(changeCubeProperty(bones, ["a", "b"], "rotation", 0, 0), bones);
  const next = changeCubeProperty(bones, ["a", "b"], "pivot", 1, 1, "add");
  assert.deepEqual(next[0].cubes.map(cube => cube.pivot), [[0, 7, 0], [10, 4, 0]]);
  const inflate = changeCubeProperty(bones, ["a", "b"], "inflate", undefined, 0.125, "add");
  assert.deepEqual(inflate[0].cubes.map(cube => cube.inflate), [0.125, 1.125]);
});

test("box UV and mirror update selected boxes without converting per-face UV or overwriting other components", () => {
  const bones = source();
  const next = changeCubeProperty(bones, ["a", "b"], "uv", 0, 3, "add");
  assert.deepEqual(next[0].cubes.map(cube => cube.uv), [[4, 2], [8, 9]]);
  assert.strictEqual(next[1], bones[1]);
  const mirrored = changeCubeProperty(bones, ["a", "b"], "mirror", undefined, true);
  assert.equal(mirrored[0].cubes[0].mirror, true); assert.strictEqual(mirrored[0].cubes[1], bones[0].cubes[1]);
  for (const property of ["uv", "mirror"]) assert.throws(() => changeCubeProperty(bones, ["a", "c"], property, 0, property === "uv" ? 2 : true), /按面 UV/);
});

test("stale IDs, malformed source data and invalid or overflowing results reject the whole operation", () => {
  const bones = source(), before = structuredClone(bones);
  assert.throws(() => changeCubeProperty(bones, ["a", "missing"], "inflate", undefined, 1), /已变化/);
  const duplicate = structuredClone(bones); duplicate[1].cubes[0].dgnId = "a";
  assert.throws(() => selectedCubes(duplicate, ["a"]), /重复/);
  for (const value of [Infinity, NaN, 1000001, "2", null]) assert.throws(() => changeCubeProperty(bones, ["a", "b"], "size", 0, value));
  for (const args of [["size", 3, 1], ["uv", -1, 2], ["__proto__", 0, 2], ["mirror", 0, 1]]) assert.throws(() => changeCubeProperty(bones, ["a", "b"], ...args));
  const invalid = structuredClone(bones); invalid[0].cubes[1].rotation = [1, "bad", 0]; const original = structuredClone(invalid);
  assert.throws(() => changeCubeProperty(invalid, ["a", "b"], "rotation", 0, 10), /原属性/); assert.deepEqual(invalid, original);
  assert.throws(() => changeCubeProperty(bones, ["a", "b"], "origin", 0, 1e6, "add"), /超出范围/); assert.deepEqual(bones, before);
});

test("zero and negative sizes are preserved, decimals round once and no-op returns the source", () => {
  const bones = source();
  assert.deepEqual(changeCubeProperty(bones, ["a", "b"], "size", 2, 0)[0].cubes.map(cube => cube.size[2]), [0, 0]);
  assert.deepEqual(changeCubeProperty(bones, ["a", "b"], "size", 2, -2)[0].cubes.map(cube => cube.size[2]), [-2, -2]);
  assert.equal(changeCubeProperty(bones, ["a"], "inflate", undefined, 0.12345)[0].cubes[0].inflate, 0.123);
  assert.strictEqual(changeCubeProperty(bones, ["a", "b"], "origin", 0, 0, "add"), bones);
});

test("cube names trim, clear and reject blank control characters or overlong text", () => {
  const cube = source()[0].cubes[0], named = namedCube(cube, "  head  ");
  assert.equal(named.name, "head"); assert.equal(named.dgnId, "a"); assert.notEqual(named, cube);
  assert.equal(namedCube(named, "head"), named);
  const cleared = namedCube(named, "   "); assert.equal(cleared.name, undefined); assert.equal(cleared.dgnId, "a");
  assert.throws(() => namedCube(cube, "a".repeat(65)), /64/); assert.throws(() => namedCube(cube, "a\nb"), /控制/);
});
