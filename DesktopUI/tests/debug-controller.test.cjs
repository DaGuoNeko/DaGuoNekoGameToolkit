const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events");
const { WorkspaceStore } = require("../electron/services.cjs");
const { DebugController } = require("../electron/debug/controller.cjs");

class Server extends EventEmitter {
  constructor() {
    super();
    this.summary = {
      id: "session",
      registrationId: "registered",
      connected: true,
      state: "game_ready",
      gameIpcConnected: true,
      debugCapabilityEnabled: true,
      connectionGeneration: 1,
      minecraftPid: 123,
    };
    this.calls = [];
    this.inflight = 0;
    this.maximum = 0;
  }
  onDidChange(fn) {
    this.on("state", fn);
    return { dispose: () => this.off("state", fn) };
  }
  getSnapshot() {
    return { status: "listening", sessions: [{ ...this.summary }] };
  }
  async start() {
    return 12345;
  }
  registerLaunch() {
    return {
      registrationId: "registered",
      environment: { MCDEV_HOST_TOKEN: "secret" },
    };
  }
  releaseRegistration() {
    this.summary.connected = false;
    this.emit("state");
  }
  async refreshSessions() {}
  async dispose() {}
  async request(id, method, params) {
    if (method === "game/reload") {
      this.calls.push({ method, params });
      return { accepted: true, addons: params.addons };
    }
    this.calls.push(params.code);
    this.maximum = Math.max(this.maximum, ++this.inflight);
    await new Promise((r) => setTimeout(r, 3));
    this.inflight--;
    const code = params.code;
    if (code.includes("compare_to("))
      return {
        ok: true,
        elapsed: 1,
        depth: 8,
        sizeDiff: 16,
        countDiff: 1,
        size: 32,
        count: 2,
        total: 0,
        rows: [],
      };
    if (code.includes("_edges=[]"))
      return {
        ok: true,
        clock: "CPU",
        elapsed: 1,
        total: 0,
        nodes: [],
        edges: [],
      };
    if (code.includes("yappi.start(") || code.includes("tracemalloc.start("))
      return { ok: true };
    if (code.includes("UnListenForEngineClient")) return false;
    if (code.includes("ListenForEngineClient")) return true;
    return 2;
  }
}

test("queued code revalidates its caller guard before dispatch", async (t) => {
  const { controller, server } = await setup(t);
  let release,
    valid = true;
  controller.queues.set(
    "session",
    new Promise((r) => {
      release = r;
    }),
  );
  const job = controller.code("session", 1, "_result=1", true, () => {
    if (!valid) throw Error("world changed");
  });
  valid = false;
  release();
  await assert.rejects(job, /world changed/);
  assert.equal(server.calls.length, 0);
});

