const test = require("node:test");
const assert = require("node:assert/strict");
const { changeBoneProperty } = require("../shared/model-bone-properties.cjs");

test("bone batch edit sets or adds one component and leaves other bones unchanged", () => {
  const bones = [
    { name: "body", pivot: [1, 2, 3], rotation: [0, 0, 0], cubes: [{ origin: [0, 0, 0] }] },
    { name: "arm", pivot: [1, 9, 3] },
    { name: "head", pivot: [4, 5, 6] },
  ];
  const set = changeBoneProperty(bones, ["arm", "body"], "pivot", 1, 8, "set");
  assert.deepEqual(set[0].pivot, [1, 8, 3]);
  assert.deepEqual(set[1].pivot, [1, 8, 3]);
  assert.deepEqual(set[2], bones[2]);
  assert.equal(set[0].cubes, bones[0].cubes);
  const added = changeBoneProperty(set, ["body", "arm"], "rotation", 0, 15, "add");
  assert.deepEqual(added[0].rotation, [15, 0, 0]);
  assert.deepEqual(added[1].rotation, [15, 0, 0]);
  assert.equal(changeBoneProperty(bones, ["body"], "pivot", 0, 1, "set"), bones);
  assert.throws(() => changeBoneProperty(bones, ["body", "missing"], "pivot", 0, 1, "set"), /选择已变化/);
  assert.throws(() => changeBoneProperty(bones, ["body", "arm"], "pivot", 0, Number.NaN, "set"), /数值/);
  assert.deepEqual(bones[0].pivot, [1, 2, 3]);
});

test("invalid source values, duplicate names and overflowing results reject the entire batch", () => {
  const bones = [{ name: "a", pivot: [1, 0, 0] }, { name: "b", pivot: [1000000, 0, 0] }];
  const before = structuredClone(bones);
  assert.throws(() => changeBoneProperty(bones, ["a", "b"], "pivot", 0, 1, "add"), /超出范围/);
  assert.deepEqual(bones, before);
  for (const value of [null, [0, 0], ["0", 0, 0], [0, Infinity, 0]]) {
    assert.throws(() => changeBoneProperty([{ name: "a", pivot: value }, bones[1]], ["a", "b"], "pivot", 0, 2, "set"), /原属性/);
  }
  assert.throws(() => changeBoneProperty([{ name: "a" }, { name: "A" }], ["a", "A"], "pivot", 0, 1, "set"), /重复/);
  assert.throws(() => changeBoneProperty(bones, [], "pivot", 0, 1, "set"), /有效骨骼/);
  assert.throws(() => changeBoneProperty(bones, ["a", "b"], "pivot", 3, 1, "set"), /属性/);
  assert.throws(() => changeBoneProperty(bones, ["a", "b"], "rotation", 0, 1, "multiply"), /方式/);
  assert.equal(changeBoneProperty(bones, ["a", "b"], "rotation", 1, 0, "set"), bones, "缺省零值不增加撤销项");
});
