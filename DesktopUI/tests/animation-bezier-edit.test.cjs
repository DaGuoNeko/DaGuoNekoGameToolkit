const test = require("node:test"), assert = require("node:assert/strict");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { nativeBezierDraft, updateNativeBezier, changeNativeHandle, linkNativeHandles } = require("../shared/animation-bezier-edit.cjs");
const { sampleTrack, trackOf } = require("../src/features/skins/npc-clip.cjs");

function fixture(channel = "rotation") {
  const project = exportProject({ identifier: "geometry.native", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16,
    animations: { "animation.native": { animation_length: 2, bones: { body: { [channel]: { "0": [0, 2, 0], "1": { pre: [80, 2, 0], post: [90, 3, 4] }, "2": [100, 4, 8] } } } } } });
  const frames = Object.values(project.animations[0].animators)[0].keyframes;
  frames.forEach(frame => Object.assign(frame, { interpolation: "bezier", bezier_linked: false, bezier_left_time: [-1 / 3, -1 / 3, -1 / 3], bezier_right_time: [1 / 3, 1 / 3, 1 / 3], bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0] }));
  const animation = importProject(project).animations["animation.native"];
  animation.bones.body[channel]["0.00"] = { post: animation.bones.body[channel]["0.00"], keep: "endpoint" };
  animation.bones.body[channel]["0.50"] = { post: animation.bones.body[channel]["0.50"], keep: "sample" };
  animation.bones.extra = { scale: [1, 2, 3] }; animation.sound_effects = { "0.5": { effect: "test.keep" } };
  return animation;
}
test("native handles edit in model coordinates, preserve endpoint metadata and other axes/channels", () => {
  for (const channel of ["rotation", "position", "scale"]) {
    const source = fixture(channel), original = structuredClone(source);
    const draft = nativeBezierDraft(source, "body", channel);
    assert.equal(draft[1].data_points[0].x, 80);
    assert.equal(updateNativeBezier(source, "body", channel, draft), source);
    const next = updateNativeBezier(source, "body", channel, changeNativeHandle(draft, 0, "right", 0, 1 / 3, 40));
    assert.deepEqual(source, original);
    assert.equal(next.bones.body[channel]["0.00"].keep, "endpoint");
    assert.equal(next.bones.body[channel]["0.50"].keep, "sample");
    assert.equal(sampleTrack(trackOf(next.bones.body[channel]), 0.5)[0], 55);
    assert.deepEqual(next.bones.body[channel]["1.00"], source.bones.body[channel]["1.00"]);
    for (const at of [0.25, 0.5, 0.75, 1, 1.5]) {
      assert.deepEqual(sampleTrack(trackOf(next.bones.body[channel]), at).slice(1), sampleTrack(trackOf(source.bones.body[channel]), at).slice(1));
    }
    assert.strictEqual(next.bones.extra, source.bones.extra); assert.strictEqual(next.sound_effects, source.sound_effects);
    assert.equal(nativeBezierDraft(next, "body", channel)[0].bezier_right_value[0], 40);
  }
});
test("link toggle mirrors XYZ; a subsequent drag adjusts both handles on only the active axis", () => {
  const source = fixture(), draft = nativeBezierDraft(source, "body", "rotation");
  draft[1].bezier_left_value = [10, 20, 30];
  const linked = linkNativeHandles(draft, 1, "left", true);
  assert.deepEqual(linked[1].bezier_right_value, [-10, -20, -30]);
  const changed = changeNativeHandle(linked, 1, "left", 1, -0.2, 6);
  assert.deepEqual(changed[1].bezier_right_value, [-10, -6, -30]);
  assert.equal(changed[1].bezier_right_time[1], 0.2);
  const next = updateNativeBezier(source, "body", "rotation", changed);
  assert.equal(nativeBezierDraft(next, "body", "rotation")[1].bezier_linked, true);
  assert.notDeepEqual(sampleTrack(trackOf(next.bones.body.rotation), 1.5), sampleTrack(trackOf(source.bones.body.rotation), 1.5));
});
test("stale samples, endpoint edits, malformed parameters and total budget reject without mutation", () => {
  const source = fixture(), original = structuredClone(source), draft = nativeBezierDraft(source, "body", "rotation");
  assert.throws(() => changeNativeHandle(draft, 0, "left", 0, 1, 2), /入柄/);
  assert.throws(() => changeNativeHandle(draft, 0, "right", 0, 1, NaN), /无效/);
  const moved = structuredClone(draft); moved[1].time = 1.1;
  assert.throws(() => updateNativeBezier(source, "body", "rotation", moved), /端点/);
  const stale = structuredClone(source); stale.bones.body.rotation["0.50"].post[0] = 999;
  assert.throws(() => nativeBezierDraft(stale, "body", "rotation"), /采样帧已修改/);
  const excessive = structuredClone(source); excessive.bones.extra.rotation = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [i / 20, [0, 0, 0]]));
  assert.throws(() => updateNativeBezier(excessive, "body", "rotation", changeNativeHandle(draft, 0, "right", 0, 0.3, 20)), /10000/);
  assert.deepEqual(source, original);
});
