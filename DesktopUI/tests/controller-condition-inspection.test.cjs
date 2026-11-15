const test = require("node:test"), assert = require("node:assert/strict");
const { inspectControllerTransitions, controllerState, advanceControllerSession } = require("../shared/animation-controller-runtime.cjs");
const id = "controller.animation.inspect";

test("condition inspection follows real priority, retains numeric results and never evaluates rows after the first match", () => {
  const map = { [id]: { states: { a: { transitions: [{ b: 0 }, { b: -2 }, { c: "query.unsupported" }] }, b: {}, c: {} } } };
  const session = { state: "a", time: 1.25, elapsed: 5, trace: [{ keep: true }] }, before = structuredClone({ map, session });
  const inspected = inspectControllerTransitions(map, id, session);
  assert.deepEqual(inspected, { state: "a", time: 1.25, rows: [
    { index: 0, target: "b", condition: 0, status: "false", value: 0 },
    { index: 1, target: "b", condition: -2, status: "match", value: -2 },
    { index: 2, target: "c", condition: "query.unsupported", status: "skipped", after: 1, reason: "match" },
  ] });
  assert.equal(controllerState(map, id, "a", 1.25).transitionIndex, 1);
  assert.equal(advanceControllerSession(map, id, session, 0).trace.at(-1).index, 1);
  assert.deepEqual({ map, session }, before);
});

test("an error blocks later transitions just as in playback, while empty and false-only states stay distinguishable", () => {
  const map = { [id]: { states: {
    error: { transitions: [{ done: "0" }, { done: "1 / 0" }, { done: "1" }] },
    quiet: { transitions: [{ done: 0 }, { done: "q.anim_time > 9" }] }, done: {},
  } } };
  const inspected = inspectControllerTransitions(map, id, { state: "error", time: 0 });
  assert.deepEqual(inspected.rows.map(row => row.status), ["false", "error", "skipped"]);
  assert.match(inspected.rows[1].error, /运算结果无效/);
  assert.deepEqual(inspected.rows[2], { index: 2, target: "done", condition: "1", status: "skipped", after: 1, reason: "error" });
  assert.throws(() => controllerState(map, id, "error", 0), /运算结果无效/);
  assert.deepEqual(inspectControllerTransitions(map, id, { state: "quiet", time: 0 }).rows.map(row => row.status), ["false", "false"]);
  assert.deepEqual(inspectControllerTransitions(map, id, { state: "done", time: 0 }).rows, []);
});

test("inspection uses the current state clock, completion and simulated values without advancing to the next tick", () => {
  const map = { [id]: { states: {
    a: { animations: ["animation.a"], transitions: [{ b: "q.is_moving && q.all_animations_finished" }] }, b: {},
    exact: { transitions: [{ b: "q.anim_time == 0" }] },
  } } };
  const session = { state: "a", time: 0.5, clips: { "animation.a": { length: 0.5 } } };
  assert.equal(inspectControllerTransitions(map, id, session).rows[0].status, "error");
  assert.equal(inspectControllerTransitions(map, id, session, { "query.is_moving": 0 }).rows[0].status, "false");
  assert.equal(inspectControllerTransitions(map, id, session, { "query.is_moving": 1 }).rows[0].status, "match");
  assert.equal(inspectControllerTransitions(map, id, { ...session, time: 0.49 }, { "query.is_moving": 1 }).rows[0].status, "false");
  assert.equal(inspectControllerTransitions(map, id, { state: "exact", time: 0 }).rows[0].status, "match");
  assert.equal(advanceControllerSession(map, id, { state: "exact", time: 0 }, 0.05).state, "exact");
  for (const time of [-1, NaN, Infinity]) assert.throws(() => inspectControllerTransitions(map, id, { state: "a", time }), /时间无效/);
  assert.throws(() => inspectControllerTransitions(map, id, { state: "missing", time: 0 }), /不存在/);
  assert.throws(() => inspectControllerTransitions(map, id, { ...session, clips: {} }), /未加载/);
});
