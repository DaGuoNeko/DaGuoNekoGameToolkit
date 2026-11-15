const test = require("node:test");
const assert = require("node:assert/strict");
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");
const { createController, setStateAnimations, setStateAnimationWeight, moveStateAnimation, validateControllers } = require("../shared/animation-controller.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");

const a = { loop: true, animation_length: 1, bones: { body: { rotation: [0, 0, 30], position: [2, 0, 0], scale: [2, 1, 1] } } };
const b = { loop: true, animation_length: 2, bones: { body: { rotation: [0, 0, 50], position: [6, 0, 0], scale: [3, 1, 1] }, arm: { rotation: [10, 0, 0] } } };
const clips = { "animation.a": controllerClip(a), "animation.b": controllerClip(b) };
const controller = entries => ({ states: { default: { animations: entries } } });

test("weighted Euler/position accumulate and scale multiplies around one; sources are immutable", () => {
  const before = structuredClone(clips);
  const result = controllerPose(controller(["animation.a", { "animation.b": 0.5 }]), "default", clips, 0.75);
  assert.deepEqual(result.clip.bones.body, { r: [[0, 0, 0, 55]], p: [[0, 5, 0, 0]], s: [[0, 4, 1, 1]] });
  assert.deepEqual(result.clip.bones.arm.r, [[0, 5, 0, 0]]);
  assert.deepEqual(result.weights, [{ id: "animation.a", weight: 1 }, { id: "animation.b", weight: 0.5 }]);
  assert.deepEqual(clips, before);
  assert.deepEqual(controllerPose(controller([]), "default", clips, 0).clip.bones, Object.create(null));
});

test("weight expressions use state time, each clip samples its own loop/length, and zero does not reset", () => {
  const map = {
    "animation.a": controllerClip({ ...a, bones: { body: { position: { "0": [0, 0, 0], "1": [10, 0, 0] } } } }),
    "animation.b": controllerClip({ ...b, loop: false, bones: { body: { position: { "0": [0, 0, 0], "2": [0, 20, 0] } } } }),
  };
  const result = controllerPose(controller([{ "animation.a": "math.clamp(q.anim_time / 2, 0, 1)" }, { "animation.b": 0.5 }]), "default", map, 1.5);
  assert.deepEqual(result.clip.bones.body.p, [[0, 3.75, 7.5, 0]]);
  const zero = controllerPose(controller(["animation.a", { "animation.b": 0 }]), "default", { ...clips, "animation.b": { ...clips["animation.b"], override: true } }, 0);
  assert.deepEqual(zero.clip.bones.body.r, [[0, 0, 0, 30]]);
});

test("override clears only affected channels and follows explicit list order", () => {
  const map = { ...clips, "animation.b": controllerClip({ override_previous_animation: true, bones: { body: { rotation: [0, 0, 50] } } }) };
  const after = controllerPose(controller(["animation.a", { "animation.b": 0.5 }]), "default", map, 0).clip.bones.body;
  assert.deepEqual(after.r, [[0, 0, 0, 25]]);
  assert.deepEqual(after.p, [[0, 2, 0, 0]]);
  const before = controllerPose(controller([{ "animation.b": 0.5 }, "animation.a"]), "default", map, 0).clip.bones.body;
  assert.deepEqual(before.r, [[0, 0, 0, 55]]);
});

test("invalid weights, missing clips, invalid expressions and unsupported timing fail explicitly", () => {
  for (const weight of [-0.1, 1.1, NaN, "query.is_moving", "1 / 0", "q.anim_time"]) {
    assert.throws(() => controllerPose(controller([{ "animation.a": weight }]), "default", clips, 2));
  }
  assert.throws(() => controllerPose(controller(["animation.missing"]), "default", clips, 0), /未加载/);
  for (const field of ["blend_weight", "start_delay", "loop_delay", "anim_time_update"]) assert.throws(() => controllerClip({ ...a, [field]: 1 }), /暂不支持/);
  assert.throws(() => controllerClip({ ...a, bones: { body: { relative_to: {} } } }), /骨骼通道/);
  for (const value of [null, 1, []]) assert.throws(() => controllerClip(value), /动画数据无效/);
  assert.throws(() => controllerPose(controller(["animation.a"]), "default", { "animation.a": controllerClip({ bones: { body: { position: [1e9, 0, 0] } } }) }, 0), /超限/);
});

test("weight edit, clear, reorder and engineering exchange preserve unknown fields and other rows", () => {
  let doc = setStateAnimations(createController(null, "mob"), "controller.animation.mob", "default", ["animation.a", "animation.b"]);
  doc.animation_controllers["controller.animation.mob"].states.default.keep = { unchanged: true };
  const original = structuredClone(doc);
  doc = setStateAnimationWeight(doc, "controller.animation.mob", "default", "animation.b", "0");
  assert.deepEqual(doc.animation_controllers["controller.animation.mob"].states.default.animations, ["animation.a", { "animation.b": 0 }]);
  doc = setStateAnimationWeight(doc, "controller.animation.mob", "default", "animation.b", "math.clamp(q.anim_time, 0, 1)");
  doc = moveStateAnimation(doc, "controller.animation.mob", "default", "animation.b", -1);
  const project = exportProject({ identifier: "geometry.blend", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16, controllers: doc.animation_controllers });
  assert.deepEqual(importProject(project).controllers, doc.animation_controllers);
  doc = setStateAnimationWeight(doc, "controller.animation.mob", "default", "animation.b", "");
  assert.deepEqual(doc.animation_controllers["controller.animation.mob"].states.default.animations, ["animation.b", "animation.a"]);
  assert.deepEqual(doc.animation_controllers["controller.animation.mob"].states.default.keep, { unchanged: true });
  for (const bad of [-1, 2, Infinity, "Infinity", "1e999", null, {}, []]) assert.throws(() => setStateAnimationWeight(original, "controller.animation.mob", "default", "animation.b", bad));
  assert.deepEqual(original.animation_controllers["controller.animation.mob"].states.default.animations, ["animation.a", "animation.b"]);
  const duplicate = structuredClone(original); duplicate.animation_controllers["controller.animation.mob"].states.default.animations.push({ "animation.a": 0 });
  assert.throws(() => validateControllers(duplicate.animation_controllers), /不能重复/);
});
