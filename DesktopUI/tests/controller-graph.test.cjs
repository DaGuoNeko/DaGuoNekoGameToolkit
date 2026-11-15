const test = require("node:test"), assert = require("node:assert/strict");
const { controllerGraph } = require("../src/features/mods/model-controller-graph.cjs");
const { renameState, moveTransition, removeState } = require("../shared/animation-controller.cjs");

test("graph preserves ordered duplicate/self/cyclic transitions and selects the effective initial state without mutation", () => {
  const source = { states: {
    other: { animations: [], transitions: [{ default: 1 }] },
    default: { animations: ["animation.idle"], transitions: [{ other: "q.anim_time > 1" }, { default: "0" }, { other: "1" }] },
    isolated: { unknown: true },
  } }, before = structuredClone(source), graph = controllerGraph(source);
  assert.deepEqual(source, before);
  assert.deepEqual(graph.nodes.map(node => node.name), ["other", "default", "isolated"]);
  assert.deepEqual(graph.nodes.filter(node => node.initial).map(node => node.name), ["default"]);
  const outgoing = graph.edges.filter(edge => edge.from === "default");
  assert.deepEqual(outgoing.map(edge => [edge.index, edge.to, edge.condition]), [[0, "other", "q.anim_time > 1"], [1, "default", "0"], [2, "other", "1"]]);
  assert.equal(new Set(outgoing.map(edge => edge.path)).size, 3);
  assert.equal(controllerGraph({ initial_state: "other", states: source.states }).nodes[0].initial, true);
  assert.equal(controllerGraph({ states: { alone: {} } }).nodes[0].initial, true);
});

test("graph updates from renamed, reordered, removed and restored controller documents", () => {
  const id = "controller.animation.graph", source = { animation_controllers: { [id]: { states: {
    default: { transitions: [{ one: "1" }, { two: "0" }] }, one: {}, two: {},
  } } } };
  const renamed = renameState(source, id, "one", "walk");
  const moved = moveTransition(renamed, id, "default", 1, { two: "0" }, -1);
  const edges = controllerGraph(moved.animation_controllers[id]).edges;
  assert.deepEqual(edges.map(edge => [edge.to, edge.index]), [["two", 0], ["walk", 1]]);
  const removed = removeState(moved, id, "two");
  assert.deepEqual(controllerGraph(removed.animation_controllers[id]).edges.map(edge => edge.to), ["walk"]);
  assert.deepEqual(controllerGraph(source.animation_controllers[id]).edges.map(edge => edge.to), ["one", "two"]);
});

test("visual ordering preserves document order, implicit startup and transition priority", () => {
  const controller = { states: { idle: { transitions: [{ walk: "1" }, { end: "0" }] }, walk: {}, end: {} } }, before = structuredClone(controller);
  const graph = controllerGraph(controller, ["end", "walk", "idle"]);
  assert.deepEqual(graph.nodes.map(node => node.name), ["end", "walk", "idle"]);
  assert.equal(graph.nodes.find(node => node.initial).name, "idle");
  assert.deepEqual(graph.edges.filter(edge => edge.from === "idle").map(edge => [edge.to, edge.index]), [["walk", 0], ["end", 1]]);
  assert.deepEqual(controller, before);
  assert.deepEqual(controllerGraph(controller, ["gone", "walk", "walk"]).nodes.map(node => node.name), ["walk", "idle", "end"]);
  assert.equal(controllerGraph({ ...controller, initial_state: "end" }, ["walk", "idle", "end"]).nodes.find(node => node.initial).name, "end");
});

test("maximum graph stays in its scrollable bounds and every orthogonal edge avoids card interiors", () => {
  const names = Array.from({ length: 32 }, (_, index) => "state_" + index);
  const controller = { states: Object.fromEntries(names.map((name, i) => [name, {
    transitions: Array.from({ length: 8 }, (_, j) => ({ [names[(i + j * 5) % 32]]: "1" })),
  }])) };
  for (const order of [[], names.slice().reverse()]) {
    const graph = controllerGraph(controller, order);
    assert.equal(graph.nodes.length, 32); assert.equal(graph.edges.length, 256);
    for (const node of graph.nodes) {
      assert.ok(node.x >= 0 && node.x + graph.cardWidth <= graph.width);
      assert.ok(node.y >= 0 && node.y + graph.cardHeight <= graph.height);
    }
    for (const edge of graph.edges) {
      const commands = edge.path.match(/[MHV] [\d.]+(?: [\d.]+)?/g);
      let x = 0, y = 0;
      for (const command of commands) {
        const [kind, a, b] = command.split(" ");
        const nx = kind === "V" ? x : Number(a), ny = kind === "H" ? y : Number(b === undefined ? a : b);
        assert.ok(nx >= 0 && nx <= graph.width && ny >= 0 && ny <= graph.height);
        if (kind !== "M") for (const node of graph.nodes) {
          const horizontal = y === ny && y > node.y && y < node.y + graph.cardHeight && Math.max(x, nx) > node.x && Math.min(x, nx) < node.x + graph.cardWidth;
          const vertical = x === nx && x > node.x && x < node.x + graph.cardWidth && Math.max(y, ny) > node.y && Math.min(y, ny) < node.y + graph.cardHeight;
          assert.equal(horizontal || vertical, false, edge.from + " -> " + edge.to + " crosses " + node.name);
        }
        x = nx; y = ny;
      }
    }
  }
  assert.throws(() => controllerGraph({ states: { default: { transitions: [{ missing: "1" }] } } }), /目标状态不存在/);
});