test("reload operations target owned current sessions, require confirmation and never replay on disconnect", async (t) => {
  const { controller, server } = await setup(t, {
    scriptReloader: {
      forget() {},
      reload: async (session, root, request) =>
        request(
          "from common.utils import xupdate\n_result = xupdate.update('demo.changed')",
        ),
    },
  });
  const args = { sessionId: "session", generation: 1 };
  await controller.reload({ ...args, action: "scripts" });
  assert.match(server.calls[0], /xupdate.update/);
  await assert.rejects(controller.reload({ ...args, action: "world" }), /确认/);
  await controller.reload({ ...args, action: "world", confirmed: true });
  assert.deepEqual(server.calls[1], {
    method: "game/reload",
    params: { addons: false },
  });
  await controller.reload({ ...args, action: "addons", confirmed: true });
  assert.equal(server.calls[2].params.addons, true);
  await assert.rejects(
    controller.reload({
      ...args,
      generation: 2,
      action: "world",
      confirmed: true,
    }),
    /已更新/,
  );
  controller.profiles.set("busy", { sessionId: "session", status: "running" });
  await assert.rejects(
    controller.reload({ ...args, action: "scripts" }),
    /采样/,
  );
  controller.profiles.delete("busy");
  controller.pickers.set("session", 1);
  await assert.rejects(
    controller.reload({ ...args, action: "world", confirmed: true }),
    /拾取/,
  );
  controller.pickers.delete("session");
  const count = server.calls.length;
  server.request = async () => {
    server.calls.push("disconnect");
    throw Error("connection lost");
  };
  await assert.rejects(
    controller.reload({ ...args, action: "world", confirmed: true }),
    /connection lost/,
  );
  assert.equal(server.calls.length, count + 1);
});
test("source mismatch preflight blocks every reload before native dispatch", async (t) => {
  const { controller, server } = await setup(t);
  controller.beforeReload = async () => {
    throw Error("模组来源已变化");
  };
  const count = server.calls.length;
  for (const action of ["scripts", "world", "addons"])
    await assert.rejects(
      controller.reload({
        sessionId: "session",
        generation: 1,
        action,
        confirmed: true,
      }),
      /来源已变化/,
    );
  assert.equal(server.calls.length, count);
});
test("picker ownership survives a late cleanup from a different window", async (t) => {
  const { controller, server } = await setup(t);
  const base = { sessionId: "session", generation: 1 };
  await controller.uiCommand({
    ...base,
    owner: "main",
    action: "picker-start",
  });
  await controller.uiCommand({
    ...base,
    owner: "popup",
    action: "picker-start",
  });
  const count = server.calls.length;
  await controller.uiCommand({ ...base, owner: "main", action: "picker-stop" });
  assert.equal(server.calls.length, count);
  assert.equal(controller.snapshot().pickerOwners.session, "popup");
  assert.equal(
    await controller.uiCommand({
      ...base,
      owner: "main",
      action: "picker-poll",
    }),
    null,
  );
  await controller.stopForOwner("main");
  assert.equal(controller.snapshot().pickers.length, 1);
  await controller.stopForOwner("popup");
  assert.equal(controller.snapshot().pickers.length, 0);
  const pending = controller.uiCommand({
    ...base,
    owner: "popup",
    action: "picker-start",
  });
  await controller.stopForOwner("popup");
  await pending;
  assert.equal(controller.snapshot().pickers.length, 0);
});
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-debug-test-"));
  const store = new WorkspaceStore(path.join(root, "profile"));
  await store.load();
  await fs.mkdir(path.join(root, "project"));
  await store.addProject(path.join(root, "project"));
  const server = new Server(),
    controller = new DebugController(store, path.resolve("runtime"), {
      server,
      ...options,
    });
  const id = store.value.projects[0].id;
  await controller.prepareLaunch(id);
  t.after(async () => {
    await controller.dispose();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-debug-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, id, controller, server };
}

