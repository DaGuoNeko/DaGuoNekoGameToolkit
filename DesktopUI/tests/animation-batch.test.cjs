const test = require("node:test");
const assert = require("node:assert/strict");
const { moveBoneKeys, copyBoneKeys, pasteBoneKeys, clearBoneKeys, moveBoneKey, clearBoneKey } = require("../src/features/skins/npc-clip.cjs");
const { moveKeySelection, copyKeySelection, pasteKeySelection, clearKeySelection } = require("../src/features/skins/npc-clip.cjs");
function sample() {
  return { loop: "hold_on_last_frame", animation_length: 2, sound_effects: { "0": { effect: "click" } }, bones: { body: {
    rotation: { "0": [0, 0, 0], "0.5": { pre: [1, 2, 3], post: ["q.anim_time * 20", 0, 0], lerp_mode: "catmullrom", extension: { keep: true } }, "1.00": [9, 8, 7] },
    position: { "0.00": [1, 2, 3] },
  }, arm: { rotation: { "0.00": [5, 5, 5] } } } };
}
test("batch movement preserves raw frames, spacing and unrelated data in one immutable update", () => {
  const before = sample(), snapshot = JSON.stringify(before);
  const after = moveBoneKeys(before, "body", "rotation", [0, 0.5], 0.25);
  assert.deepEqual(Object.keys(after.bones.body.rotation).map(Number).sort(), [0.25, 0.75, 1]);
  assert.deepEqual(after.bones.body.rotation["0.75"], before.bones.body.rotation["0.5"]);
  assert.deepEqual(after.bones.body.position, before.bones.body.position);
  assert.deepEqual(after.bones.arm, before.bones.arm);
  assert.deepEqual(after.sound_effects, before.sound_effects);
  assert.equal(after.loop, before.loop);
  assert.equal(JSON.stringify(before), snapshot);
  const shifted = moveBoneKeys(before, "body", "rotation", [0, 0.5, 1], 0.5);
  assert.deepEqual(shifted.bones.body.rotation["0.50"], [0, 0, 0]);
  assert.deepEqual(moveBoneKey(before, "body", "rotation", 0, 0.25).bones.body.rotation["0.25"], [0, 0, 0]);
});
test("collisions, negative destinations, ambiguous times and stale selections reject atomically", () => {
  const animation = sample(), snapshot = JSON.stringify(animation);
  assert.throws(() => moveBoneKeys(animation, "body", "rotation", [0, 0.5], 0.5), /已有关键帧/);
  assert.throws(() => moveBoneKeys(animation, "body", "rotation", [0, 0.5], -0.25), /0–10000/);
  assert.throws(() => moveBoneKeys(animation, "body", "rotation", [0, 0.75], 0.2), /已变化/);
  assert.throws(() => moveBoneKeys(animation, "body", "rotation", [0], NaN), /无效/);
  assert.throws(() => moveBoneKeys(animation, "body", "rotation", [], 1), /先选择/);
  const ambiguous = sample(); ambiguous.bones.body.rotation["0.00"] = [1, 1, 1];
  assert.throws(() => copyBoneKeys(ambiguous, "body", "rotation", [0]), /重复/);
  assert.equal(JSON.stringify(animation), snapshot);
});
test("copy paste preserves expressions, pre/post and unknown frame fields without numeric sampling", () => {
  const animation = sample();
  const clipboard = copyBoneKeys(animation, "body", "rotation", [0.5, 0]);
  assert.deepEqual(clipboard.frames.map(frame => frame.offset), [0, 0.5]);
  const pasted = pasteBoneKeys(animation, "arm", clipboard, 2);
  assert.deepEqual(pasted.bones.arm.rotation["2.50"], animation.bones.body.rotation["0.5"]);
  assert.equal(pasted.animation_length, 2.5);
  assert.deepEqual(pasted.sound_effects, animation.sound_effects);
  assert.throws(() => pasteBoneKeys(animation, "body", clipboard, 0.5), /已有关键帧/);
  clipboard.frames[1].frame.extension.keep = false;
  assert.equal(pasted.bones.arm.rotation["2.50"].extension.keep, true);
  assert.equal(animation.bones.body.rotation["0.5"].extension.keep, true);
});
test("batch delete only removes selected frames and handles equivalent timestamp spellings", () => {
  const animation = sample();
  const removed = clearBoneKeys(animation, "body", "rotation", [0, 0.5]);
  assert.deepEqual(removed.bones.body.rotation, { "1.00": [9, 8, 7] });
  const cleared = clearBoneKeys(animation, "body", "rotation", [0, 0.5, 1]);
  assert.equal(cleared.bones.body.rotation, undefined);
  assert.deepEqual(cleared.bones.body.position, animation.bones.body.position);
  assert.equal(clearBoneKey(animation, "body", "rotation", 0).bones.body.rotation["0"], undefined);
  assert.equal(clearBoneKey(animation, "body", "rotation", 0.75), animation);
});

