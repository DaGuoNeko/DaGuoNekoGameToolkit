const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events");
const {
  TracyProfiler,
  assertPortFree,
  parseConnections,
} = require("../electron/tracy-profiler.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-tracy-")),
    exe = path.join(root, "tracy-profiler.exe");
  await fs.writeFile(exe, "fixture");
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-tracy-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const host = new EventEmitter();
  host.isDestroyed = () => false;
  host.isVisible = () => true;
  host.isMinimized = () => false;
  const calls = [],
    native = {
      find: (pid) => pid + 1000,
      attach(h, p) {
        this.hwnd = h;
        this.host = host;
        calls.push(["attach", p]);
      },
      detach() {
        this.host = null;
        calls.push(["detach"]);
      },
      bounds(r) {
        calls.push(["bounds", r]);
      },
      requestClose() {
        calls.push(["close"]);
      },
    };
  const children = [],
    rows = [{ pid: 22, localPort: 8087, remotePort: 0, state: "LISTENING" }];
  const debug = {
    profiles: new Map(),
    session(id, generation) {
      assert.equal(id, "selected");
      if (generation !== 2) throw Error("stale");
      return { id, minecraftPid: 22 };
    },
    discoverPorts: async () => [
      { pid: 11, port: 8086 },
      { pid: 22, port: 8087 },
    ],
  };
  const service = new TracyProfiler(root, root, debug, {
    discover: async () => [exe],
    connections: async () => rows,
    createWindow: () => native,
    spawn(file, args, opts) {
      calls.push(["spawn", file, args, opts]);
      const child = new EventEmitter();
      child.pid = 55;
      child.unref = () => {};
      children.push(child);
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
  });
  t.after(() => service.dispose());
  return { root, exe, host, calls, native, service, children, debug, rows };
}
test("Tracy selects exact game port, embeds own process, validates generation, preserves capture when detached/exiting", async (t) => {
  const { service, host, calls, children, native } = await fixture(t);
  const s = await service.start({ sessionId: "selected", generation: 2 }, host);
  assert.deepEqual(calls[0][2], ["-a", "127.0.0.1", "-p", "8087"]);
  assert.equal(calls[0][3].shell, false);
  assert.equal(s.target.gamePid, 22);
  assert.equal(s.pid, 55);
  service.bounds({ generation: 0, rect: {} });
  assert.equal(calls.at(-1)[0], "attach");
  await assert.rejects(
    service.mode({ generation: 0, mode: "external" }, host),
    /变化/,
  );
  await service.mode({ generation: s.generation, mode: "external" }, host);
  assert.equal(native.host, null);
  await service.mode({ generation: s.generation, mode: "embedded" }, host);
  assert.equal(native.host, host);
  await assert.rejects(service.start({}, host), /已有/);
  await assert.rejects(service.close({ generation: s.generation }), /保存/);
  await service.dispose();
  assert.equal(host.listenerCount("move"), 0);
  assert(!calls.some((c) => c[0] === "close"));
  children[0].emit("exit", 0);
});
test("Tracy movement bursts use latest bounds once and cannot replay after detach or shutdown", async (t) => {
  const { service, host, calls } = await fixture(t);
  const s = await service.start({}, host);
  for (let i = 0; i < 200; i++) {
    service.bounds({
      generation: s.generation,
      rect: { x: i, y: 0, width: 400, height: 300 },
    });
    host.emit("move");
  }
  await new Promise((r) => setTimeout(r, 35));
  const updates = calls.filter((c) => c[0] === "bounds");
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1].x, 199);
  host.emit("move");
  await service.mode({ generation: s.generation, mode: "external" }, host);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(calls.filter((c) => c[0] === "bounds").length, 1);
  await service.mode({ generation: s.generation, mode: "embedded" }, host);
  host.emit("move");
  service.prepareExit();
  const count = calls.length;
  service.bounds({ generation: s.generation, rect: null });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(calls.length, count);
});

test("Tracy rejects a busy game, active native capture, stale session and missing listener before spawning", async (t) => {
  const { service, host, rows, calls, debug } = await fixture(t);
  rows.push({
    pid: 22,
    localPort: 8087,
    remotePort: 50000,
    state: "ESTABLISHED",
  });
  await assert.rejects(
    service.start({ sessionId: "selected", generation: 2 }, host),
    /已有 Tracy/,
  );
  rows.pop();
  debug.profiles.set("p", {
    kind: "native",
    sessionId: "selected",
    status: "starting",
  });
  await assert.rejects(
    service.start({ sessionId: "selected", generation: 2 }, host),
    /Native/,
  );
  debug.profiles.clear();
  await assert.rejects(
    service.start({ sessionId: "selected", generation: 1 }, host),
    /stale/,
  );
  rows.length = 0;
  await assert.rejects(
    service.start({ sessionId: "selected", generation: 2 }, host),
    /消失/,
  );
  assert.equal(calls.length, 0);
});
test("offline trace selection remains a literal argv path; close only signals the owned profiler", async (t) => {
  const { service, host, root, calls, children } = await fixture(t);
  const file = path.join(root, "历史 分析.tracy");
  await fs.writeFile(file, "fixture");
  const s = await service.start({ traceFile: file }, host);
  assert.deepEqual(calls[0][2], [file]);
  await service.close({ generation: s.generation, confirmed: true });
  assert.deepEqual(calls.slice(-2), [["detach"], ["close"]]);
  assert.equal(service.snapshot().pid, 55);
  children[0].emit("exit", 0);
  assert.equal(service.snapshot().phase, "stopped");
});
test("netstat occupancy parsing checks server PID instead of unrelated same-number remote ports", async () => {
  const rows = parseConnections(
    "TCP [::]:8087 [::]:0 LISTENING 22\nTCP 127.0.0.1:8086 127.0.0.1:50000 ESTABLISHED 11\nTCP 127.0.0.1:50123 127.0.0.1:8087 ESTABLISHED 33",
  );
  await assertPortFree(22, 8087, async () => rows);
  await assert.rejects(
    assertPortFree(99, 8087, async () => rows),
    /消失/,
  );
});
