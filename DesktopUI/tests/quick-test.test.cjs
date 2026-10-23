const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { ModLibrary } = require("../electron/domains/profiles/mod-library.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { validateModIds, quickTestMods } = require("../electron/domains/reload/quick-test.cjs");
test("quick mod selection rejects stale catalogs, duplicates, unavailable and removed entries", async () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const catalog = {
    revision: "r1",
    mods: [{ id, available: true, path: "C:/mods/one", name: "one" }],
  };
  const lib = { list: async () => catalog };
  assert.throws(() => validateModIds([id, id]), /无效/);
  await assert.rejects(
    quickTestMods(lib, { modIds: [id], revision: "r0" }),
    /模组库已变化/,
  );
  assert.deepEqual(await quickTestMods(lib, { modIds: [id], revision: "r1" }), [
    { path: "C:/mods/one", enabled: true, hot_reload: true },
  ]);
  catalog.mods[0].available = false;
  await assert.rejects(
    quickTestMods(lib, { modIds: [id], revision: "r1" }),
    /目录不可用/,
  );
  catalog.mods = [];
  await assert.rejects(
    quickTestMods(lib, { modIds: [id], revision: "r1" }),
    /移出/,
  );
});
test("quick world launch works without any profiles, persists choices and keeps default runtime isolated from templates", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-quick-test-"));
  let sessions;
  t.after(async () => {
    await sessions?.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-quick-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(path.join(root, "data"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const profile = await profiles.read(store.value.projects[0].id);
  const worlds = new WorldLibrary(store, path.join(root, "worlds"), {
    appDataOverride: path.join(root, "roaming"),
  });
  const world = await worlds.create(profile.project.id, { name: "Test World" });
  const game = path.join(root, "Game.exe"),
    runtime = path.join(root, "Launcher.exe"),
    one = path.join(root, "one"),
    two = path.join(root, "two");
  await fs.writeFile(game, "fixture");
  await fs.writeFile(runtime, "fixture");
  await fs.mkdir(one);
  await fs.mkdir(two);
  const mods = new ModLibrary(store, profiles);
  let catalog = await mods.list();
  await mods.addDirectories([one, two], catalog.revision);
  catalog = await mods.list();
  const selected = catalog.mods.find((m) => m.path === one).id;
  await store.updateSettings({
    GamePath: game,
    GameWindowSize: { enabled: true, width: 960, height: 540 },
  });
  await store.mutate((v) => {
    v.projects = [];
  });
  const children = [],
    launches = [];
  sessions = new Sessions(store, runtime, {
    worlds,
    profiles,
    modLibrary: mods,
    detectPids: async () => [],
    launcherOptions: {
      spawn: (_, __, options) => {
        const c = new EventEmitter();
        Object.assign(c, {
          pid: 100 + children.length,
          exitCode: null,
          signalCode: null,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        children.push(c);
        launches.push(options);
        process.nextTick(() => c.emit("spawn"));
        return c;
      },
      kill: async (pid) => {
        const c = children.find((x) => x.pid === pid);
        c.exitCode = 0;
        process.nextTick(() => c.emit("close", 0));
      },
    },
  });
  await sessions.start(null, world.id, null, {
    quickTest: { modIds: [selected], revision: catalog.revision },
  });
  const cfg = JSON.parse(
    await fs.readFile(path.join(launches[0].cwd, ".mcdev.json"), "utf8"),
  );
  assert.deepEqual(cfg.included_mod_dirs, [
    { path: one, enabled: true, hot_reload: true },
  ]);
  assert.equal(cfg.game_executable_path, game);
  assert.equal(cfg.world_name, "Test World");
  assert.equal(cfg.include_debug_mod, true);
  assert.equal(cfg.auto_hot_reload_mods, true);
  assert.equal(cfg.reset_world, false);
  assert.deepEqual(cfg.window_style.fixed_size, [960, 540]);
  assert.equal(store.value.projects.length, 0);
  assert.equal(
    await fs.readFile(path.join(profile.project.root, ".mcdev.json"), "utf8"),
    profile.raw,
  );
  assert.deepEqual((await worlds.list()).worlds[0].quickTestModIds, [selected]);
  assert.equal(sessions.session.quickTest, true);
  assert.equal(sessions.session.worldId, world.id);
  await assert.rejects(
    sessions.start(null, world.id, null, {
      quickTest: { modIds: [], revision: catalog.revision },
    }),
    /重复启动/,
  );
  await sessions.stop();
  await sessions.start(null, world.id, null, {
    quickTest: { modIds: [], revision: catalog.revision },
  });
  const empty = JSON.parse(
    await fs.readFile(path.join(launches[1].cwd, ".mcdev.json"), "utf8"),
  );
  assert.deepEqual(empty.included_mod_dirs, []);
  assert.deepEqual((await worlds.list()).worlds[0].quickTestModIds, []);
});
