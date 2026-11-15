const test = require("node:test"), assert = require("node:assert/strict");
const { shortestRotation, controllerPose, controllerClip } = require("../src/features/mods/model-controller-blend.cjs");
const { createController, setStateShortestPath, setStateTransitionCurve, setStateTransition, validateControllers } = require("../shared/animation-controller.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const clip = rotation => controllerClip({ bones: { body: { rotation } } });

test("each Euler axis crosses the wrap in either direction; half turns keep their original sign", () => {
  assert.equal(shortestRotation(170, -170, 0.5), 180);
  assert.equal(shortestRotation(-170, 170, 0.5), -180);
  assert.equal(shortestRotation(350, 10, 0.5), 360);
  assert.equal(shortestRotation(720, 20, 0.5), 730);
  assert.equal(shortestRotation(0, 180, 0.5), 90);
  assert.equal(shortestRotation(0, -180, 0.5), -90);
  assert.equal(shortestRotation(10, 10, 0.5), 10);
  for (const bad of [NaN, Infinity, 1000001]) assert.throws(() => shortestRotation(bad, 0, 0.5), /无效/);
  assert.throws(() => shortestRotation(0, 0, -1), /无效/);
});
test("outgoing flag selects shortest rotation on weighted state poses without changing other channels", () => {
  const controller = { states: { a: { animations: ["animation.a"], blend_transition: 2 }, b: { animations: ["animation.b"], blend_via_shortest_path: true } } };
  const clips = {
    "animation.a": controllerClip({ bones: { body: { rotation: [170, -170, 350], position: [0, 4, 0], scale: [2, 1, 1] } } }),
    "animation.b": controllerClip({ bones: { body: { rotation: [-170, 170, 10], position: [10, 0, 0], scale: [4, 1, 1] } } }),
  };
  const transition = { state: "a", time: 1.2, duration: 2 };
  const direct = controllerPose(controller, "b", clips, 1, transition);
  assert.deepEqual(direct.clip.bones.body.r, [[0, 0, 0, 180]], "target flag does not change outgoing transition");
  controller.states.a.blend_via_shortest_path = true;
  const shortest = controllerPose(controller, "b", clips, 1, transition);
  assert.deepEqual(shortest.clip.bones.body.r, [[0, 180, -180, 360]]);
  for (const c of ["p", "s"]) assert.deepEqual(shortest.clip.bones.body[c], direct.clip.bones.body[c]);
  assert.deepEqual(controllerPose(controller, "b", clips, 0, transition).clip.bones.body.r, [[0, 170, -170, 350]]);
  assert.deepEqual(controllerPose(controller, "b", clips, 2, transition).clip.bones.body.r, [[0, -170, 170, 10]]);
  assert.deepEqual(controllerPose(controller, "b", clips, 0).clip.bones.body.r, [[0, -170, 170, 10]]);
});
test("curve factor, multi-animation weights and override are combined before shortest interpolation", () => {
  const controller = { states: {
    a: { animations: [{ "animation.a": 0.5 }, "animation.extra"], blend_transition: { "0": 1, "1": 0.8, "2": 0 }, blend_via_shortest_path: true },
    b: { animations: ["animation.b", "animation.override"] },
    empty: { animations: [] },
  } };
  const clips = { "animation.a": clip([0, 0, 300]), "animation.extra": clip([0, 0, 20]), "animation.b": clip([0, 0, 40]),
    "animation.override": controllerClip({ override_previous_animation: true, bones: { body: { rotation: [0, 0, -170] } } }) };
  const result = controllerPose(controller, "b", clips, 1, { state: "a", time: 3, duration: 2 });
  assert.ok(Math.abs(result.clip.bones.body.r[0][3] - 174) < 1e-10);
  assert.equal(result.transition.progress, 0.5);
  assert.deepEqual(controllerPose(controller, "empty", clips, 0.5, { state: "a", time: 0, duration: 1 }).clip.bones.body.r, [[0, 0, 0, 136]]);
  const invalid = { ...clips, "animation.extra": clip([0, 0, 2e6]) };
  assert.throws(() => controllerPose(controller, "b", invalid, 1, { state: "a", time: 3, duration: 2 }), /超限/);
});
test("toggle persists and clearing restores the default, preserving curves, state metadata and project exchange", () => {
  const id = "controller.animation.short";
  const doc = createController(null, "short"); doc.animation_controllers[id].states.default.extra = { keep: true };
  const before = structuredClone(doc);
  const enabled = setStateShortestPath(doc, id, "default", true);
  const curved = setStateTransitionCurve(enabled, id, "default", 2, [{ time: 0, value: 1 }, { time: 0.5, value: 0.8 }, { time: 1, value: 0 }]);
  const resized = setStateTransition(curved, id, "default", 4);
  assert.equal(resized.animation_controllers[id].states.default.blend_via_shortest_path, true);
  const p = exportProject({ identifier: "geometry.short", bones: [{ name: "body", cubes: [] }], textureWidth: 16, textureHeight: 16, controllers: resized.animation_controllers });
  assert.deepEqual(importProject(p).controllers, resized.animation_controllers);
  const cleared = setStateShortestPath(resized, id, "default", false).animation_controllers[id].states.default;
  assert.equal(cleared.blend_via_shortest_path, undefined);
  assert.deepEqual(cleared.blend_transition, { "0": 1, "2": 0.8, "4": 0 });
  assert.deepEqual(cleared.extra, { keep: true }); assert.deepEqual(doc, before);
  for (const value of [1, "true", null, {}, []]) {
    assert.throws(() => setStateShortestPath(doc, id, "default", value), /布尔/);
    const malformed = structuredClone(doc); malformed.animation_controllers[id].states.default.blend_via_shortest_path = value;
    assert.throws(() => validateControllers(malformed.animation_controllers), /布尔/);
  }
});
