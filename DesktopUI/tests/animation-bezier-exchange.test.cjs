const test = require("node:test");
const assert = require("node:assert/strict");
const { bakeNativeFrames } = require("../shared/animation-bezier-exchange.cjs");
const { bakeBezier, trackOf, sampleTrack, moveCurveKey } = require("../src/features/skins/npc-clip.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");

const project = () => exportProject({ identifier: "geometry.native", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16,
  animations: { "animation.native": { loop: false, animation_length: 2, bones: { body: { position: { "0.00": [0, 2, 0], "1.00": [8, 2, 4], "2.00": [16, 2, 8] } } } } } });
const keys = p => Object.values(p.animations[0].animators)[0].keyframes;
function fixture() {
  const p = project(), [first, middle, last] = keys(p);
  // Blockbench Keyframe.getBezierLerp: handles are signed offsets in seconds/value, one component per axis.
  // Official keyframe.js blob: 61eacaa893d93da12a9fe29c813df7586823ed69.
  for (const frame of keys(p)) Object.assign(frame, { interpolation: "bezier", bezier_linked: false,
    bezier_left_time: [-1 / 3, -1 / 3, -1 / 3], bezier_right_time: [1 / 3, 1 / 3, 1 / 3],
    bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0] });
  first.bezier_right_value = [0, 3, 4 / 3];
  middle.bezier_left_value = [8, 3, -4 / 3];
  middle.bezier_right_value = [-8 / 3, 0, 4 / 3];
  last.bezier_left_value = [8 / 3, 0, -4 / 3];
  return p;
}
const animation = p => importProject(p).animations["animation.native"];
const reexport = value => exportProject({ identifier: "geometry.native", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16, animations: { "animation.native": value } });

test("native per-axis handles sample cubic time, flat-endpoint overshoot and adjacent straight segment", () => {
  const p = fixture(), before = structuredClone(p), restored = animation(p);
  assert.deepEqual(p, before);
  const samples = trackOf(restored.bones.body.position);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const point = sampleTrack(samples, t);
    assert.ok(Math.abs(point[0] - 8 * t ** 3) < 0.001);
    assert.ok(Math.abs(point[1] - (2 + 9 * t * (1 - t))) < 0.001);
    assert.ok(Math.abs(point[2] - 4 * t) < 0.001);
  }
  assert.deepEqual(sampleTrack(samples, 1.5), [12, 2, 6]);
  assert.equal(restored.dgn_native_bezier.length, 1);
  const output = reexport(restored);
  for (let i = 0; i < keys(p).length; i++) {
    for (const field of ["interpolation", "bezier_linked", "bezier_left_time", "bezier_right_time", "bezier_left_value", "bezier_right_value", "data_points"]) assert.deepEqual(keys(output)[i][field], keys(p)[i][field]);
  }
});

test("4.10 handle values convert with the same axes as keyframe data; 5.0 output keeps the pose", () => {
  for (const channel of ["position", "rotation", "scale"]) {
    const p = fixture(); p.meta.format_version = "4.10";
    keys(p).forEach(frame => { frame.channel = channel; });
    const restored = animation(p), output = reexport(restored), again = animation(output);
    for (const t of [0, 0.25, 0.5, 1, 1.5, 2]) assert.deepEqual(sampleTrack(trackOf(restored.bones.body[channel]), t), sampleTrack(trackOf(again.bones.body[channel]), t));
    for (let axis = 0; axis < 3; axis++) {
      const flipped = channel === "position" ? axis === 0 : channel === "rotation" && axis < 2;
      assert.equal(keys(output)[0].bezier_right_value[axis], keys(p)[0].bezier_right_value[axis] * (flipped ? -1 : 1) || 0);
    }
  }
});

test("manual edits, deleted samples and stale source do not resurrect old native curves", () => {
  const restored = animation(fixture());
  const changed = moveCurveKey(restored, "body", "position", 0.5, 0.5, 0, 7);
  const output = reexport(changed);
  assert.ok(keys(output).every(frame => frame.interpolation === "linear"));
  assert.equal(sampleTrack(trackOf(animation(output).bones.body.position), 0.5)[0], 7);
  delete restored.bones.body.position["0.50"];
  assert.ok(keys(reexport(restored)).every(frame => frame.interpolation === "linear"));
  const badMetadata = animation(fixture());
  badMetadata.dgn_native_bezier[0].frames.forEach(frame => { frame.channel = "rotation"; });
  assert.ok(keys(reexport(badMetadata)).every(frame => frame.channel === "position" && frame.interpolation === "linear"));
});

test("recorded easing collapses adjacent spans and preserves a two-point endpoint", () => {
  const source = { animation_length: 3, bones: { body: { rotation: { "0": [0, 0, 0], "1": { pre: [8, 0, 4], post: [10, 1, 5] }, "2": [18, 2, 9], "3": [26, 3, 13] } } } };
  let baked = bakeBezier(source, "body", "rotation", 0, 0, [0.25, 0, 0.75, 0]);
  baked = bakeBezier(baked, "body", "rotation", 1, 2, [0.42, 0, 0.58, 1]);
  const output = reexport(baked);
  assert.equal(keys(output).length, 4);
  const back = animation(output);
  for (let n = 0; n <= 60; n++) {
    const a = sampleTrack(trackOf(back.bones.body.rotation), n / 20), b = sampleTrack(trackOf(baked.bones.body.rotation), n / 20);
    a.forEach((value, axis) => assert.ok(Math.abs(value - b[axis]) < 0.0011, n + ":" + axis));
  }
  baked.bones.body.rotation["0.50"][1] = 99;
  assert.ok(keys(reexport(baked)).every(frame => frame.interpolation === "linear"));
});

test("invalid handles, mixed interpolation, expressions, duplicate times and sampling limits reject atomically", () => {
  for (const change of [
    p => { keys(p)[0].bezier_right_time = [0, NaN, 0]; },
    p => { keys(p)[0].data_points[0].x = "q.anim_time"; },
    p => { keys(p)[1].interpolation = "catmullrom"; },
    p => { keys(p)[1].interpolation = "step"; },
    p => { keys(p)[1].time = 0; },
    p => { keys(p)[1].time = 0.03; },
    p => { keys(p)[2].time = 100; },
  ]) {
    const p = fixture(); change(p); const before = structuredClone(p);
    assert.throws(() => animation(p)); assert.deepEqual(p, before);
  }
  const frames = Array.from({ length: 12 }, (_, i) => ({ ...keys(fixture())[0], time: i * 50 }));
  assert.throws(() => bakeNativeFrames(frames), /10000/);
});
