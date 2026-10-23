const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { initialLevel } = require("../electron/host-isolation.cjs");
const { reserveIsolation } = require("../electron/isolation-spawn.cjs");
const { WorkspaceStore, Launcher } = require("../electron/services.cjs");
const { Profiles } = require("../electron/profiles.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { GameOptions } = require("../electron/game-options.cjs");
const { readWorldInfo } = require("../electron/world-info.cjs");
const { sharedSources } = require("../src/source-sharing.cjs");
const { environmentBlock } = require("../electron/isolation-environment.cjs");
test("Windows environment overrides cannot select inherited shared directories through case aliases", () => {
  const block = environmentBlock({
    AppData: "SHARED",
    Path: "old",
    APPDATA: "独立",
    PATH: "new",
    "=c:": "C:\\work",
  }).toString("utf16le");
  assert.deepEqual(block.split("\0"), [
    "=C:=C:\\work",
    "APPDATA=独立",
    "PATH=new",
    "",
    "",
  ]);
  assert.throws(() => environmentBlock({ APPDATA: "a\0b" }), /无效/);
});
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-host-isolation-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-host-isolation-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
test("new host worlds reuse the upstream template with independent initial seed, type and Unicode title", () => {
  for (const world_type of [0, 1, 2])
    for (const game_mode of [0, 1, 2]) {
      const config = {
        world_name: "独立世界 ✓",
        world_type,
        game_mode,
        world_seed: -123456,
      };
      const data = initialLevel(config),
        info = readWorldInfo(data);
      assert.equal(info.levelName, config.world_name);
      assert.equal(info.seed, -123456);
      assert.equal(info.worldType, world_type);
      assert.equal(info.gameMode, game_mode);
    }
  assert.notDeepEqual(
    initialLevel({ world_name: "random", world_type: 1, game_mode: 1 }),
    initialLevel({ world_name: "random", world_type: 1, game_mode: 1 }),
  );
});
test("private options inherit initial shared settings and keep subsequent private edits without touching shared files", async (t) => {
  const root = await temp(t),
    shared = path.join(root, "shared.txt"),
    own = path.join(root, "own/options.txt");
  const original = "audio_music:0.5\r\nunknown:KEEP\r\n";
  await fs.writeFile(shared, original);
  const options = new GameOptions(root, shared, {
    isRunning: async () => true,
  });
  await options.save(null, { audio_music: "0.1" });
  await options.prepareIsolated(own);
  assert.equal(await fs.readFile(shared, "utf8"), original);
  assert.match(await fs.readFile(own, "utf8"), /audio_music:0.1/);
  await options.save((await options.template()).revision, {});
  await fs.writeFile(own, "audio_music:0.3\nunknown:PRIVATE\n");
  await options.prepareIsolated(own);
  assert.match(await fs.readFile(own, "utf8"), /PRIVATE/);
  assert.equal(await fs.readFile(shared, "utf8"), original);
});
test("isolated Sessions allow different worlds, reject duplicate saves and stop only the selected host", async (t) => {
  const root = await temp(t),
    store = new WorkspaceStore(path.join(root, "data"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const p = await profiles.read(store.value.projects[0].id),
    game = path.join(root, "Game.exe"),
    runtime = path.join(root, "Mcdk.exe");
  await fs.writeFile(game, "fixture");
  await fs.writeFile(runtime, "fixture");
  await profiles.save(p.project.id, p.revision, { game_executable_path: game });
  const worlds = new WorldLibrary(store, path.join(root, "worlds"));
  const a = await worlds.create(p.project.id, { name: "A" }),
    b = await worlds.create(p.project.id, { name: "B" });
  const children = [],
    launches = [],
    stops = [];
  const isolation = {
    prepare: async (id) => ({
      roaming: path.join(root, id),
      actualWorld: path.join(root, "worlds", id),
      mode: "isolated",
      options: async () => ({ changed: [] }),
      spawn: async (_, __, options) => {
        const c = new EventEmitter();
        Object.assign(c, {
          pid: 100 + children.length,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          start() {
            process.nextTick(() => c.emit("spawn"));
          },
        });
        children.push(c);
        launches.push(options);
        return c;
      },
      stop: async () => {
        stops.push(id);
        const c = children[[a.id, b.id].indexOf(id)];
        if (c) {
          c.exitCode = 0;
          process.nextTick(() => c.emit("close", 0));
        }
      },
    }),
  };
  const manager = new Sessions(store, runtime, {
    profiles,
    worlds,
    isolation,
    detectPids: async () => [777],
  });
  t.after(() => manager.shutdown());
  await store.updateSettings({
    GameWindowSize: { enabled: true, width: 1600, height: 900 },
  });
  await manager.start(p.project.id, a.id);
  const aid = manager.session.id;
  await manager.start(p.project.id, b.id);
  for (const options of launches) {
    const snapshot = JSON.parse(
      await fs.readFile(path.join(options.cwd, ".mcdev.json"), "utf8"),
    );
    assert.deepEqual(snapshot.window_style.fixed_size, [1600, 900]);
  }
  const bid = manager.session.id;
  assert.equal(manager.state().sessions.filter((s) => s.running).length, 2);
  assert(manager.state().sessions.every((s) => s.storageMode === "isolated"));
  assert.notEqual(launches[0].env.APPDATA, launches[1].env.APPDATA);
  assert(!launches[1].env.MCDEV_IS_SUBPROCESS_MODE);
  await assert.rejects(manager.start(p.project.id, a.id), /重复启动/);
  await manager.stop(aid);
  assert.deepEqual(stops, [a.id]);
  assert(manager.state().sessions.find((s) => s.id === bid).running);
});
test("shared-source warnings identify real overlapping directories but not sibling name prefixes", () => {
  const rows = [
    { id: "a", running: true, sourceRoots: ["C:/mods/a"] },
    {
      id: "b",
      worldId: "b",
      running: true,
      sourceRoots: ["c:\\mods\\a\\nested"],
    },
    { id: "c", running: true, sourceRoots: ["C:/mods/ab"] },
  ];
  const shared = sharedSources(rows[0].sourceRoots, rows, "a");
  assert.equal(shared.length, 1);
  assert.equal(shared[0].sessionId, "b");
});
test(
  "real native reservation refuses a second owner and releases after the helper exits",
  { skip: process.platform !== "win32" },
  async (t) => {
    const name = "Local\\DgnHost-test-" + crypto.randomUUID(),
      runtime = path.resolve("runtime");
    const first = await reserveIsolation(runtime, name, null);
    t.after(() => first.stop());
    await assert.rejects(reserveIsolation(runtime, name, null), /已有主机/);
    await first.stop();
    const second = await reserveIsolation(runtime, name, null);
    await second.stop();
  },
);
test(
  "native suspended launcher isolates child known folders and owns its process group",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temp(t),
      runtime = path.resolve("runtime"),
      exe = path.join(root, "Launcher.exe"),
      game = path.join(root, "Game.exe");
    const probe = path.resolve(
      "native/host-isolation/build/isolation-probe.exe",
    );
    try {
      await fs.access(probe);
    } catch {
      t.skip("Build the native probe with scripts/build-host-isolation.ps1");
      return;
    }
    await fs.copyFile(probe, exe);
    await fs.copyFile(probe, game);
    const roaming = path.join(root, "独立目录"),
      local = path.join(root, "local"),
      low = path.join(root, "low");
    for (const dir of [roaming, local, low]) await fs.mkdir(dir);
    const lease = await reserveIsolation(
      runtime,
      "Local\\DgnHost-test-" + crypto.randomUUID(),
      null,
    );
    t.after(() => lease.stop());
    const child = await lease.spawn(exe, {
      cwd: root,
      env: {
        ...process.env,
        DGN_PROBE_HOLD: "1",
        DGN_PROBE_LOCK: path.join(root, "LOCK"),
        DGN_ISO_MCDK: exe,
        DGN_ISO_GAME: game,
        DGN_ISO_DLL: path.join(runtime, "native/dgn-host-isolation.dll"),
        DGN_ISO_ROAMING: roaming,
        DGN_ISO_LOCAL: local,
        DGN_ISO_LOW: low,
      },
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b.toString()));
    const ended = new Promise((resolve) => child.once("close", resolve));
    child.start();
    const deadline = Date.now() + 8000;
    while (output.trim().split(/\r?\n/).length < 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(output.trim().split(/\r?\n/).slice(0, 2), [
      roaming,
      local,
    ]);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await assert.rejects(
      reserveIsolation(
        runtime,
        "Local\\DgnHost-other-" + crypto.randomUUID(),
        path.join(root, "LOCK"),
      ),
      /其他游戏占用/,
    );
    const session = { child, running: true };
    child.once("close", () => {
      session.running = false;
    });
    const receiver = {
      session,
      history: { finish: async () => {} },
      kill: () => lease.stop(),
      state: () => ({ running: session.running }),
      log() {},
    };
    let timeout;
    try {
      await Promise.race([
        Launcher.prototype.stopOwned.call(receiver),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error("owned stop blocked")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(await ended, 1);
    assert.equal(session.running, false);
    const after = await reserveIsolation(
      runtime,
      "Local\\DgnHost-after-" + crypto.randomUUID(),
      path.join(root, "LOCK"),
    );
    await after.stop();
    // A separate helper's abrupt exit must close its Job, not leave a suspended
    // launcher/game behind or require a broad process-name kill.
    const crash = await reserveIsolation(
      runtime,
      "Local\\DgnHost-crash-" + crypto.randomUUID(),
      null,
    );
    t.after(() => crash.stop());
    const second = await crash.spawn(exe, {
      cwd: root,
      env: {
        ...process.env,
        DGN_PROBE_HOLD: "1",
        DGN_ISO_MCDK: exe,
        DGN_ISO_GAME: game,
        DGN_ISO_DLL: path.join(runtime, "native/dgn-host-isolation.dll"),
        DGN_ISO_ROAMING: roaming,
        DGN_ISO_LOCAL: local,
        DGN_ISO_LOW: low,
      },
    });
    let secondOutput = "";
    second.stdout.on("data", (b) => (secondOutput += b.toString()));
    const stopped = new Promise((resolve) => second.once("close", resolve));
    second.start();
    const limit = Date.now() + 8000;
    while (secondOutput.trim().split(/\r?\n/).length < 3 && Date.now() < limit)
      await new Promise((r) => setTimeout(r, 20));
    const gamePid = Number(secondOutput.trim().split(/\r?\n/)[2]);
    assert(Number.isInteger(gamePid) && gamePid > 0);
    crash.abort();
    await stopped;
    for (const pid of [second.pid, gamePid])
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
  },
);
