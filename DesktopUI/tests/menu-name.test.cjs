const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const { EventEmitter } = require("node:events");
const { MenuName, menuPlayerName } = require("../electron/menu-name.cjs");
function fixture() {
  const events = new EventEmitter();
  let sessions = [];
  return {
    bridge: {
      server: {
        onDidChange(fn) {
          events.on("state", fn);
          return { dispose: () => events.off("state", fn) };
        },
      },
      snapshot: () => ({ sessions }),
    },
    events,
    update(value) {
      sessions = value;
      events.emit("state");
    },
    worker: {
      session: { running: true, pid: 123, bridgeRegistrationId: "owned" },
      sourceSnapshot: {
        config: { game_executable_path: path.resolve("Game.exe") },
      },
    },
    session: {
      registrationId: "owned",
      connected: true,
      mcdkPid: 123,
      minecraftPid: 456,
      projectRoot: path.resolve("run"),
    },
  };
}
test("menu names preserve single-letter and Unicode names and reject empty/control/oversized values", () => {
  assert.equal(menuPlayerName(" a "), "a");
  assert.equal(menuPlayerName("测试 玩家"), "测试 玩家");
  for (const s of ["", null, "a\n", "a\0b", "x".repeat(33)])
    assert.throws(() => menuPlayerName(s));
});
test("menu identity waits for the registered process and passes the exact name, PID, owner, and executable", async () => {
  const f = fixture(),
    calls = [];
  const service = new MenuName("runtime", {
    request: async (...args) => calls.push(args),
    timeoutMs: 1000,
  });
  const pending = service.apply(
    f.bridge,
    f.worker,
    "测试 a",
    path.resolve("run"),
  );
  assert.equal(calls.length, 0);
  f.update([f.session]);
  assert.deepEqual(await pending, { name: "测试 a", pid: 456 });
  assert.deepEqual(calls[0][1], [
    "456",
    "123",
    path.resolve("Game.exe"),
    path.join("runtime", "native/menu-name.dll"),
    "测试 a",
  ]);
  assert.equal(f.events.listenerCount("state"), 0);
});
test("identity refuses mismatched ownership/root and never invokes native code for them", async () => {
  for (const change of [
    { mcdkPid: 999 },
    { projectRoot: path.resolve("other") },
    { projectRoot: null },
    { state: "exited" },
  ]) {
    const f = fixture();
    let called = false;
    const service = new MenuName("runtime", {
      request: async () => {
        called = true;
      },
    });
    const pending = service.apply(f.bridge, f.worker, "a", path.resolve("run"));
    f.update([{ ...f.session, ...change }]);
    await assert.rejects(pending);
    assert.equal(called, false);
    assert.equal(f.events.listenerCount("state"), 0);
  }
});
test("missing bridge, timeout, native failure and game exit are surfaced without leaving subscriptions", async () => {
  const f = fixture();
  const service = new MenuName("runtime", {
    request: async () => {
      throw Error("unsupported layout");
    },
    timeoutMs: 10,
  });
  await assert.rejects(
    service.apply(null, f.worker, "a", path.resolve("run")),
    /会话连接/,
  );
  await assert.rejects(
    service.apply(f.bridge, f.worker, "a", path.resolve("run")),
    /未收到/,
  );
  assert.equal(f.events.listenerCount("state"), 0);
  f.update([f.session]);
  await assert.rejects(
    service.apply(f.bridge, f.worker, "a", path.resolve("run")),
    /unsupported layout/,
  );
  assert.equal(f.events.listenerCount("state"), 0);
  f.worker.session.running = false;
  await assert.rejects(
    service.apply(f.bridge, f.worker, "a", path.resolve("run")),
    /已退出/,
  );
});
