const test = require("node:test"), assert = require("node:assert/strict");
const { createController, addState, setStateTransition, transitionDuration } = require("../shared/animation-controller.cjs");
const { advanceControllerSession, previewAnimationIds } = require("../shared/animation-controller-runtime.cjs");
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");

const controller = { initial_state: "a", states: {
  a: { animations: ["animation.a"], blend_transition: 1, transitions: [{ b: "q.anim_time >= 0.2" }] },
  b: { animations: ["animation.b"], blend_transition: 2 },
  c: { animations: [] },
} };
const map = { "controller.animation.demo": controller }, id = "controller.animation.demo";
const clips = {
  "animation.a": controllerClip({ loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, 10], position: [4, 0, 0], scale: [2, 1, 1] }, arm: { position: [0, 8, 0] } } }),
  "animation.b": controllerClip({ loop: false, animation_length: 4, bones: { body: { rotation: [0, 0, 90], position: [12, 0, 0], scale: [4, 1, 1] } } }),
};
const pose = session => controllerPose(controller, session.state, session.clips, session.time, session.transition);

test("outgoing duration controls transition; both clocks continue and no pose is frozen", () => {
  const start = { state: "a", time: 0, clips }, before = structuredClone(start);
  const changed = advanceControllerSession(map, id, start, 0.2);
  assert.equal(changed.state, "b"); assert.equal(changed.time, 0);
  assert.deepEqual(changed.transition, { state: "a", time: 0.2, duration: 1 });
  assert.deepEqual(pose(changed).clip.bones.body, { r: [[0, 0, 0, 10]], p: [[0, 4, 0, 0]], s: [[0, 2, 1, 1]] });
  const halfway = advanceControllerSession(map, id, changed, 0.5);
  assert.equal(halfway.transition.time, 0.7); assert.equal(halfway.time, 0.5);
  const result = pose(halfway);
  assert.deepEqual(result.clip.bones.body, { r: [[0, 0, 0, 50]], p: [[0, 8, 0, 0]], s: [[0, 3.75, 1, 1]] });
  assert.deepEqual(result.clip.bones.arm.p, [[0, 0, 4, 0]]);
  assert.deepEqual(result.transition, { from: "a", to: "b", progress: 0.5 });
  const end = advanceControllerSession(map, id, halfway, 0.5);
  assert.equal(end.transition, null); assert.equal(pose(end).transition, null);
  assert.deepEqual(pose(end).clip.bones.body.r, [[0, 0, 0, 90]]);
  assert.equal(pose(end).clip.bones.arm, undefined);
  assert.deepEqual(start, before);
  const moving = { ...clips, "animation.a": controllerClip({ loop: false, animation_length: 2, bones: { body: { position: { "0": [0, 0, 0], "2": [20, 0, 0] } } } }) };
  assert.deepEqual(controllerPose(controller, halfway.state, moving, halfway.time, halfway.transition).clip.bones.body.p, [[0, 9.5, 0, 0]]);
});

test("zero/absent durations switch immediately; interruptions replace only the previous state", () => {
  for (const duration of [undefined, 0]) {
    const c = structuredClone(controller); c.states.a.blend_transition = duration;
    const next = advanceControllerSession({ [id]: c }, id, { state: "a", time: 0, clips }, 0.3);
    assert.equal(next.transition, null);
  }
  const c = structuredClone(controller); c.states.b.transitions = [{ c: "q.anim_time >= 0.2" }];
  const first = advanceControllerSession({ [id]: c }, id, { state: "a", time: 0, clips }, 0.3);
  const second = advanceControllerSession({ [id]: c }, id, first, 0.2);
  assert.equal(second.state, "c");
  assert.deepEqual(second.transition, { state: "b", time: 0.2, duration: 2 });
  const fading = advanceControllerSession({ [id]: c }, id, second, 1);
  assert.deepEqual(controllerPose(c, fading.state, clips, fading.time, fading.transition).clip.bones.body.r, [[0, 0, 0, 45]]);
  assert.equal(advanceControllerSession({ [id]: c }, id, fading, 1).transition, null);
  assert.throws(() => advanceControllerSession(map, id, first, -1), /时间无效/);
});

test("duration edits preserve other fields and survive internal bbmodel roundtrip", () => {
  let doc = addState(createController(null, "demo"), id, "other");
  doc.animation_controllers[id].states.default.keep = { untouched: true };
  const before = structuredClone(doc);
  const changed = setStateTransition(doc, id, "default", "0.75");
  assert.equal(changed.animation_controllers[id].states.default.blend_transition, 0.75);
  assert.deepEqual(doc, before);
  assert.deepEqual(changed.animation_controllers[id].states.default.keep, { untouched: true });
  const p = exportProject({ identifier: "geometry.transition", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [] }], controllers: changed.animation_controllers });
  assert.deepEqual(importProject(p).controllers, changed.animation_controllers);
  assert.equal(setStateTransition(changed, id, "default", "").animation_controllers[id].states.default.blend_transition, undefined);
  assert.equal(transitionDuration({}), 0);
  for (const value of [-1, 61, NaN, Infinity, true, null, {}, [], "abc"]) assert.throws(() => setStateTransition(doc, id, "default", value));
  for (const change of [s => { s.blend_transition = { "0": 1, "1": 2 }; }, s => { s.blend_transition_curve = { "0": 1 }; }, s => { s.blend_via_shortest_path = "true"; }]) {
    const external = structuredClone(doc); change(external.animation_controllers[id].states.default);
    const snapshot = structuredClone(external);
    assert.throws(() => setStateTransition(external, id, "default", 0));
    assert.throws(() => previewAnimationIds(external.animation_controllers, id));
    assert.deepEqual(external, snapshot);
  }
});
