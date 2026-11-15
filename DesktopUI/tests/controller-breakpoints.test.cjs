const test = require("node:test"), assert = require("node:assert/strict");
const { advanceControllerSession, enteredTransition, enteredBreakpoint } = require("../shared/animation-controller-runtime.cjs");
const id = "controller.animation.breakpoints";

test("breakpoints react to an actual entry, not a state that remains active or a nonmatching target", () => {
  const map = { [id]: { states: { a: { transitions: [{ b: "q.anim_time >= 0.5" }] }, b: {} } } };
  const initial = { state: "a", time: 0 }, waiting = advanceControllerSession(map, id, initial, 0.2);
  assert.equal(enteredBreakpoint(initial, waiting, ["a", "b"]), "");
  assert.equal(enteredTransition(initial, waiting), null);
  const next = advanceControllerSession(map, id, waiting, 0.3);
  assert.deepEqual(enteredTransition(waiting, next), { from: "a", to: "b", index: 0, condition: "q.anim_time >= 0.5", stateTime: 0.5, elapsed: 0.5 });
  assert.equal(enteredBreakpoint(waiting, next, ["b"]), "b");
  assert.equal(enteredBreakpoint(waiting, next, ["a"]), "");
  assert.equal(enteredBreakpoint(waiting, next, []), "");
  const resumed = advanceControllerSession(map, id, next, 0);
  assert.equal(enteredBreakpoint(next, resumed, ["b"]), "");
  assert.equal(enteredTransition(next, resumed), null);
});

test("self entries at zero time hit again while inspection without a new entry does not", () => {
  const map = { [id]: { states: { a: { transitions: [{ a: 1 }] } } } };
  const start = { state: "a", time: 0 }, first = advanceControllerSession(map, id, start, 0);
  const before = structuredClone(first), points = ["a"];
  assert.equal(enteredBreakpoint(start, first, points), "a");
  assert.equal(enteredBreakpoint(first, first, points), "");
  const second = advanceControllerSession(map, id, first, 0);
  assert.deepEqual(enteredTransition(first, second), { from: "a", to: "a", index: 0, condition: 1, stateTime: 0, elapsed: 0 });
  assert.equal(enteredBreakpoint(first, second, points), "a");
  assert.deepEqual(first, before); assert.deepEqual(points, ["a"]);
});

test("entry detection still works after the 50-record trace reaches its cap", () => {
  const map = { [id]: { states: { a: { transitions: [{ b: 1 }] }, b: { transitions: [{ a: 1 }] } } } };
  let session = { state: "a", time: 0 };
  for (let i = 0; i < 60; i++) session = advanceControllerSession(map, id, session, 0.05);
  const next = advanceControllerSession(map, id, session, 0.05);
  assert.equal(session.trace.length, 50); assert.equal(next.trace.length, 50);
  assert.equal(enteredBreakpoint(session, next, ["b"]), "b");
  assert.equal(enteredTransition(session, next).to, "b");
});
