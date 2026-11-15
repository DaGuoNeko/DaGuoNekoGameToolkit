const test = require("node:test"), assert = require("node:assert/strict");
const { connectionScroll } = require("../src/features/mods/model-controller-scroll.cjs");
const bounds = { left: 100, top: 200, right: 500, bottom: 500 };

test("edge scrolling has independent directions, scales with time and stops outside the visible canvas", () => {
  assert.deepEqual(connectionScroll({ x: 300, y: 350 }, bounds, 20), { x: 0, y: 0 });
  assert.deepEqual(connectionScroll({ x: 100, y: 200 }, bounds, 20), { x: -9.6, y: -9.6 });
  assert.deepEqual(connectionScroll({ x: 500, y: 500 }, bounds, 20), { x: 9.6, y: 9.6 });
  for (const pointer of [{ x: 99, y: 350 }, { x: 501, y: 350 }, { x: 300, y: 199 }, { x: 300, y: 501 }]) assert.deepEqual(connectionScroll(pointer, bounds, 20), { x: 0, y: 0 });
  const slow = connectionScroll({ x: 484, y: 350 }, bounds, 20), fast = connectionScroll({ x: 492, y: 350 }, bounds, 20);
  assert.equal(slow.x, 4.8); assert.equal(slow.y, 0); assert.ok(fast.x > slow.x);
  assert.equal(connectionScroll({ x: 484, y: 350 }, bounds, 10).x * 2, slow.x);
});

test("small clipped canvases retain a neutral center and delayed frames cannot cause a large jump", () => {
  const narrow = { left: 0, right: 40, top: 0, bottom: 20 };
  assert.deepEqual(connectionScroll({ x: 20, y: 10 }, narrow, 16), { x: 0, y: 0 });
  assert.deepEqual(connectionScroll({ x: 40, y: 20 }, narrow, 10000), { x: 24, y: 24 });
  assert.deepEqual(connectionScroll({ x: 500, y: 500 }, bounds, -100), { x: 0, y: 0 });
  assert.deepEqual(connectionScroll({ x: 0, y: 0 }, { left: 0, top: 0, right: 0, bottom: 100 }, 20), { x: 0, y: 0 });
});
