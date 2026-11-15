const test = require("node:test"), assert = require("node:assert/strict");
const { controllerCompletion, advanceControllerSession } = require("../shared/animation-controller-runtime.cjs");
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");
const { evaluateMolang } = require("../shared/molang-preview.cjs");
const { validateMolangContext, validateControllerQueries } = require("../shared/molang-context.cjs");
const { addTransition, createController, addState, setStateAnimations } = require("../shared/animation-controller.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const id = "controller.animation.finish";
const controller = { states: {
  start: { animations: ["animation.short", { "animation.long": 0 }], transitions: [{ next: "q.all_animations_finished" }], blend_transition: 0.5 },
  next: { animations: ["animation.short"], transitions: [{ end: "query.any_animation_finished" }] },
  end: { animations: [] },
} };
const clips = { "animation.short": controllerClip({ animation_length: 0.5, loop: true, bones: {} }), "animation.long": controllerClip({ animation_length: 1, loop: "hold_on_last_frame", bones: {} }) };

test("completion uses unwrapped state time including looping, hold and zero-weight references", () => {
  const expect = (time, finished, any, all) => assert.deepEqual(controllerCompletion(controller, "start", clips, time), { total: 2, finished, queries: { "query.any_animation_finished": any, "query.all_animations_finished": all } });
  expect(0, 0, 0, 0); expect(0.499, 0, 0, 0); expect(0.5, 1, 1, 0); expect(1, 2, 1, 1); expect(10.25, 2, 1, 1);
  assert.deepEqual(controllerCompletion(controller, "end", clips, 0), { total: 0, finished: 0, queries: { "query.any_animation_finished": 0, "query.all_animations_finished": 1 } });
  assert.throws(() => controllerCompletion(controller, "start", {}, 0), /未加载/);
  assert.throws(() => controllerCompletion(controller, "start", { ...clips, "animation.short": { length: NaN } }, 0), /时长/);
  assert.throws(() => controllerCompletion(controller, "start", clips, -1), /时间/);
});
test("completion transitions reset for the destination and stay isolated from outgoing state during fading", () => {
  const start = { state: "start", time: 0, clips };
  const halfway = advanceControllerSession({ [id]: controller }, id, start, 0.5);
  assert.equal(halfway.state, "start");
  const next = advanceControllerSession({ [id]: controller }, id, halfway, 0.5);
  assert.equal(next.state, "next"); assert.equal(next.time, 0);
  assert.deepEqual(next.transition, { state: "start", time: 1, duration: 0.5 });
  assert.equal(controllerPose(controller, "next", clips, 0, next.transition).completion.finished, 0);
  assert.equal(advanceControllerSession({ [id]: controller }, id, next, 0.49).state, "next");
  assert.equal(advanceControllerSession({ [id]: controller }, id, next, 0.5).state, "end");
  assert.equal(start.time, 0);
});
test("runtime completion reaches weight and track expressions without manual query activation", () => {
  const c = { states: { a: { animations: [{ "animation.a": "q.any_animation_finished ? 1 : 0.5" }] } } };
  const map = { "animation.a": controllerClip({ animation_length: 1, loop: true, bones: { body: { rotation: [0, "query.all_animations_finished ? 40 : 20", 0] } } }) };
  assert.deepEqual(controllerPose(c, "a", map, 0.5).clip.bones.body.r, [[0, 0, 10, 0]]);
  assert.deepEqual(controllerPose(c, "a", map, 1.5).clip.bones.body.r, [[0, 0, 40, 0]]);
  const runtime = { "query.any_animation_finished": 1, "query.all_animations_finished": 0 };
  assert.equal(evaluateMolang("Q.ANY_ANIMATION_FINISHED && !query.all_animations_finished", 0, undefined, runtime), 1);
  assert.throws(() => evaluateMolang("q.any_animation_finished", 0), /仅控制器/);
  assert.throws(() => validateMolangContext(runtime), /不支持/);
  assert.throws(() => evaluateMolang("q.any_animation_finished", 0, { "query.any_animation_finished": 1 }), /不支持/);
  for (const value of [null, {}, [], { "query.any_animation_finished": true, "query.all_animations_finished": 0 }, { "query.any_animation_finished": 1, "query.all_animations_finished": 2 }]) assert.throws(() => validateControllerQueries(value));
  const getter = { "query.all_animations_finished": 0 }; Object.defineProperty(getter, "query.any_animation_finished", { get() { throw Error("must not run"); }, enumerable: true });
  assert.throws(() => validateControllerQueries(getter), /无效/);
});
test("duration is explicit or inferred from final bone/effect key; no arbitrary one-second fallback", () => {
  assert.equal(controllerClip({ bones: {} }).length, 0);
  assert.equal(controllerClip({ animation_length: 0, bones: {} }).length, 0);
  assert.equal(controllerClip({ bones: { a: { rotation: { "0": [0, 0, 0], "2.5": [1, 0, 0] } } } }).length, 2.5);
  assert.equal(controllerClip({ bones: {}, sound_effects: { "3.25": { effect: "test" } } }).length, 3.25);
  assert.equal(controllerClip({ animation_length: 1, bones: {}, timeline: { "5": "/say test" } }).length, 1);
  for (const length of [-1, "1", NaN, Infinity, 10001, null]) assert.throws(() => controllerClip({ animation_length: length, bones: {} }), /时长/);
  assert.throws(() => controllerClip({ bones: {}, particle_effects: { invalid: {} } }), /效果时间/);
});
test("completion expressions survive editing and internal project roundtrip unchanged", () => {
  let doc = addState(createController(null, "finish"), id, "next");
  doc = setStateAnimations(doc, id, "default", ["animation.short"]);
  doc = addTransition(doc, id, "default", "next", "query.all_animations_finished");
  const project = exportProject({ identifier: "geometry.finished", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [] }], controllers: doc.animation_controllers });
  assert.deepEqual(importProject(project).controllers, doc.animation_controllers);
});
