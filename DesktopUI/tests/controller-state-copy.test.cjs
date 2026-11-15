const test = require("node:test"), assert = require("node:assert/strict");
const { addState, duplicateState } = require("../shared/animation-controller.cjs");
const { controllerGraph } = require("../src/features/mods/model-controller-graph.cjs");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const id = "controller.animation.copy";
const initial = doc => controllerGraph(doc.animation_controllers[id]).nodes.find(node => node.initial).name;

test("adding a default or numeric state preserves implicit startup instead of changing the running entry", () => {
  const source = { animation_controllers: { [id]: { states: { idle: { animations: [] }, walk: {} } } } };
  const before = structuredClone(source);
  for (const name of ["default", "0", "new_state"]) {
    const next = addState(source, id, name);
    assert.equal(initial(next), "idle");
    assert.deepEqual(next.animation_controllers[id].states[name], { animations: [] });
  }
  assert.deepEqual(source, before);
});

test("state copy is independent, keeps raw fields and ordered edges, and remaps only its own self transitions", () => {
  const source = { keep: true, animation_controllers: { [id]: { states: {
    idle: {
      animations: [{ "animation.idle": "q.anim_time / 10" }],
      transitions: [{ idle: 0 }, { walk: "1" }, { idle: "q.anim_time > 2" }],
      blend_transition: { "0": 1, "0.5": 0.8, "1": 0 }, blend_via_shortest_path: true,
      on_entry: ["variable.name = 'idle';"], on_exit: ["event.idle"], unknown: { names: ["idle"] },
    }, walk: { transitions: [{ idle: 1 }] },
  } }, "controller.animation.other": { states: { default: { animations: [] } } } } };
  const before = structuredClone(source), next = duplicateState(source, id, "idle", " rest ");
  const copy = next.animation_controllers[id].states.rest;
  assert.equal(initial(next), "idle");
  assert.deepEqual(copy.transitions, [{ rest: 0 }, { walk: "1" }, { rest: "q.anim_time > 2" }]);
  assert.deepEqual({ ...copy, transitions: before.animation_controllers[id].states.idle.transitions }, before.animation_controllers[id].states.idle);
  assert.deepEqual(next.animation_controllers[id].states.walk, before.animation_controllers[id].states.walk);
  assert.deepEqual(next.animation_controllers["controller.animation.other"], before.animation_controllers["controller.animation.other"]);
  assert.equal(next.keep, true);
  const project = exportProject({ identifier: "geometry.copy", textureWidth: 16, textureHeight: 16, bones: [{ name: "body", cubes: [] }], controllers: next.animation_controllers });
  assert.deepEqual(importProject(project).controllers, next.animation_controllers);
  copy.unknown.names.push("changed"); copy.animations[0]["animation.idle"] = 0;
  assert.deepEqual(next.animation_controllers[id].states.idle, before.animation_controllers[id].states.idle);
  assert.deepEqual(source, before);
});

test("state copy preserves explicit and implicit startup and rejects collisions, missing sources and invalid names atomically", () => {
  const source = { animation_controllers: { [id]: { states: { idle: {}, walk: {} } } } };
  assert.equal(initial(duplicateState(source, id, "walk", "default")), "idle");
  assert.equal(initial(duplicateState(source, id, "walk", "0")), "idle");
  source.animation_controllers[id].initial_state = "walk";
  assert.equal(initial(duplicateState(source, id, "idle", "rest")), "walk");
  const before = structuredClone(source);
  for (const name of ["idle", "walk", "", "bad name", "../bad", "__proto__", "constructor", "a".repeat(33)]) assert.throws(() => duplicateState(source, id, "idle", name));
  assert.throws(() => duplicateState(source, id, "missing", "rest"), /不存在/);
  assert.throws(() => duplicateState(source, id, "missing", "missing"), /不存在/);
  assert.deepEqual(source, before);
});

test("state add and copy enforce the 32-state limit before returning a new document", () => {
  const source = { animation_controllers: { [id]: { states: Object.fromEntries(Array.from({ length: 31 }, (_, i) => ["state_" + i, {}])) } } };
  const next = duplicateState(source, id, "state_0", "last"), before = structuredClone(next);
  assert.equal(Object.keys(next.animation_controllers[id].states).length, 32);
  assert.throws(() => duplicateState(next, id, "state_0", "overflow"), /32/);
  assert.throws(() => addState(next, id, "overflow"), /32/);
  assert.deepEqual(next, before);
  assert.equal(Object.keys(source.animation_controllers[id].states).length, 31);
});
