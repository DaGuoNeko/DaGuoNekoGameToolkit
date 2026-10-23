const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { TracyWindow } = require("../electron/tracy-window.cjs");
function fixture() {
  const native = Object.create(TracyWindow.prototype),
    moves = [],
    shows = [];
  let x = 100,
    visible = true,
    valid = true;
  Object.assign(native, {
    hwnd: 1,
    host: 2,
    shown: false,
    frameDirty: true,
    owned: () => valid,
    screen: {
      getDisplayMatching: () => ({ scaleFactor: 1.5 }),
      dipToScreenPoint: (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }),
    },
    position: (...args) => {
      moves.push(args);
      return 1;
    },
    showAsync: (...args) => {
      shows.push(args);
      return 1;
    },
    show: () => {
      throw Error("synchronous ShowWindow blocks Tracy dragging");
    },
    dpiContext: () => -4,
  });
  const host = {
    isVisible: () => visible,
    isMinimized: () => false,
    getContentSize: () => [1000, 800],
    webContents: { getZoomFactor: () => 1 },
    getBounds: () => ({}),
    getContentBounds: () => ({ x, y: 50 }),
  };
  return {
    native,
    moves,
    shows,
    host,
    move: (value) => {
      x = value;
    },
    hide: () => {
      visible = false;
    },
    invalidate: () => {
      valid = false;
    },
  };
}
test("Tracy drag never synchronously shows/resizes/reframes unchanged content and skips duplicate positions", () => {
  const { native, host, moves, shows, move } = fixture(),
    rect = { x: 10, y: 20, width: 600, height: 400 };
  native.bounds(rect, host);
  assert.deepEqual(moves[0].slice(2, 6), [165, 105, 900, 600]);
  assert(moves[0][6] & 0x20);
  for (let i = 0; i < 100; i++) native.bounds(rect, host);
  assert.equal(moves.length, 1);
  move(120);
  native.bounds(rect, host);
  const flags = moves[1][6];
  assert(flags & 0x4000);
  assert(flags & 0x1);
  assert(flags & 0x4);
  assert.equal(flags & 0x20, 0);
  assert.equal(flags & 0x40, 0);
  assert.equal(shows.length, 0);
  native.bounds({ ...rect, width: 700 }, host);
  assert.equal(moves[2][6] & 0x1, 0);
  assert.equal(moves[2][6] & 0x20, 0);
});
test("hidden/restored or stale Tracy windows cannot replay visibility or geometry calls", () => {
  const { native, host, moves, shows, invalidate } = fixture(),
    rect = { x: 0, y: 0, width: 600, height: 400 };
  native.bounds(rect, host);
  native.bounds(null, host);
  native.bounds(null, host);
  assert.deepEqual(shows, [[1, 0]]);
  native.bounds(rect, host);
  assert(moves[1][6] & 0x40);
  assert.equal(moves[1][6] & 0x20, 0);
  invalidate();
  native.bounds(null, host);
  native.bounds({ ...rect, width: 800 }, host);
  assert.equal(moves.length, 2);
  assert.equal(shows.length, 1);
});
