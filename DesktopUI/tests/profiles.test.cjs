const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { WorkspaceStore } = require("../electron/services.cjs");
const {
  Profiles,
  WORLD_KEYS,
  profileDefaults,
} = require("../electron/profiles.cjs");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { validateConfig } = require("../electron/services.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-profiles-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-profiles-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const original = path.join(root, "original");
  await fs.mkdir(path.join(original, "mods"), { recursive: true });
  await fs.writeFile(path.join(original, "Game.exe"), "fixture");
  const raw =
    '\uFEFF{\n // preserve comment\n "game_executable_path":"Game.exe", "included_mod_dirs":["mods"], "world_name":"Legacy", "world_seed":9, "keep_inventory":false,"unknown":{"keep":42}\n}';
  await fs.writeFile(path.join(original, ".mcdev.json"), raw);
  const store = new WorkspaceStore(path.join(root, "profile"));
  await store.load();
  await store.addProject(original);
  const id = store.value.projects[0].id;
  const profiles = new Profiles(store);
  await profiles.initialize();
  const worlds = new WorldLibrary(
    store,
    path.join(root, "roaming/MinecraftPE_Netease/minecraftWorlds"),
    { appDataOverride: path.join(root, "roaming") },
  );
  return { root, original, raw, store, id, profiles, worlds };
}
test("legacy projects become independent profiles without touching originals or carrying world fields into profile files", async (t) => {
  const { original, raw, store, id, profiles } = await setup(t);
  const v = await store.readProject(id);
  assert.equal(
    await fs.readFile(path.join(original, ".mcdev.json"), "utf8"),
    raw,
  );
  assert.notEqual(v.project.root, original);
  assert.match(v.raw, /preserve comment/);
  const parsed = JSON.parse(v.raw.replace("// preserve comment", ""));
  for (const key of WORLD_KEYS) assert.ok(!Object.hasOwn(parsed, key));
  assert.equal(parsed.unknown.keep, 42);
  assert.equal(parsed.included_mod_dirs[0], path.join(original, "mods"));
  assert.throws(
    () => profiles.save(id, v.revision, { world_seed: 1 }),
    /不再保存世界参数/,
  );
  const copy = await profiles.create("Second", id);
  assert.notEqual(copy.project.id, id);
  assert.equal(copy.config.unknown.keep, 42);
  await profiles.save(copy.project.id, copy.revision, { user_name: "another" });
  assert.notEqual((await store.readProject(id)).config.user_name, "another");
  const again = new Profiles(store);
  await again.initialize();
  assert.equal(store.value.projects.length, 2);
});

test("profile creation, copying and both save modes always enable the helper without losing JSONC", async (t) => {
  const { store, profiles, id } = await setup(t);
  let current = await store.readProject(id);
  await store.saveProject(id, current.revision, { include_debug_mod: false });
  const legacy = await store.readProject(id);
  assert.equal((await profiles.create("new")).config.include_debug_mod, true);
  assert.equal(
    (await profiles.create("copy", id)).config.include_debug_mod,
    true,
  );
  assert.equal((await store.readProject(id)).raw, legacy.raw);
  current = await profiles.save(id, legacy.revision, {
    include_debug_mod: false,
  });
  assert.equal(current.config.include_debug_mod, true);
  current = await profiles.save(
    id,
    current.revision,
    undefined,
    '{\n // keep this\n "include_debug_mod":false,"unknown":{"value":7}\n}',
  );
  assert.equal(current.config.include_debug_mod, true);
  assert.match(current.raw, /keep this/);
  assert.equal(
    current.config.unknown?.value ??
      JSON.parse(current.raw.replace("// keep this", "")).unknown.value,
    7,
  );
});

