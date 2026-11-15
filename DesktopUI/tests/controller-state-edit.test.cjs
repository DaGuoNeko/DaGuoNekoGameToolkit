const test = require("node:test"), assert = require("node:assert/strict");
const { renameState, updateTransition, moveTransition, removeTransitionAt } = require("../shared/animation-controller.cjs");
const { controllerState } = require("../shared/animation-controller-runtime.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const id = "controller.animation.edit";
const fixture = () => ({ format_version: "1.10.0", extra: { keep: true }, animation_controllers: {
  [id]: { states: {
    before: { animations: [], transitions: [{ default: "q.anim_time > 0" }] },
    default: { animations: [{ "animation.idle": 0.5 }], transitions: [{ fast: "1" }, { slow: "1" }], blend_transition: { "0": 1, "0.5": 0.8, "1": 0 }, blend_via_shortest_path: true, unknown: { text: "default" } },
    fast: { animations: [], transitions: [{ default: "1" }] },
    slow: { animations: [], transitions: [{ default: 1 }, { fast: "0" }] },
  } },
  "controller.animation.other": { states: { default: { animations: [], unknown: "default" } } },
} });

test("rename updates incoming targets and effective initial state, preserves order/raw conditions/unknown fields", () => {
  const source = fixture(), before = structuredClone(source), next = renameState(source, id, "default", "idle");
  const c = next.animation_controllers[id];
  assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(c.states), ["before", "idle", "fast", "slow"]);
  assert.equal(c.initial_state, "idle");
  assert.deepEqual(c.states.before.transitions, [{ idle: "q.anim_time > 0" }]);
  assert.deepEqual(c.states.slow.transitions, [{ idle: 1 }, { fast: "0" }]);
  assert.deepEqual(c.states.idle, source.animation_controllers[id].states.default);
  assert.deepEqual(next.animation_controllers["controller.animation.other"], source.animation_controllers["controller.animation.other"]);
  assert.deepEqual(next.extra, source.extra);
  const project = exportProject({ identifier: "geometry.states", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [] }], controllers: next.animation_controllers });
  assert.deepEqual(importProject(project).controllers, next.animation_controllers);
});
test("rename preserves explicit and implicit non-default startup and refuses invalid changes atomically", () => {
  const source = fixture(); source.animation_controllers[id].initial_state = "fast";
  assert.equal(renameState(source, id, "default", "idle").animation_controllers[id].initial_state, "fast");
  assert.equal(renameState(source, id, "fast", "quick").animation_controllers[id].initial_state, "quick");
  assert.strictEqual(renameState(source, id, "default", " default "), source);
  const noDefault = fixture(); delete noDefault.animation_controllers[id].states.default;
  for (const state of Object.values(noDefault.animation_controllers[id].states)) delete state.transitions;
  assert.equal(renameState(noDefault, id, "fast", "0").animation_controllers[id].initial_state, "before");
  const before = structuredClone(source);
  for (const name of ["fast", "", "../bad", "__proto__", "constructor", "a".repeat(33)]) assert.throws(() => renameState(source, id, "default", name));
  assert.throws(() => renameState(source, id, "missing", "idle"), /不存在/);
  assert.deepEqual(source, before);
});
test("edit keeps index, reordering changes first-match execution, and unchanged edits keep original numeric condition", () => {
  const source = fixture(), rows = source.animation_controllers[id].states.default.transitions, before = structuredClone(source);
  assert.equal(controllerState(source.animation_controllers, id, "default", 0).state, "fast");
  const moved = moveTransition(source, id, "default", 1, rows[1], -1);
  assert.equal(controllerState(moved.animation_controllers, id, "default", 0).state, "slow");
  const changed = updateTransition(moved, id, "default", 0, { slow: "1" }, "before", " 0 ");
  assert.deepEqual(changed.animation_controllers[id].states.default.transitions, [{ before: "0" }, { fast: "1" }]);
  assert.equal(controllerState(changed.animation_controllers, id, "default", 0).state, "fast");
  const numeric = source.animation_controllers[id].states.slow.transitions[0];
  assert.strictEqual(updateTransition(source, id, "slow", 0, numeric, "default", "1"), source);
  assert.deepEqual(source, before);
});
test("duplicate imported targets are edited or removed one row at a time; stale expectations reject", () => {
  const source = fixture(); source.animation_controllers[id].states.default.transitions = [{ fast: "0" }, { fast: "1" }];
  const changed = updateTransition(source, id, "default", 0, { fast: "0" }, "fast", "q.anim_time > 1");
  assert.deepEqual(changed.animation_controllers[id].states.default.transitions, [{ fast: "q.anim_time > 1" }, { fast: "1" }]);
  const removed = removeTransitionAt(source, id, "default", 0, { fast: "0" });
  assert.deepEqual(removed.animation_controllers[id].states.default.transitions, [{ fast: "1" }]);
  assert.equal(removeTransitionAt(removed, id, "default", 0, { fast: "1" }).animation_controllers[id].states.default.transitions, undefined);
  assert.throws(() => moveTransition(changed, id, "default", 0, { fast: "0" }, 1), /已变化/);
  assert.throws(() => updateTransition(source, id, "default", 0, { fast: "0" }, "default", "1"), /自己/);
  for (const condition of ["", "x".repeat(257), "1\n2"]) assert.throws(() => updateTransition(source, id, "default", 0, { fast: "0" }, "fast", condition));
  assert.throws(() => moveTransition(source, id, "default", 0, { fast: "0" }, -1), /位置/);
  assert.throws(() => updateTransition(fixture(), id, "default", 0, { fast: "1" }, "slow", "0"), /已经有/);
  assert.throws(() => removeTransitionAt(source, id, "default", 3, { fast: "1" }), /位置/);
});
