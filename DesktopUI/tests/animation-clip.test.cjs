const test = require("node:test");
const assert = require("node:assert/strict");
const { clipFromBedrock, setRotationKey, setBoneKey, moveBoneKey, moveCurveKey, setKeyMode, setAnimSpan, clearBoneKey, keyTimes, sampleTrack, trackOf, hasExpressions } = require("../src/features/skins/npc-clip.cjs");

test("bedrock rotation keys become a clip and can be added", () => {
  const animation = setRotationKey({ loop: true, animation_length: 1, bones: {} }, "body", 0.5, [0, 20, 0]);
  assert.deepEqual(animation.bones.body.rotation["0.50"], [0, 20, 0]);
  const clip = clipFromBedrock(animation);
  assert.equal(clip.bones.body.r.length, 1);
  assert.deepEqual(sampleTrack(clip.bones.body.r, 0.5).map(value => Math.round(value)), [0, 20, 0]);
  const moved = setBoneKey(animation, "body", "position", 0.25, [1, 0, 0]);
  assert.deepEqual(moved.bones.body.position["0.25"], [1, 0, 0]);
  assert.deepEqual(clipFromBedrock(moved).bones.body.p[0].slice(1), [1, 0, 0]);
  const scaled = setBoneKey(moved, "body", "scale", 1, [1, 2, 1]);
  assert.deepEqual(scaled.bones.body.scale["1.00"], [1, 2, 1]);
  const later = setBoneKey(moved, "body", "position", 0.75, [3, 0, 0]);
  assert.equal(Math.round(sampleTrack(clipFromBedrock(later).bones.body.p, 0.5)[0]), 2);
  const shifted = moveBoneKey(moved, "body", "position", 0.25, 0.5);
  assert.deepEqual(shifted.bones.body.position["0.50"], [1, 0, 0]);
  assert.equal(shifted.bones.body.position["0.25"], undefined);
  assert.equal(moveBoneKey(shifted, "body", "position", 0.25, 0.8), shifted);
  let curve = setBoneKey({ loop: true, animation_length: 3, bones: {} }, "body", "position", 0, [0, 0, 0]);
  curve = setBoneKey(curve, "body", "position", 1, [0, 0, 0]);
  curve = setBoneKey(curve, "body", "position", 2, [10, 0, 0]);
  curve = setBoneKey(curve, "body", "position", 3, [0, 0, 0]);
  const straight = sampleTrack(clipFromBedrock(curve).bones.body.p, 1.5)[0];
  const smooth = setKeyMode(curve, "body", "position", 2, "catmullrom");
  assert.equal(smooth.bones.body.position["2.00"].lerp_mode, "catmullrom");
  assert.notEqual(Math.round(sampleTrack(clipFromBedrock(smooth).bones.body.p, 1.5)[0] * 10), Math.round(straight * 10));
  assert.equal(setKeyMode(smooth, "body", "position", 2, "catmullrom"), smooth);
  const stepped = setKeyMode(smooth, "body", "position", 2, "step");
  assert.deepEqual(stepped.bones.body.position["2.00"].pre, [0, 0, 0]);
  assert.deepEqual(stepped.bones.body.position["2.00"].post, [10, 0, 0]);
  assert.equal(Math.round(sampleTrack(clipFromBedrock(stepped).bones.body.p, 1.5)[0]), 0);
  assert.equal(Math.round(sampleTrack(clipFromBedrock(stepped).bones.body.p, 2)[0]), 10);
  assert.deepEqual(setKeyMode(stepped, "body", "position", 2, "linear").bones.body.position["2.00"], [10, 0, 0]);
  const spanned = setAnimSpan(scaled, 2, false);
  assert.equal(spanned.animation_length, 2);
  assert.equal(spanned.loop, false);
  assert.equal(spanned.bones, scaled.bones);
  assert.equal(setAnimSpan(spanned, 2, false), spanned);
  const held = setAnimSpan(spanned, 2, "hold_on_last_frame");
  assert.equal(held.loop, "hold_on_last_frame");
  assert.equal(clipFromBedrock(held).loop, false);
  assert.equal(setBoneKey(held, "body", "rotation", 0.2, [1, 0, 0]).loop, "hold_on_last_frame");
  assert.deepEqual(keyTimes(scaled, "body", "position"), [0.25]);
  const removed = clearBoneKey(scaled, "body", "position", 0.25);
  assert.equal(removed.bones.body.position, undefined);
  assert.deepEqual(removed.bones.body.rotation["0.50"], [0, 20, 0]);
  assert.equal(clearBoneKey(removed, "body", "position", 0.25), removed);
});

