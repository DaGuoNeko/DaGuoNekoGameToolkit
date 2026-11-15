const test = require("node:test"), assert = require("node:assert/strict");
const { readTransition, writeTransition, transitionIncoming, checkPoints, addTransitionPoint, moveTransitionPoint, removeTransitionPoint } = require("../shared/controller-transition-curve.cjs");
const { createController, setStateTransition, setStateTransitionCurve } = require("../shared/animation-controller.cjs");
const { advanceControllerSession } = require("../shared/animation-controller-runtime.cjs");
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const points = [{ time: 0, value: 1 }, { time: 0.5, value: 0.8 }, { time: 1, value: 0 }];

test("seconds-map and Blockbench normalized curve have the same outgoing-weight semantics", () => {
  const absolute = readTransition({ blend_transition: { "2": 0, "0.0": 1, "1": 0.8 } });
  const normalized = readTransition({ blend_transition: 2, blend_transition_curve: { "0": 1, "0.5": 0.8, "1": 0 } });
  assert.deepEqual(absolute, { duration: 2, points });
  assert.deepEqual(absolute, normalized);
  assert.equal(transitionIncoming(points, 0), 0);
  assert.ok(Math.abs(transitionIncoming(points, 0.25) - 0.1) < 1e-10);
  assert.ok(Math.abs(transitionIncoming(points, 0.75) - 0.6) < 1e-10);
  assert.equal(transitionIncoming(points, 1), 1);
  assert.equal(transitionIncoming(null, 0.25), 0.25);
});
test("curve insertion/movement/deletion preserves input and enforces fixed endpoints and time order", () => {
  const original = structuredClone(points);
  const added = addTransitionPoint(points, 0);
  assert.deepEqual(added[1], { time: 0.25, value: 0.9 });
  const moved = moveTransitionPoint(added, 1, 0.2, 0.7);
  assert.deepEqual(removeTransitionPoint(moved, 1), points);
  assert.deepEqual(points, original);
  assert.throws(() => moveTransitionPoint(points, 0, 0, 0), /首尾/);
  assert.throws(() => moveTransitionPoint(points, 1, 1, 0.5), /递增/);
  assert.throws(() => removeTransitionPoint(points, 2), /首尾/);
  assert.throws(() => addTransitionPoint(points, 2), /后续/);
});
test("save/rescale/linear restore preserve other state fields and internal project exchange", () => {
  let doc = createController(null, "curve"), id = "controller.animation.curve";
  doc.animation_controllers[id].states.default.keep = { untouched: true };
  const original = structuredClone(doc);
  const saved = setStateTransitionCurve(doc, id, "default", 2, points);
  assert.deepEqual(saved.animation_controllers[id].states.default.blend_transition, { "0": 1, "1": 0.8, "2": 0 });
  const resized = setStateTransition(saved, id, "default", 4);
  assert.deepEqual(resized.animation_controllers[id].states.default.blend_transition, { "0": 1, "2": 0.8, "4": 0 });
  const restored = setStateTransitionCurve(resized, id, "default", 4, null);
  assert.equal(restored.animation_controllers[id].states.default.blend_transition, 4);
  assert.equal(setStateTransition(restored, id, "default", "").animation_controllers[id].states.default.blend_transition, undefined);
  assert.deepEqual(doc, original);
  assert.deepEqual(resized.animation_controllers[id].states.default.keep, { untouched: true });
  assert.throws(() => setStateTransition(resized, id, "default", 0), /恢复线性/);
  const project = exportProject({ identifier: "geometry.curve", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16, controllers: resized.animation_controllers });
  assert.deepEqual(importProject(project).controllers, resized.animation_controllers);
  const normalized = { blend_transition: 2, blend_transition_curve: { "0": 1, "0.5": 0.8, "1": 0 }, keep: 1 };
  assert.equal(writeTransition(normalized, 3, points).blend_transition_curve, undefined);
});
test("nonlinear transition changes actual pose while elapsed progress, clocks and completion stay independent", () => {
  const id = "controller.animation.curve";
  const controller = { states: {
    a: { animations: ["animation.a"], blend_transition: { "0": 1, "1": 0.8, "2": 0 }, transitions: [{ b: "1" }] },
    b: { animations: ["animation.b"] },
  } };
  const clips = {
    "animation.a": controllerClip({ bones: { body: { rotation: [0, 0, 0], scale: [2, 1, 1] } } }),
    "animation.b": controllerClip({ bones: { body: { rotation: [0, 0, 100], position: [10, 0, 0], scale: [4, 1, 1] } } }),
  };
  const start = advanceControllerSession({ [id]: controller }, id, { state: "a", time: 0, clips }, 0.1);
  const middle = advanceControllerSession({ [id]: controller }, id, start, 1);
  const actual = controllerPose(controller, middle.state, clips, middle.time, middle.transition);
  assert.equal(actual.transition.progress, 0.5);
  assert.ok(Math.abs(actual.clip.bones.body.r[0][3] - 20) < 1e-10);
  assert.ok(Math.abs(actual.clip.bones.body.p[0][1] - 2) < 1e-10);
  assert.ok(Math.abs(actual.clip.bones.body.s[0][1] - 2.88) < 1e-10);
  const end = advanceControllerSession({ [id]: controller }, id, middle, 1);
  assert.equal(end.transition, null);
  assert.equal(controllerPose(controller, end.state, clips, end.time).clip.bones.body.r[0][3], 100);
  // 权重可在中间暂时回到 1，不能据此提前结束仍在计时的过渡。
  const rebound = [{ time: 0, value: 1 }, { time: 0.3, value: 0 }, { time: 0.7, value: 0.8 }, { time: 1, value: 0 }];
  assert.equal(transitionIncoming(rebound, 0.3), 1);
  assert.ok(Math.abs(transitionIncoming(rebound, 0.7) - 0.2) < 1e-10);
});
test("ambiguous/malformed or oversized curves reject without replacement", () => {
  for (const raw of [{ "0": 1 }, { "0": 1, "0.0": 1, "1": 0 }, { "0": 1, "1": 2 }, { "0": 0, "1": 0 }, { "0.2": 1, "1": 0 }, { "0": 1, "61": 0 }, { "": 1, "1": 0 }]) {
    assert.throws(() => readTransition({ blend_transition: raw }));
  }
  assert.throws(() => readTransition({ blend_transition: { "0": 1, "1": 0 }, blend_transition_curve: { "0": 1, "1": 0 } }), /两套/);
  assert.throws(() => readTransition({ blend_transition: 0, blend_transition_curve: { "0": 1, "1": 0 } }), /大于零/);
  assert.throws(() => readTransition({ blend_transition: 1, blend_transition_curve: [] }), /格式/);
  assert.throws(() => writeTransition({}, 0.0000001, points), /重合/);
  assert.throws(() => checkPoints(Array.from({ length: 33 }, (_, i) => ({ time: i / 32, value: 1 - i / 32 }))), /32/);
  assert.throws(() => transitionIncoming(points, NaN), /进度/);
});