const mixedSelection = [
  { bone: "body", channel: "rotation", time: 0.5 },
  { bone: "body", channel: "position", time: 0 },
  { bone: "arm", channel: "rotation", time: 0 },
];

test("mixed tracks move and delete as one change while preserving frame payloads and other tracks", () => {
  const source = sample(), snapshot = JSON.stringify(source);
  const moved = moveKeySelection(source, mixedSelection, 0.25);
  assert.deepEqual(moved.bones.body.rotation["0.75"], source.bones.body.rotation["0.5"]);
  assert.deepEqual(moved.bones.body.position["0.25"], [1, 2, 3]);
  assert.deepEqual(moved.bones.arm.rotation["0.25"], [5, 5, 5]);
  assert.deepEqual(moved.sound_effects, source.sound_effects);
  assert.deepEqual(moved.bones.body.rotation["1.00"], [9, 8, 7]);
  const removed = clearKeySelection(source, mixedSelection);
  assert.equal(removed.bones.body.position, undefined);
  assert.equal(removed.bones.arm, undefined);
  assert.deepEqual(removed.bones.body.rotation, { "0": [0, 0, 0], "1.00": [9, 8, 7] });
  assert.equal(JSON.stringify(source), snapshot);
});

test("a collision or stale selection on a later track rejects the entire mixed edit", () => {
  const source = sample();
  source.bones.arm.rotation["0.25"] = [6, 6, 6];
  const snapshot = JSON.stringify(source);
  assert.throws(() => moveKeySelection(source, mixedSelection, 0.25), /已有关键帧/);
  assert.throws(() => moveKeySelection(source, mixedSelection, -0.25), /0–10000/);
  assert.throws(() => clearKeySelection(source, [...mixedSelection, { bone: "arm", channel: "scale", time: 1 }]), /已变化/);
  assert.throws(() => copyKeySelection(source, [...mixedSelection, mixedSelection[0]]), /重复/);
  assert.throws(() => moveKeySelection(source, [{ bone: "__proto__", channel: "rotation", time: 0 }], 1), /骨骼/);
  assert.equal(JSON.stringify(source), snapshot);
});

test("multi-track clipboard keeps global timing and bone ownership, including a bone without existing animation", () => {
  const source = sample(), clipboard = copyKeySelection(source, mixedSelection);
  assert.deepEqual(clipboard.tracks.map(track => track.frames[0].offset), [0.5, 0, 0]);
  const target = { loop: false, animation_length: 1, bones: {}, particle_effects: { 0: { effect: "keep" } } };
  const { animation, selection } = pasteKeySelection(target, clipboard, 2, ["body", "arm", "other"], "other");
  assert.equal(animation.bones.other, undefined, "混合轨道不重映射到当前选中骨骼");
  assert.deepEqual(animation.bones.body.rotation["2.50"], source.bones.body.rotation["0.5"]);
  assert.deepEqual(animation.bones.arm.rotation["2.00"], [5, 5, 5]);
  assert.deepEqual(selection, mixedSelection.map(item => ({ ...item, time: item.time + 2 })));
  assert.equal(animation.animation_length, 2.5);
  assert.deepEqual(animation.particle_effects, target.particle_effects);
  assert.deepEqual(target.bones, {});
  clipboard.tracks[0].frames[0].frame.extension.keep = false;
  assert.equal(animation.bones.body.rotation["2.50"].extension.keep, true);
});

test("paste validates all target bones and conflicts before returning any edited animation", () => {
  const source = sample(), clipboard = copyKeySelection(source, mixedSelection);
  const snapshot = JSON.stringify(source);
  assert.throws(() => pasteKeySelection(source, clipboard, 2, ["body"], "body"), /缺少骨骼 arm/);
  const target = { animation_length: 1, bones: { arm: { rotation: { "2.00": [1, 0, 0] } } } };
  const before = JSON.stringify(target);
  assert.throws(() => pasteKeySelection(target, clipboard, 2, ["body", "arm"], "body"), /已有关键帧/);
  assert.equal(JSON.stringify(target), before);
  assert.equal(JSON.stringify(source), snapshot);
  const single = copyKeySelection(source, [mixedSelection[0]]);
  const pasted = pasteKeySelection(source, single, 2, ["body", "arm"], "arm");
  assert.deepEqual(pasted.animation.bones.arm.rotation["2.00"], source.bones.body.rotation["0.5"]);
  assert.equal(pasted.selection[0].bone, "arm");
});
