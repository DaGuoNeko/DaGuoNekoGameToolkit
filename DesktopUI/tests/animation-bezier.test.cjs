const test = require("node:test"), assert = require("node:assert/strict");
const { bezierAmount, bezierSegment, bakeBezier, sampleTrack, trackOf } = require("../src/features/skins/npc-clip.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");

test("cubic Bezier solves time independently from value, including overshoot and exact endpoints", () => {
  assert.equal(bezierAmount(0, [0, -2, 1, 3]), 0); assert.equal(bezierAmount(1, [0, -2, 1, 3]), 1);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(bezierAmount(t, [1 / 3, 0, 2 / 3, 0]) - t ** 3) < 1e-10);
    assert.ok(Math.abs(bezierAmount(t, [0.42, 0.42, 0.58, 0.58]) - t) < 1e-10);
  }
  assert.ok(bezierAmount(0.5, [0.25, 2, 0.75, 2]) > 1);
  assert.throws(() => bezierAmount(0.5, [0.8, 0, 0.2, 1]), /控制点/);
  assert.throws(() => bezierAmount(0.5, [0, NaN, 1, 1]), /控制点/);
  assert.throws(() => bezierAmount(-1, [0, 0, 1, 1]), /时间比例/);
});

test("baking changes only the selected axis inside consecutive keys and preserves endpoints, jumps and metadata", () => {
  const source = { loop: "hold_on_last_frame", animation_length: 3, sound_effects: { 0: { effect: "fixture" } }, bones: { body: { rotation: { "0": { post: [0, 0, 0], extra: true }, "1.000": { pre: [8, 16, 24], post: [10, 20, 30], extra: { keep: 42 } }, "2": [20, 40, 60] }, position: [4, 5, 6] }, child: { scale: [2, 2, 2] } } };
  const before = structuredClone(source), next = bakeBezier(source, "body", "rotation", 0, 0, [0.25, 0, 0.75, 0]);
  assert.deepEqual(source, before); assert.equal(next.loop, source.loop); assert.equal(next.animation_length, 3);
  assert.strictEqual(next.bones.child, source.bones.child); assert.strictEqual(next.bones.body.position, source.bones.body.position); assert.strictEqual(next.sound_effects, source.sound_effects);
  assert.strictEqual(next.bones.body.rotation["0"], source.bones.body.rotation["0"]); assert.strictEqual(next.bones.body.rotation["1.000"], source.bones.body.rotation["1.000"]);
  assert.equal(Object.keys(next.bones.body.rotation).length, 22); assert.deepEqual(next.bones.body.rotation["0.50"], [1, 8, 12]);
  const previousTrack = trackOf(source.bones.body.rotation), bakedTrack = trackOf(next.bones.body.rotation);
  for (const t of [0.125, 0.375, 0.875, 1, 1.25, 1.5, 2.5]) {
    const actual = sampleTrack(bakedTrack, t), expected = sampleTrack(previousTrack, t);
    assert.ok(Math.abs(actual[1] - expected[1]) < 1e-9); assert.ok(Math.abs(actual[2] - expected[2]) < 1e-9);
    if (t >= 1) assert.deepEqual(actual, expected);
  }
});

test("ambiguous times, expressions, short/large intervals and neighboring smooth curves fail without mutation", () => {
  const animation = frames => ({ animation_length: 5, bones: { body: { rotation: frames } } });
  const invalid = [
    animation({ "0": [0, 0, 0], "0.0": [1, 0, 0], "1": [2, 0, 0] }),
    animation({ "0": [0, 0, 0], "1": ["q.anim_time", 0, 0] }),
    animation({ "0": [0, 0, 0], "0.05": [2, 0, 0] }),
    animation({ "0": [0, 0, 0], "50.05": [2, 0, 0] }),
    animation({ "0": [0, 0, 0], "1.01": [2, 0, 0] }),
    animation({ "0": [0, 0, 0], "1": { post: [2, 0, 0], lerp_mode: "catmullrom" } }),
    animation({ "0": [0, 0, 0], "1": [2, 0, 0], "2": { post: [3, 0, 0], lerp_mode: "catmullrom" } }),
  ];
  for (const source of invalid) { const before = structuredClone(source); assert.throws(() => bakeBezier(source, "body", "rotation", 0, 0, [0.42, 0, 0.58, 1])); assert.deepEqual(source, before); }
  const previous = animation({ "0": [0, 0, 0], "1": { post: [1, 0, 0], lerp_mode: "catmullrom" }, "2": [2, 0, 0] });
  assert.throws(() => bezierSegment(previous, "body", "rotation", 1), /相邻区间/);
  assert.throws(() => bezierSegment(animation({ "0": [0, 0, 0], "1": [2, 0, 0] }), "body", "rotation", 1), /后续/);
  const excessive = animation({ "0": [0, 0, 0], "1": [1, 0, 0] }); excessive.bones.extra = { position: Object.fromEntries(Array.from({ length: 9999 }, (_, i) => [i, [0, 0, 0]])) };
  assert.throws(() => bakeBezier(excessive, "body", "rotation", 0, 0, [0, 0, 1, 1]), /10000/);
});

test("baked keys export as native handles and reimport with identical playback samples", () => {
  const source = { loop: false, animation_length: 1, bones: { body: { position: { "0": [0, 0, 0], "1": [16, 4, 2] } } } };
  const baked = bakeBezier(source, "body", "position", 0, 0, [0.42, -0.5, 0.58, 1.5]);
  const project = exportProject({ identifier: "geometry.bezier", bones: [{ name: "body", cubes: [] }], textureWidth: 64, textureHeight: 64, animations: { "animation.bezier": baked } });
  const returned = importProject(project).animations["animation.bezier"];
  const frames = Object.values(project.animations[0].animators)[0].keyframes;
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => frame.interpolation === "bezier"));
  assert.equal(frames[0].bezier_right_time[0], 0.42);
  assert.equal(frames[0].bezier_right_value[0], 8);
  assert.equal(frames[1].bezier_left_value[0], -8);
  for (const t of [0, 0.025, 0.25, 0.5, 0.75, 0.975, 1]) assert.deepEqual(sampleTrack(trackOf(returned.bones.body.position), t), sampleTrack(trackOf(baked.bones.body.position), t));
  assert.deepEqual(returned.dgn_bezier, baked.dgn_bezier);
});

test("rebaking the same span restores the original interval and replaces its control", () => {
  const source = { animation_length: 1, bones: { body: { rotation: { "0.00": [0, 0, 0], "1.00": [10, 0, 0] } } } };
  const first = bakeBezier(source, "body", "rotation", 0, 0, [0.25, 0, 0.75, 0]);
  assert.equal(first.dgn_bezier.length, 1);
  assert.equal(Object.keys(first.bones.body.rotation).length, 21);
  const second = bakeBezier(first, "body", "rotation", 0, 1, [0.1, 0.2, 0.9, 0.8]);
  assert.equal(Object.keys(second.bones.body.rotation).length, 21);
  assert.deepEqual(second.dgn_bezier.map(item => item.axis).sort(), [0, 1]);
  assert.deepEqual(second.bones.body.rotation["0.50"], [1.25, 0, 0]);
});
