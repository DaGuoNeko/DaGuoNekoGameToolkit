const test = require("node:test");
const assert = require("node:assert/strict");
const { controllerState, conditionPasses, previewAnimationIds } = require("../shared/animation-controller-runtime.cjs");

const controllers = { "controller.animation.mob": { initial_state: "default", states: {
  default: { animations: ["animation.idle"], transitions: [{ walk: "query.anim_time > 0.5" }, { done: "1" }] },
  walk: { animations: ["animation.walk"], transitions: [{ done: "query.anim_time > 2" }] },
  done: { animations: [] },
} } };
test("one ordered transition per frame; destination time resets and does not rewind with clip loops", () => {
  const first = controllerState(controllers, "controller.animation.mob", "default", 0.75);
  assert.deepEqual(first, { state: "walk", time: 0, animations: ["animation.walk"], transitionIndex: 0 });
  const second = controllerState(controllers, "controller.animation.mob", first.state, 1.5);
  assert.equal(second.state, "walk");
  assert.equal(second.time, 1.5);
  assert.deepEqual(controllerState(controllers, "controller.animation.mob", second.state, 2.1), { state: "done", time: 0, animations: [], transitionIndex: 0 });
  assert.equal(controllerState(controllers, "controller.animation.mob", "done", 10).state, "done");
});
test("unsupported queries and effects are not silently discarded; multi-animation ids are collected", () => {
  assert.throws(() => conditionPasses("query.is_moving", 0.75), /不支持/);
  assert.throws(() => conditionPasses("1 / 0", 0), /无效/);
  assert.deepEqual(previewAnimationIds(controllers, "controller.animation.mob"), ["animation.idle", "animation.walk"]);
  const multi = structuredClone(controllers); multi["controller.animation.mob"].states.default.animations.push({ "animation.other": 0.25 });
  assert.deepEqual(previewAnimationIds(multi, "controller.animation.mob"), ["animation.idle", "animation.other", "animation.walk"]);
  for (const change of [s => { s.on_entry = ["/say hi"]; }, s => { s.variables = { x: 1 }; }]) {
    const altered = structuredClone(controllers); change(altered["controller.animation.mob"].states.default);
    assert.throws(() => previewAnimationIds(altered, "controller.animation.mob"), /暂不/);
  }
  assert.throws(() => controllerState(controllers, "missing", "default", 0), /不存在/);
});
test("mutual always-true transitions advance once instead of spinning within a frame", () => {
  const pair = { c: { states: { a: { transitions: [{ b: "1" }] }, b: { transitions: [{ a: "1" }] } } } };
  assert.equal(controllerState(pair, "c", "a", 0).state, "b");
  assert.equal(controllerState(pair, "c", "b", 0).state, "a");
});
