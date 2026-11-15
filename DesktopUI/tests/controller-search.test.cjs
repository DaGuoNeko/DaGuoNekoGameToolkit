const test = require("node:test"), assert = require("node:assert/strict");
const { controllerGraph, searchControllerGraph } = require("../src/features/mods/model-controller-graph.cjs");

test("graph search reports every matched field once, preserves visual order and never changes graph data", () => {
  const graph = controllerGraph({ states: {
    idle: { animations: ["animation.walk", { "animation.walk_extra": 0.5 }], transitions: [{ walk: "q.is_moving" }, { walk: "q.ground_speed > 1" }] },
    walk: { animations: ["animation.run"] }, done: {},
  } }, ["walk", "done", "idle"]), before = structuredClone(graph);
  assert.deepEqual(searchControllerGraph(graph, " WALK "), [
    { name: "walk", reasons: ["名称"] }, { name: "idle", reasons: ["动画引用", "转移目标"] },
  ]);
  assert.deepEqual(searchControllerGraph(graph, "q.ground_speed"), [{ name: "idle", reasons: ["转移条件"] }]);
  assert.deepEqual(searchControllerGraph(graph, "animation.run"), [{ name: "walk", reasons: ["动画引用"] }]);
  assert.deepEqual(graph, before);
});

test("search is literal, handles zero conditions and reflects edited or deleted references", () => {
  const controller = { states: { first: { transitions: [{ last: "query.value[0] .*" }, { last: 0 }] }, last: {} } };
  assert.deepEqual(searchControllerGraph(controllerGraph(controller), "[0] .*"), [{ name: "first", reasons: ["转移条件"] }]);
  assert.deepEqual(searchControllerGraph(controllerGraph(controller), "^last$"), []);
  assert.deepEqual(searchControllerGraph(controllerGraph(controller), "0").map(item => item.name), ["first"]);
  for (const query of ["", "   ", "missing"]) assert.deepEqual(searchControllerGraph(controllerGraph(controller), query), []);
  controller.states.first.transitions = [{ finish: "1" }]; controller.states.finish = controller.states.last; delete controller.states.last;
  assert.deepEqual(searchControllerGraph(controllerGraph(controller), "last"), []);
  assert.deepEqual(searchControllerGraph(controllerGraph(controller), "finish"), [
    { name: "first", reasons: ["转移目标"] }, { name: "finish", reasons: ["名称"] },
  ]);
});
