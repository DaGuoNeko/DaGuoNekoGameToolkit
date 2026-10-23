const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  WorldActions,
  normalizeActions,
  actionCode,
} = require("../electron/world-actions.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { spawnSync } = require("node:child_process");
const command = (id = "one", extra = {}) => ({
  id,
  name: id,
  type: "command",
  enabled: true,
  auto: true,
  command: "/time set day",
  ...extra,
});

test("biome actions stop after a partial failure and report confirmed progress without replay", async (t) => {
  const action = {
    id: "biome",
    name: "沙漠",
    type: "biome",
    enabled: true,
    auto: false,
    biome: "minecraft:desert",
    shape: "rectangle",
    length: 32,
    width: 32,
    heightMode: "column",
  };
  const h = harness(t, [action]);
  let batches = 0;
  h.handle(async (code) => {
    if (code.includes("DGN_ACTION_PLAYER")) return { playerId: "-123" };
    if (code.includes("DGN_ACTION_READY")) return { ready: true };
    if (code.includes("DGN_BIOME_PROBE"))
      return {
        known: true,
        dimension: 3,
        position: [0, 64, 0],
        min: [0, -64, 0],
        max: [15, 319, 15],
        chunks: [
          [-1, -1],
          [-1, 0],
          [0, -1],
          [0, 0],
        ],
      };
    assert.match(code, /DGN_BIOME_BATCH/);
    batches++;
    return { ok: false, completed: 1 };
  });
  const target = h.service.status("world-1").target;
  await assert.rejects(
    h.service.run({
      worldId: "world-1",
      sessionId: "launch-1",
      target,
      actionId: "biome",
    }),
    /已确认 256\/1024 列/,
  );
  assert.equal(batches, 1);
  assert.equal(h.service.status("world-1").history[0].result.dimension, 3);
  assert.equal(h.service.status("world-1").history[0].status, "error");
});

test("ordinary startup and reconnection do not install biome hooks or replay saved edits", async (t) => {
  const h = harness(t, []);
  await h.settle();
  assert.equal(h.service.status("world-1").phase, "idle");
  assert.equal(h.calls.length, 0);
  h.b.connectionGeneration++;
  await h.settle();
  assert.equal(h.calls.length, 0);
});
function harness(t, actions = [command()]) {
  const sessions = new EventEmitter(),
    debug = new EventEmitter();
  const w = {
    session: {
      id: "launch-1",
      worldId: "world-1",
      role: "world",
      running: true,
      pid: 100,
      bridgeRegistrationId: "reg",
      runDirectory: "C:\\runs\\one",
    },
    launchActions: actions,
    logs: [],
    log(s, text) {
      this.logs.push({ s, text });
    },
  };
  sessions.workers = [w];
  const b = {
    id: "bridge",
    registrationId: "reg",
    connected: true,
    state: "game_ready",
    gameIpcConnected: true,
    debugCapabilityEnabled: true,
    connectionGeneration: 1,
    stateSequence: 2,
    mcdkPid: 100,
    minecraftPid: 200,
    projectRoot: w.session.runDirectory,
  };
  debug.snapshot = () => ({ sessions: [b] });
  debug.session = (id, generation) => {
    assert.equal(id, b.id);
    assert.equal(generation, b.connectionGeneration);
    if (
      b.state !== "game_ready" ||
      !b.gameIpcConnected ||
      !b.debugCapabilityEnabled
    )
      throw Error("not ready");
  };
  const calls = [];
  let handler = async (code) =>
    code.includes("DGN_ACTION_PLAYER")
      ? { playerId: "-123456789123456" }
      : code.includes("DGN_ACTION_READY")
        ? { ready: true }
        : { ok: true };
  debug.code = async (id, generation, code, client, guard) => {
    guard();
    calls.push({ id, generation, code, client });
    const v = await handler(code);
    guard();
    return v;
  };
  const service = new WorldActions(sessions, debug, {}, { interval: 60000 });
  service.config = async () => ({ actions: w.launchActions });
  t.after(() => service.dispose());
  return {
    service,
    w,
    b,
    calls,
    sessions,
    debug,
    handle: (fn) => (handler = fn),
    settle: async () => {
      service.reconcile();
      await service.records.get(w.session.id)?.job;
    },
  };
}
test("world actions persist per world with optimistic revisions, unknown world fields preserved", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-world-actions-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-world-actions-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const store = new WorkspaceStore(path.join(root, "data"));
  await store.load();
  await store.addProject(project);
  const worlds = new WorldLibrary(store, path.join(root, "worlds"));
  const world = await worlds.create(store.value.projects[0].id, {
    name: "one",
  });
  const second = await worlds.create(store.value.projects[0].id, {
    name: "two",
  });
  const sessions = new EventEmitter(),
    debug = new EventEmitter();
  sessions.workers = [];
  const service = new WorldActions(sessions, debug, worlds, {
    interval: 60000,
  });
  t.after(() => service.dispose());
  const original = await service.config(world.id);
  await service.save({
    worldId: world.id,
    revision: original.revision,
    actions: [command()],
  });
  await assert.rejects(
    service.save({
      worldId: world.id,
      revision: original.revision,
      actions: [],
    }),
    /已变化/,
  );
  assert.deepEqual((await service.config(second.id)).actions, []);
  const otherLibrary = new WorldLibrary(store, worlds.worldsRoot);
  assert.equal(
    (await otherLibrary.list()).worlds.find((w) => w.id === world.id).actions[0]
      .command,
    "/time set day",
  );
  const current = await service.config(world.id);
  await worlds.rename(null, world.id, "renamed");
  await service.save({
    worldId: world.id,
    revision: current.revision,
    actions: [],
  });
  assert.equal(
    (await worlds.list()).worlds.find((w) => w.id === world.id).name,
    "renamed",
  );
  await worlds.recycle(null, world.id, true);
  await assert.rejects(service.config(world.id), /不可用/);
});
test("actions validate count, duplicate IDs, literal data and explicit script side", () => {
  assert.throws(() => normalizeActions([command(), command()]), /重复/);
  assert.throws(
    () =>
      normalizeActions([command("x", { command: "/time set day\n/kill @a" })]),
    /一条/,
  );
  assert.throws(
    () =>
      normalizeActions([
        command("x", {
          type: "item",
          item: "minecraft:stone",
          count: 0,
          aux: 0,
        }),
      ]),
    /数量/,
  );
  assert.throws(
    () =>
      normalizeActions([
        command("x", { type: "script", code: "pass", target: "all" }),
      ]),
    /执行端/,
  );
  const action = command("x", { command: '/say 中文 "quoted" \\ text' });
  const source = actionCode(action, "-123");
  const encoded = /b64decode\('([^']+)'\)/.exec(source)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64")), {
    ...action,
    playerId: "-123",
  });
  assert.match(source, /SetCommand.*player,True/);
  assert.match(source, /player not in api.GetPlayerList/);
});
test("generated Python calls documented command/item signatures and rejects a departed player", () => {
  const sources = [
    actionCode(command("unicode", { command: '/say 中文 "test"' }), "-123"),
    actionCode(
      { type: "item", item: "demo:test_item", count: 5, aux: 2 },
      "-123",
    ),
    actionCode(command(), "999"),
  ];
  const script = `import sys,json,types
sources=json.load(sys.stdin)
api=types.ModuleType('mod.server.extraServerApi')
mod=types.ModuleType('mod');server=types.ModuleType('mod.server')
mod.server=server;server.extraServerApi=api
sys.modules.update({'mod':mod,'mod.server':server,'mod.server.extraServerApi':api})
calls=[]
class Factory(object):
 def CreateCommand(self,level):
  assert level=='level'
  return self
 def CreateItem(self,player):
  assert player=='-123'
  return self
 def SetCommand(self,command,player,show):
  calls.append({'command':command.decode('utf-8'),'player':player,'show':show})
  return True
 def SpawnItemToPlayerInv(self,item,player):
  item['newItemName']=item['newItemName'].decode('utf-8')
  calls.append({'item':item,'player':player})
  return True
api.GetEngineCompFactory=lambda:Factory()
api.GetPlayerList=lambda:['-123']
api.GetLevelId=lambda:'level'
for source in sources[:2]:
 ns={};exec(compile(source,'action','exec'),ns)
 assert ns['_result']['ok'] is True
try:
 exec(compile(sources[2],'action','exec'),{})
 raise AssertionError('departed player executed')
except RuntimeError:
 pass
print(json.dumps(calls,ensure_ascii=True))
`;
  const result = spawnSync("python", ["-c", script], {
    input: JSON.stringify(sources),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { command: '/say 中文 "test"', player: "-123", show: true },
    {
      item: { newItemName: "demo:test_item", count: 5, newAuxValue: 2 },
      player: "-123",
    },
  ]);
});
test("automatic actions wait for player, execute in order once, do not repeat on reload or navigation", async (t) => {
  const h = harness(t, [
    command("first"),
    command("disabled", { enabled: false }),
    command("manual", { auto: false }),
    command("last"),
  ]);
  let ready = false;
  h.handle(async (code) =>
    code.includes("DGN_ACTION_PLAYER")
      ? { playerId: ready ? "123" : "-1" }
      : code.includes("DGN_ACTION_READY")
        ? { ready }
        : { ok: true },
  );
  await h.settle();
  assert.equal(h.service.status("world-1").phase, "waiting");
  assert.equal(
    h.calls.filter((c) => c.code.includes("DGN_WORLD_ACTION")).length,
    0,
  );
  ready = true;
  await h.settle();
  assert.deepEqual(
    h.service.status("world-1").history.map((x) => x.name),
    ["last", "first"],
  );
  h.b.connectionGeneration++;
  h.b.stateSequence += 2;
  await h.settle();
  h.sessions.emit("state");
  h.debug.emit("state");
  assert.equal(
    h.calls.filter((c) => c.code.includes("DGN_WORLD_ACTION")).length,
    2,
  );
});
test("automatic failure stops later actions and never replays an uncertain mutation", async (t) => {
  const h = harness(t, [command("first"), command("second")]);
  h.handle(async (code) => {
    if (code.includes("DGN_ACTION_PLAYER")) return { playerId: "123" };
    if (code.includes("DGN_ACTION_READY")) return { ready: true };
    throw Error("timeout after delivery");
  });
  await h.settle();
  await h.settle();
  const state = h.service.status("world-1");
  assert.equal(state.phase, "error");
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].status, "error");
  assert.match(state.history[0].message, /未自动重试/);
});
test("cancel during readiness probe prevents all mutations", async (t) => {
  const h = harness(t);
  let release;
  h.handle((code) =>
    code.includes("DGN_ACTION_PLAYER")
      ? new Promise((r) => {
          release = r;
        })
      : Promise.resolve({ ready: true }),
  );
  h.service.reconcile();
  h.service.cancel(h.w.session.id);
  release({ playerId: "123" });
  await h.service.records.get(h.w.session.id).job;
  assert.equal(h.service.status("world-1").phase, "cancelled");
  assert.equal(
    h.calls.filter((c) => c.code.includes("DGN_WORLD_ACTION")).length,
    0,
  );
});
test("pending actions cancel on generation change, exit or deadline", async (t) => {
  const h = harness(t);
  h.handle(async () => ({ playerId: "-1" }));
  await h.settle();
  h.b.connectionGeneration++;
  await h.settle();
  assert.equal(h.service.status("world-1").phase, "cancelled");
  const other = harness(t);
  other.service.record(other.w).deadline = 0;
  await other.settle();
  assert.equal(other.calls.length, 0);
  const ended = harness(t);
  ended.w.session.running = false;
  await ended.settle();
  assert.equal(ended.calls.length, 0);
});
test("manual requests reject wrong world, parent PID, generation and concurrent clicks", async (t) => {
  const h = harness(t, [command("one", { auto: false })]);
  const args = {
    worldId: "world-1",
    sessionId: h.w.session.id,
    target: h.service.target(h.w),
    actionId: "one",
  };
  await assert.rejects(
    h.service.run({ ...args, worldId: "world-2" }),
    /不匹配/,
  );
  h.b.mcdkPid++;
  await assert.rejects(h.service.run(args), /等待/);
  h.b.mcdkPid--;
  await assert.rejects(
    h.service.run({ ...args, target: { ...args.target, generation: 99 } }),
    /变化/,
  );
  let release;
  h.handle(async (code) => {
    if (code.includes("DGN_ACTION_PLAYER"))
      return new Promise((r) => {
        release = r;
      });
    return code.includes("DGN_ACTION_READY") ? { ready: true } : { ok: true };
  });
  const pending = h.service.run(args);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(h.service.run(args), /稍后/);
  release({ playerId: "123" });
  await pending;
  assert.equal(h.service.status("world-1").history[0].status, "success");
});
test("editing startup configuration does not alter launch snapshot and menus never auto-run", async (t) => {
  const h = harness(t);
  const r = h.service.record(h.w);
  h.service.config = async () => ({ actions: [command("new")] });
  await h.settle();
  assert.equal(r.history[0].name, "one");
  const menu = harness(t);
  menu.w.session.worldId = null;
  menu.w.session.role = "menu";
  await menu.settle();
  assert.equal(menu.calls.length, 0);
});
test("shutdown during a pending call prevents remaining operations", async (t) => {
  const h = harness(t);
  let release;
  h.handle(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  h.service.reconcile();
  const closing = h.service.dispose();
  release({ playerId: "123" });
  await closing;
  assert.equal(h.calls.length, 1);
});
