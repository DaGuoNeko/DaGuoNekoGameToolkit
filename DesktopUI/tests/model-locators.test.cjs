const test = require("node:test");
const assert = require("node:assert/strict");
const { ensureCubeIds, publishBones, addLocator, removeLocator, renameLocator, duplicateLocator, setLocator, transformLocator, duplicateSelection } = require("../shared/model-edit.cjs");

const bone = () => [{ name: "body", pivot: [0, 1, 0], cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0], dgnId: "c1" }] }];

test("locators normalize once and stay with the bone", () => {
  const normalized = ensureCubeIds([{ name: "body", cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0], dgnId: "c1" }], locators: { lead: [1, 2, 3], eye: { offset: [0, 4, 0], rotation: [0, 10, 0], ignore_inherited_scale: true } } }]);
  assert.deepEqual(normalized[0].locators.lead, { offset: [1, 2, 3] });
  assert.equal(normalized[0].locators.eye.ignore_inherited_scale, true);
  assert.strictEqual(ensureCubeIds(normalized), normalized);
  assert.deepEqual(publishBones(normalized)[0].locators.lead, { offset: [1, 2, 3] });
  assert.equal(JSON.stringify(publishBones(normalized)).includes("dgnId"), false);
  assert.throws(() => ensureCubeIds([{ name: "body", cubes: [], locators: { Lead: [0, 0, 0], lead: [1, 0, 0] } }]), /重复/);
});

test("locator edits are explicit and bounded", () => {
  const created = addLocator(bone(), "body");
  assert.equal(created.name, "locator");
  assert.deepEqual(created.bones[0].locators.locator, { offset: [0, 0, 0] });
  const moved = transformLocator(created.bones, "body", "locator", "move", [1, -2, 0.25]);
  assert.deepEqual(moved[0].locators.locator.offset, [1, -2, 0.25]);
  const turned = transformLocator(moved, "body", "locator", "rotate", [0, 15, 0]);
  assert.deepEqual(turned[0].locators.locator.rotation, [0, 15, 0]);
  assert.throws(() => transformLocator(turned, "body", "locator", "scale", [1, 0, 0]), /缩放/);
  const renamed = renameLocator(setLocator(turned, "body", "locator", { ignore_inherited_scale: true }), "body", "locator", "lead");
  assert.equal(renamed[0].locators.lead.ignore_inherited_scale, true);
  assert.equal(renamed[0].locators.locator, undefined);
  const copied = duplicateLocator(renamed, "body", "lead");
  assert.deepEqual(copied.bones[0].locators.lead2.offset, [1, -2, 0.25]);
  const cleared = setLocator(copied.bones, "body", "lead", { ignore_inherited_scale: false });
  assert.equal(cleared[0].locators.lead.ignore_inherited_scale, undefined);
  const removed = removeLocator(removeLocator(cleared, "body", "lead2"), "body", "lead");
  assert.equal(removed[0].locators, undefined);
  const duplicatedBone = duplicateSelection(created.bones, { bone: "body", cube: null });
  assert.deepEqual(duplicatedBone.bones[1].locators.locator, { offset: [0, 0, 0] });
  assert.throws(() => renameLocator(copied.bones, "body", "lead", "lead2"), /同名/);
  assert.throws(() => addLocator([], "missing"), /骨骼不存在/);
});