test("Molang remains dynamic in scalar, vector and timestamp tracks", () => {
  const source = { animation_length: 2, loop: true, bones: { body: { rotation: [0, "math.sin(q.anim_time * 360) * 30", 0], scale: "1 + q.anim_time" } } };
  const before = JSON.stringify(source);
  const clip = clipFromBedrock(source);
  assert.equal(sampleTrack(clip.bones.body.r, 0.25)[1], 30);
  assert.equal(sampleTrack(clip.bones.body.r, 0.75)[1], -30);
  assert.deepEqual(sampleTrack(clip.bones.body.s, 0.5), [1.5, 1.5, 1.5]);
  assert.equal(JSON.stringify(source), before);
  const keys = trackOf({ "0": [0, "q.anim_time * 10", 0], "1": [0, "q.anim_time * 20", 0] });
  assert.equal(sampleTrack(keys, 0.5)[1], 7.5);
  const smooth = trackOf({ "0": [0, 0, 0], "1": { post: [0, "q.anim_time * 20", 0], lerp_mode: "catmullrom" } });
  assert.equal(sampleTrack(smooth, 0.5)[1], 5);
  const split = trackOf({ "0": [0, 0, 0], "1": { pre: ["q.anim_time * 4", 0, 0], post: [8, 0, 0] } });
  assert.equal(sampleTrack(split, 0.5)[0], 1);
  assert.equal(sampleTrack(split, 1)[0], 8);
  const messages = [];
  assert.equal(sampleTrack(trackOf(["query.ground_speed", 0, 0]), 0, message => messages.push(message)), null);
  assert.match(messages[0], /ground_speed/);
  assert.equal(sampleTrack([[0, 1e308, 0, 0], [1, -1e308, 0, 0]], 0.5), null);
  assert.deepEqual(sampleTrack(trackOf([1, 2, 3]), 0), [1, 2, 3]);
});

test("numeric edits cannot replace expressions and preserve animation extensions", () => {
  const source = { loop: false, animation_length: 2, override_previous_animation: true, sound_effects: { "0.50": { effect: "test" } }, bones: { body: { rotation: { "0.00": { pre: [0, 0, 0], post: ["q.anim_time", 0, 0] } }, position: { "0.00": [0, 0, 0] } } } };
  assert.equal(hasExpressions(source.bones.body.rotation), true);
  assert.equal(hasExpressions({ "0": { pre: ["q.anim_time", 0, 0], post: [0, 0, 0] } }), true);
  assert.equal(hasExpressions({ "0": { post: [0, 0, 0], lerp_mode: "catmullrom" } }), false);
  assert.throws(() => setBoneKey(source, "body", "rotation", 0, [9, 0, 0]), /Molang/);
  assert.throws(() => setKeyMode(source, "body", "rotation", 0, "linear"), /Molang/);
  const changed = setBoneKey(source, "body", "position", 1, [0, 16, 0]);
  const interpolated = setKeyMode(changed, "body", "position", 1, "catmullrom");
  const shifted = moveBoneKey(interpolated, "body", "position", 1, 1.5);
  const removed = clearBoneKey(shifted, "body", "position", 1.5);
  for (const doc of [changed, interpolated, shifted, removed]) {
    assert.deepEqual(doc.bones.body.rotation, source.bones.body.rotation);
    assert.deepEqual(doc.sound_effects, source.sound_effects);
    assert.equal(doc.override_previous_animation, true);
  }
});

test("curve value editing preserves timestamp spelling, pre and metadata", () => {
  const frame = { pre: [1, 0, 0], post: [5, 0, 0], lerp_mode: "catmullrom", extra: true };
  const source = { bones: { body: { rotation: { "1": frame } } } };
  const updated = setBoneKey(source, "body", "rotation", 1, [8, 0, 0]);
  assert.deepEqual(Object.keys(updated.bones.body.rotation), ["1"]);
  assert.deepEqual(updated.bones.body.rotation["1"], { ...frame, post: [8, 0, 0] });
  assert.deepEqual(source.bones.body.rotation["1"], frame);
  const moved = moveCurveKey(source, "body", "rotation", 1, 1.5, 0, 9);
  assert.deepEqual(moved.bones.body.rotation["1.50"], { ...frame, post: [9, 0, 0] });
  assert.equal(moved.bones.body.rotation["1"], undefined);
  const occupied = { bones: { body: { rotation: { "0": [0, 0, 0], "1": frame } } } };
  assert.throws(() => moveCurveKey(occupied, "body", "rotation", 1, 0, 0, 9), /目标时间已有关键帧/);
});