test("embedded watcher follows the saved auto switch and is released with its launch", async (t) => {
  const { root, id, controller, server } = await setup(t);
  const config = {
    auto_hot_reload_mods: false,
    included_mod_dirs: [
      { path: root, hot_reload: false, toolbox_hot_reload: true },
    ],
  };
  const file = path.join(root, ".mcdev.json");
  await fs.writeFile(file, JSON.stringify(config));
  controller.releaseLaunch("registered");
  await controller.prepareLaunch(id, root);
  assert.equal(controller.embeddedReloaders.size, 0);
  controller.releaseLaunch("registered");
  config.auto_hot_reload_mods = true;
  await fs.writeFile(file, JSON.stringify(config));
  await controller.prepareLaunch(id, root);
  const watcher = controller.embeddedReloaders.get("registered");
  assert(watcher && !watcher.closed);
  assert.equal(watcher.target(), null);
  server.summary.connected = true;
  server.summary.connectionGeneration = 8;
  assert.deepEqual(watcher.target(), { sessionId: "session", generation: 8 });
  controller.releaseLaunch("registered");
  assert(watcher.closed);
  assert.equal(controller.embeddedReloaders.size, 0);
});
test("debug code requests are serialized and reject stale or unavailable game sessions", async (t) => {
  const { controller, server } = await setup(t);
  assert.deepEqual(
    await Promise.all([
      controller.code("session", 1, "1+1", true),
      controller.code("session", 1, "2", false),
    ]),
    [2, 2],
  );
  assert.equal(server.maximum, 1);
  await assert.rejects(controller.code("session", 2, "1", true), /会话已更新/);
  server.summary.state = "process_started";
  await assert.rejects(
    controller.code("session", 1, "1", true),
    /进入游戏世界/,
  );
  assert.equal(JSON.stringify(controller.snapshot()).includes("secret"), false);
});
test("debug function scanning and bookmarks preserve source files and bind invocation to the selected project", async (t) => {
  const { controller, store, id } = await setup(t);
  const root = store.project(id).root;
  await fs.mkdir(path.join(root, "testScripts"));
  await fs.writeFile(
    path.join(root, "testScripts", "modMain.py"),
    "def hello(value=1):\n return value\n",
  );
  const found = await controller.functions.discover(id);
  assert.equal(found.length, 1);
  const saved = await controller.functions.save(id, {
    ...found[0],
    label: "hello",
    target: "client",
    argumentConfigs: {},
  });
  await assert.rejects(
    controller.invoke({
      sessionId: "session",
      generation: 1,
      projectId: "wrong",
      id: saved[0].id,
    }),
    /不匹配/,
  );
  assert.equal(
    await controller.invoke({
      sessionId: "session",
      generation: 1,
      projectId: id,
      id: saved[0].id,
      arguments: { value: "3" },
    }),
    2,
  );
  assert.deepEqual(await fs.readdir(root), ["testScripts"]);
  assert.equal((await controller.functions.list(id)).length, 1);
});
test("CPU and memory captures collect real-shaped results, use isolated ownership and release their timers", async (t) => {
  const { controller, server } = await setup(t);
  for (const kind of ["python", "memory"]) {
    await controller.startProfile({
      sessionId: "session",
      generation: 1,
      kind,
      duration: 30,
      target: "client",
      clock: "CPU",
    });
    const record = [...controller.profiles.values()].at(-1);
    assert.equal(record.status, "running");
    await assert.rejects(
      controller.startProfile({
        sessionId: "session",
        generation: 1,
        kind,
        duration: 2,
      }),
      /当前的采样/,
    );
    await controller.collect(record.id);
    assert.equal(record.status, "complete");
    assert.ok(record.result);
    assert.equal(controller.resources.size, 0);
    await fs.access(path.join(controller.reportDirectory, record.id + ".json"));
  }
  assert.ok(server.calls.every((code) => !code.includes("_mcdev_")));
  assert.ok(server.calls.some((code) => code.includes("threading.Timer(45")));
});
test("missing Tracy endpoint reports failure instead of success or cancellation", async (t) => {
  const { controller } = await setup(t, {
    discoverPorts: async () => [{ pid: 999, port: 8086 }],
  });
  await assert.rejects(
    controller.startProfile({
      sessionId: "session",
      generation: 1,
      kind: "native",
      duration: 2,
    }),
    /没有 Tracy/,
  );
  assert.equal([...controller.profiles.values()].at(-1).status, "failed");
});
test("cancelling a native capture during startup still stops and disposes its eventual handle", async (t) => {
  let releaseStart,
    finish,
    stops = 0,
    disposed = 0;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const capture = {
    completion,
    stop: async () => {
      stops++;
      finish({ result: {}, tracePath: "" });
    },
    dispose: async () => {
      disposed++;
    },
  };
  const { controller } = await setup(t, {
    discoverPorts: async () => [{ pid: 123, port: 8086 }],
    nativeStart: () =>
      new Promise((resolve) => {
        releaseStart = () => resolve(capture);
      }),
  });
  const starting = controller.startProfile({
    sessionId: "session",
    generation: 1,
    kind: "native",
    duration: 2,
  });
  while (!releaseStart) await new Promise((resolve) => setImmediate(resolve));
  const record = [...controller.profiles.values()].at(-1);
  await controller.cancel(record.id);
  releaseStart();
  await assert.rejects(starting, /取消/);
  assert.ok(stops > 0);
  assert.equal(disposed, 1);
  assert.equal(record.status, "cancelled");
});
test("picker cleanup waits behind an in-flight enable and does not leave a registered picker", async (t) => {
  const { controller, server } = await setup(t);
  await Promise.all([
    controller.uiCommand({
      sessionId: "session",
      generation: 1,
      action: "picker-start",
    }),
    controller.uiCommand({
      sessionId: "session",
      generation: 1,
      action: "picker-stop",
    }),
  ]);
  assert.equal(controller.pickers.size, 0);
  assert.ok(server.calls.at(-1).includes("UnListenForEngineClient"));
});

test("picker rejection cleans its listener instead of claiming it is active", async (t) => {
  const { controller, server } = await setup(t);
  const request = server.request.bind(server);
  server.request = async (...args) => {
    const result = await request(...args);
    return args[2].code.includes("ListenForEngineClient") &&
      !args[2].code.includes("UnListenForEngineClient")
      ? false
      : result;
  };
  await assert.rejects(
    controller.uiCommand({
      sessionId: "session",
      generation: 1,
      action: "picker-start",
    }),
    /未能启用/,
  );
  assert.equal(controller.pickers.size, 0);
  assert.ok(server.calls.at(-1).includes("UnListenForEngineClient"));
});