test("blank clients use only player identity and a matching executable, with no profile mutation or implicit mod", async (t) => {
  const { root, store, id, profiles, worlds } = await setup(t);
  const runtime = path.join(root, "runtime.exe");
  await fs.writeFile(runtime, "fixture");
  const original = await profiles.read(id),
    records = JSON.stringify(store.value.projects),
    launches = [],
    children = [];
  const manager = new Sessions(store, runtime, {
    profiles,
    worlds,
    discover: async () => {
      throw Error("should use known executable");
    },
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
  t.after(() => manager.shutdown());
  await store.updateSettings({
    GameWindowSize: { enabled: true, width: 960, height: 540 },
  });
  await manager.startBlank("PlayerAlpha");
  await manager.startBlank("玩家乙");
  assert.equal(JSON.stringify(store.value.projects), records);
  assert.equal((await profiles.read(id)).raw, original.raw);
  const configs = await Promise.all(
    launches.map((x) =>
      fs.readFile(path.join(x.cwd, ".mcdev.json"), "utf8").then(JSON.parse),
    ),
  );
  for (const c of configs) {
    assert.deepEqual(c.window_style.fixed_size, [960, 540]);
    assert.deepEqual(c.included_mod_dirs, []);
    assert.equal(c.include_debug_mod, false);
    assert.equal(c.auto_join_game, false);
    assert.equal(c.reset_world, false);
    assert.equal(c.auto_hot_reload_mods, false);
    assert.equal(c.mcp_server_config.enabled, false);
  }
  assert.deepEqual(
    configs.map((c) => c.user_name),
    ["PlayerAlpha", "玩家乙"],
  );
  assert.notEqual(launches[0].env.APPDATA, launches[1].env.APPDATA);
  assert(manager.state().sessions.every((s) => s.blank && s.role === "menu"));
  await assert.rejects(manager.startBlank("\n"), /玩家名/);
  await assert.rejects(manager.startBlank("x".repeat(33)), /玩家名/);
  // Invitation guests have no selected profile and must keep the preflighted
  // executable even if global selection or discovery changes before spawn.
  manager.blankGame = async () => {
    throw Error("unexpected executable discovery");
  };
  manager.profiles = {
    queue: Promise.resolve(),
    read: async () => {
      throw Error("unexpected profile read");
    },
  };
  await manager.start(
    null,
    null,
    { userName: "InvitedFriend" },
    {
      debug: true,
      roomGuest: true,
      runtimeConfig: {
        ...profileDefaults(),
        game_executable_path: configs[0].game_executable_path,
        user_name: "InvitedFriend",
      },
    },
  );
  const joined = JSON.parse(
    await fs.readFile(path.join(launches[2].cwd, ".mcdev.json"), "utf8"),
  );
  assert.deepEqual(joined.included_mod_dirs, []);
  assert.equal(joined.game_executable_path, configs[0].game_executable_path);
  assert.equal(joined.user_name, "InvitedFriend");
  assert.equal(joined.include_debug_mod, true);
  assert.equal(joined.mcp_server_config.enabled, true);
  assert.equal(manager.state().sessions.at(-1).profileName, "联机客户端");
  const hostSnapshot = structuredClone(configs[0]);
  delete hostSnapshot.window_style;
  await manager.start(
    null,
    null,
    { userName: "LocalGuest" },
    { debug: true, runtimeConfig: hostSnapshot },
  );
  const localGuest = JSON.parse(
    await fs.readFile(path.join(launches[3].cwd, ".mcdev.json"), "utf8"),
  );
  assert.equal(
    localGuest.window_style,
    undefined,
    "joined clients preserve host's original absence of a size override",
  );
  assert.equal(JSON.stringify(store.value.projects), records);
  assert.equal((await profiles.read(id)).raw, original.raw);
});

test("blank executable selection works without profiles and prioritizes the running world version", async (t) => {
  const { root, store, profiles, worlds } = await setup(t);
  const host = path.join(root, "Host.exe"),
    fallback = path.join(root, "Fallback.exe");
  await fs.writeFile(host, "host");
  await fs.writeFile(fallback, "fallback");
  const manager = new Sessions(store, "unused", {
    profiles,
    worlds,
    discover: async () => ({ games: [{ path: fallback }] }),
  });
  await store.mutate((next) => {
    next.projects = [];
  });
  assert.equal(await manager.blankGame(), fallback);
  await store.updateSettings({ GamePath: fallback });
  manager.workers.push({
    session: { running: true, worldId: "world" },
    sourceSnapshot: { config: { game_executable_path: host } },
  });
  assert.equal(await manager.blankGame(), host);
  manager.workers = [];
  await store.updateSettings({ GamePath: "" });
  manager.discover = async () => ({ games: [] });
  await assert.rejects(manager.startBlank("Nobody"), /没有找到游戏程序/);
  assert.equal(manager.starting, false);
  assert.equal(manager.workers.length, 0);
});

test("reload key settings preserve unknown debug options and validate before saving", async (t) => {
  const { id, profiles } = await setup(t);
  let s = await profiles.read(id);
  assert.equal(s.config.debug_options.reload_key, "82");
  s = await profiles.save(id, s.revision, {
    debug_options: {
      reload_key: "106",
      reload_world_key: "111",
      custom_option: "KEEP",
    },
  });
  s = await profiles.save(id, s.revision, {
    debug_options: {
      ...s.config.debug_options,
      reload_key: "117",
      reload_world_key: "119",
      reload_key_global: true,
    },
  });
  assert.equal(s.config.debug_options.custom_option, "KEEP");
  assert.equal(s.config.debug_options.reload_key, "117");
  assert.throws(
    () => validateConfig({ debug_options: { reload_key: "999" } }),
    /按键码/,
  );
  assert.throws(
    () => validateConfig({ debug_options: { reload_key_global: 1 } }),
    /开关/,
  );
});
test("world-bound runtime snapshots and multiple independent menu sessions preserve profiles and stop only their own PID", async (t) => {
  const { root, store, id, profiles, worlds } = await setup(t);
  const runtime = path.join(root, "runtime.exe");
  await fs.writeFile(runtime, "fixture");
  const world = await worlds.create(id, {
    name: "World A",
    seed: 123,
    gameMode: 0,
    worldType: 2,
  });
  const legacy = await store.readProject(id);
  await store.saveProject(id, legacy.revision, { include_debug_mod: false });
  const profileBefore = (await store.readProject(id)).raw;
  await store.updateSettings({
    ReloadKeys: {
      reload_key: "117",
      reload_world_key: "119",
      reload_key_global: true,
    },
  });
  const children = [],
    launches = [],
    killed = [];
  let next = 100;
  const manager = new Sessions(store, runtime, {
    profiles,
    worlds,
    detectPids: async () => [],
    launcherOptions: {
      spawn: (exe, args, options) => {
        const c = new EventEmitter();
        Object.assign(c, {
          pid: ++next,
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
        killed.push(pid);
        const c = children.find((x) => x.pid === pid);
        c.exitCode = 0;
        process.nextTick(() => c.emit("close", 0));
      },
    },
  });
  t.after(() => manager.shutdown());
  const appliedNames = [];
  let rejectName = false;
  manager.menuName = {
    apply: async (_bridge, worker, name, run) => {
      appliedNames.push({ name, run });
      if (rejectName) throw Error("unsupported name interface");
      return { name, pid: worker.session.pid + 1000 };
    },
  };
  await manager.start(id, world.id);
  assert.equal(
    appliedNames.length,
    0,
    "world launches keep the normal player configuration route",
  );
  const host = manager.session.id;
  await manager.start(id);
  const menu1 = manager.session.id;
  await manager.start(id);
  const menu2 = manager.session.id;
  assert.equal(appliedNames.length, 2);
  assert(
    manager
      .state()
      .sessions.filter((s) => s.role === "menu")
      .every((s) => s.playerNameStatus === "applied"),
  );
  assert.equal(manager.state().sessions.filter((s) => s.running).length, 3);
  assert.equal((await store.readProject(id)).raw, profileBefore);
  const configs = await Promise.all(
    launches.map((x) =>
      fs.readFile(path.join(x.cwd, ".mcdev.json"), "utf8").then(JSON.parse),
    ),
  );
  assert.equal(configs[0].world_seed, 123);
  assert.equal(configs[0].game_mode, 0);
  assert.equal(configs[0].auto_join_game, true);
  for (const c of configs) {
    assert.equal(c.include_debug_mod, true);
    assert.equal(c.debug_options.reload_key, "117");
    assert.equal(c.debug_options.reload_world_key, "119");
    assert.equal(c.debug_options.reload_key_global, true);
  }
  assert.equal(configs[1].auto_join_game, false);
  assert.equal(configs[2].auto_join_game, false);
  assert.notEqual(launches[1].env.APPDATA, launches[2].env.APPDATA);
  assert.notEqual(launches[0].env.APPDATA, launches[1].env.APPDATA);
  const snapshot = await store.readProject(id);
  await profiles.save(id, snapshot.revision, { user_name: "Future" });
  assert.notEqual(
    JSON.parse(
      await fs.readFile(path.join(launches[0].cwd, ".mcdev.json"), "utf8"),
    ).user_name,
    "Future",
  );
  await manager.stop(menu1);
  assert.deepEqual(killed, [children[1].pid]);
  assert.equal(
    manager.state().sessions.find((s) => s.id === host).running,
    true,
  );
  assert.equal(
    manager.state().sessions.find((s) => s.id === menu2).running,
    true,
  );
  await assert.rejects(manager.start(id, world.id), /已有存档/);
  await assert.rejects(manager.remove(host), /已结束/);
  manager.select(menu1);
  await manager.remove(menu1);
  assert.equal(manager.session.id, host);
  assert.equal(
    manager.state().sessions.some((s) => s.id === menu1),
    false,
  );
  assert((await manager.history.list()).some((h) => h.id === menu1));
  manager.select(host);
  assert.equal(manager.state().session.id, host);
  rejectName = true;
  await assert.rejects(manager.startBlank("failed"), /玩家名未能设置/);
  assert.equal(killed.at(-1), children.at(-1).pid);
  assert.equal(
    manager.state().sessions.find((s) => s.id === host).running,
    true,
  );
  assert.equal(
    manager.state().sessions.find((s) => s.id === menu2).running,
    true,
  );
  assert.equal(manager.state().sessions.at(-1).playerNameStatus, "failed");
});
test("a save can change its profile without mutating either configuration and world options stay separate", async (t) => {
  const { store, id, profiles, worlds } = await setup(t);
  const other = await profiles.create("Other");
  const w = await worlds.create(id, {
    name: "World",
    gameMode: 1,
    worldType: 1,
  });
  await worlds.update(w.id, {
    profileId: other.project.id,
    options: { keep_inventory: false, game_mode: 0 },
  });
  const record = (await worlds.list()).worlds[0];
  assert.equal(record.profileId, other.project.id);
  assert.equal(record.options.keep_inventory, false);
  await assert.rejects(worlds.launchWorld(w.id, id), /已变化/);
  assert.equal(
    (await worlds.launchWorld(w.id, other.project.id)).options.game_mode,
    0,
  );
  assert.ok(
    !JSON.parse((await store.readProject(other.project.id)).raw).game_mode,
  );
});
test("host startup rejects external games but accepts owned isolated menu clients", async (t) => {
  const { root, store, id, profiles, worlds } = await setup(t);
  const runtime = path.join(root, "runtime.exe");
  await fs.writeFile(runtime, "fixture");
  const world = await worlds.create(id, { name: "Host" });
  let pids = [],
    snapshot = [],
    serial = 0;
  const children = [];
  const bridge = {
    prepareLaunch: async () => ({
      registrationId: "reg" + ++serial,
      environment: {},
    }),
    releaseLaunch: () => {},
    stopForLaunch: async () => {},
    snapshot: () => ({ sessions: snapshot }),
  };
  const manager = new Sessions(store, runtime, {
    profiles,
    worlds,
    bridge,
    detectPids: async () => pids,
    launcherOptions: {
      spawn: () => {
        const child = new EventEmitter();
        Object.assign(child, {
          pid: 1000 + children.length,
          exitCode: null,
          signalCode: null,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        children.push(child);
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
      kill: async (pid) => {
        const c = children.find((c) => c.pid === pid);
        c.exitCode = 0;
        process.nextTick(() => c.emit("close", 0));
      },
    },
  });
  t.after(() => manager.shutdown());
  await manager.start(id);
  snapshot = [
    { registrationId: manager.session.bridgeRegistrationId, minecraftPid: 555 },
  ];
  pids = [555, 999];
  await assert.rejects(manager.start(id, world.id), /已运行的游戏/);
  assert.equal(children.length, 1);
  pids = [555];
  await manager.start(id, world.id);
  assert.equal(children.length, 2);
  assert.equal(manager.session.worldId, world.id);
});
test("world metadata reader preserves imported mode, seed and gamerules without modifying bytes", () => {
  const { readWorldInfo } = require("../electron/world-info.cjs");
  const tag = (type, name, data) => {
    const n = Buffer.from(name),
      h = Buffer.alloc(3);
    h[0] = type;
    h.writeUInt16LE(n.length, 1);
    return Buffer.concat([h, n, data]);
  };
  const int = (value) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value);
    return b;
  };
  const seed = Buffer.alloc(8);
  seed.writeBigInt64LE(12345n);
  const body = Buffer.concat([
    Buffer.from([10, 0, 0]),
    tag(3, "GameType", int(0)),
    tag(3, "Generator", int(2)),
    tag(4, "RandomSeed", seed),
    tag(1, "cheatsEnabled", Buffer.from([1])),
    tag(1, "keepInventory", Buffer.from([0])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10);
  header.writeUInt32LE(body.length, 4);
  const input = Buffer.concat([header, body]),
    before = Buffer.from(input);
  const info = readWorldInfo(input);
  assert.equal(info.gameMode, 0);
  assert.equal(info.worldType, 2);
  assert.equal(info.seed, 12345);
  assert.equal(info.options.keep_inventory, false);
  assert.ok(input.equals(before));
  assert.throws(() => readWorldInfo(input.subarray(0, 12)), /头部|长度/);
});
test("legacy world rules become independent before their old profile is removed", async (t) => {
  const { id, profiles, worlds } = await setup(t);
  const w = await worlds.create(id, { name: "Legacy card" });
  const doc = await worlds.read();
  delete doc.worlds[0].options;
  delete doc.worlds[0].profileId;
  await worlds.write(doc);
  await worlds.migrateProfiles();
  await profiles.remove(id);
  assert.equal((await worlds.list()).worlds[0].options.keep_inventory, false);
  const next = await profiles.create("Replacement");
  await worlds.update(w.id, { profileId: next.project.id });
  assert.equal((await worlds.list()).worlds[0].options.keep_inventory, false);
});
