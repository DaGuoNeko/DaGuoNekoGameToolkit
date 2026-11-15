const test = require("node:test"), assert = require("node:assert/strict");
const { advanceControllerSession } = require("../shared/animation-controller-runtime.cjs");
const id = "controller.animation.trace";

test("a self transition at zero time starts its fade and records exactly one actual trigger", () => {
  const map = { [id]: { states: { idle: { blend_transition: 1, transitions: [{ idle: 1 }] } } } };
  const original = { state: "idle", time: 0 };
  const next = advanceControllerSession(map, id, original, 0);
  assert.deepEqual(next.transition, { state: "idle", time: 0, duration: 1 });
  assert.deepEqual(next.trace, [{ from: "idle", to: "idle", index: 0, condition: 1, stateTime: 0, elapsed: 0 }]);
  assert.deepEqual(original, { state: "idle", time: 0 });
});

test("trace identifies the first matching row including duplicate targets and keeps accumulated and state clocks distinct", () => {
  const map = { [id]: { states: {
    idle: { transitions: [{ walk: "q.anim_time > 9" }, { walk: "q.anim_time >= 0.2" }, { done: "1" }] },
    walk: { transitions: [{ done: "q.anim_time >= 0.5" }] }, done: {},
  } } };
  const first = advanceControllerSession(map, id, { state: "idle", time: 0 }, 0.2);
  assert.deepEqual(first.trace, [{ from: "idle", to: "walk", index: 1, condition: "q.anim_time >= 0.2", stateTime: 0.2, elapsed: 0.2 }]);
  const waiting = advanceControllerSession(map, id, first, 0.25);
  assert.equal(waiting.trace, first.trace); assert.equal(waiting.state, "walk");
  const last = advanceControllerSession(map, id, waiting, 0.25);
  assert.deepEqual(last.trace[1], { from: "walk", to: "done", index: 0, condition: "q.anim_time >= 0.5", stateTime: 0.5, elapsed: 0.7 });
  assert.equal(last.time, 0); assert.equal(first.trace.length, 1);
});

test("cyclic playback keeps only the last 50 immutable records, and no-match advances never append", () => {
  const map = { [id]: { states: { a: { transitions: [{ b: "1" }] }, b: { transitions: [{ a: "1" }] } } } };
  let session = { state: "a", time: 0 };
  for (let i = 0; i < 80; i++) session = advanceControllerSession(map, id, session, 0.1);
  assert.equal(session.trace.length, 50); assert.ok(Math.abs(session.trace[0].elapsed - 3.1) < 1e-10);
  assert.ok(Math.abs(session.trace[49].elapsed - 8) < 1e-10);
  assert.deepEqual(session.trace.slice(0, 2).map(item => [item.from, item.to]), [["a", "b"], ["b", "a"]]);
  const quiet = { [id]: { states: { a: {} } } };
  const next = advanceControllerSession(quiet, id, session, 0.1);
  assert.equal(next.trace, session.trace); assert.equal(next.trace.length, 50);
});

test("completion and simulated queries use the actual evaluated context; errors leave session and trace untouched", () => {
  const map = { [id]: { states: {
    a: { animations: ["animation.a"], transitions: [{ b: "q.is_moving && q.all_animations_finished" }] }, b: {},
  } } };
  const start = { state: "a", time: 0, clips: { "animation.a": { length: 0.5 } } };
  const before = structuredClone(start);
  assert.equal(advanceControllerSession(map, id, start, 0.5, { "query.is_moving": 0 }).trace.length, 0);
  const next = advanceControllerSession(map, id, start, 0.5, { "query.is_moving": 1 });
  assert.equal(next.trace[0].to, "b"); assert.equal(next.trace[0].condition, "q.is_moving && q.all_animations_finished");
  assert.throws(() => advanceControllerSession(map, id, start, 0.5), /不支持/);
  for (const elapsed of [-1, Infinity, NaN]) assert.throws(() => advanceControllerSession(map, id, start, elapsed), /时间/);
  assert.throws(() => advanceControllerSession(map, id, { ...start, elapsed: Infinity }, 0), /时间/);
  assert.deepEqual(start, before);
});
