const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { WorkspaceStore } = require("../electron/services.cjs"),
  { Profiles } = require("../electron/profiles.cjs"),
  { WorldLibrary } = require("../electron/worlds.cjs"),
  { Sessions } = require("../electron/sessions.cjs"),
  { ModLibrary } = require("../electron/mod-library.cjs"),
  { ReloadSources } = require("../electron/reload-sources.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-reload-sources-"));
  let sessions;
  t.after(async () => {
    await sessions?.shutdown();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(path.join(root, "data"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const id = store.value.projects[0].id;
  const old = path.join(root, "old"),
    next = path.join(root, "worktree"),
    game = path.join(root, "Game.exe"),
    launcher = path.join(root, "Launcher.exe");
  await fs.mkdir(old);
  await fs.mkdir(next);
  await fs.writeFile(game, "fixture");
  await fs.writeFile(launcher, "fixture");
  await store.updateSettings({ GamePath: game });
  let p = await profiles.read(id);
  await profiles.save(id, p.revision, { included_mod_dirs: [old] });
  const worlds = new WorldLibrary(store, path.join(root, "worlds")),
    a = await worlds.create(id, { name: "A" }),
    b = await worlds.create(id, { name: "B" }),
    stops = [];
  for (const world of [a, b]) {
    await fs.mkdir(worlds.location(world.id), { recursive: true });
    await fs.writeFile(
      path.join(worlds.location(world.id), "level.dat"),
      "fixture",
    );
  }
  let serial = 0;
  const isolation = {
    prepare: async (worldId) => {
      let child;
      return {
        roaming: path.join(root, "isolated", worldId),
        actualWorld: worlds.location(worldId),
        options: async () => ({ changed: [] }),
        spawn: async () => {
          child = new EventEmitter();
          Object.assign(child, {
            pid: ++serial + 100,
            exitCode: null,
            signalCode: null,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            start() {
              process.nextTick(() => child.emit("spawn"));
            },
          });
          return child;
        },
        stop: async () => {
          if (child && child.exitCode === null) {
            stops.push(worldId);
            child.exitCode = 0;
            process.nextTick(() => child.emit("close", 0));
          }
        },
      };
    },
  };
  const mods = new ModLibrary(store, profiles);
  sessions = new Sessions(store, launcher, {
    profiles,
    worlds,
    isolation,
    modLibrary: mods,
  });
  await sessions.start(id, a.id);
  const worker = sessions.current;
  worker.session.bridgeRegistrationId = "registered";
  worker.bridge = { stopForLaunch: async () => {}, releaseLaunch: () => {} };
  const bridge = {
    id: "bridge",
    registrationId: "registered",
    mcdkPid: worker.session.pid,
    connectionGeneration: 1,
    stateSequence: 2,
  };
  const debug = {
    session: (bid, gen) => {
      if (bid !== bridge.id || gen !== bridge.connectionGeneration)
        throw Error("stale bridge");
      return bridge;
    },
    assertReloadIdle() {},
  };
  const service = new ReloadSources(sessions, debug),
    context = { sessionId: "bridge", generation: 1 };
  const change = async (entries) => {
    const p = await profiles.read(id);
    await profiles.save(id, p.revision, { included_mod_dirs: entries });
  };
  return {
    root,
    store,
    profiles,
    worlds,
    id,
    a,
    b,
    worker,
    sessions,
    stops,
    old,
    next,
    game,
    debug,
    bridge,
    service,
    context,
    change,
    mods,
  };
}
test("reload compares saved sources without treating edits to source bytes or profile comments as a source switch", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.status(f.context)).changed, false);
  await fs.writeFile(path.join(f.old, "modMain.py"), "new code");
  assert.equal((await f.service.status(f.context)).changed, false);
  await f.change([{ path: f.old, enabled: false, hot_reload: true }, f.next]);
  const status = await f.service.status(f.context);
  assert.equal(status.changed, true);
  assert.deepEqual(status.activeSources, [f.old]);
  assert.equal(status.savedSources[0].enabled, false);
  assert.equal(status.savedSources[1].path, f.next);
  await assert.rejects(f.service.check(f.context), /最新配置重启/);
  assert.deepEqual(f.stops, []);
});
test("confirmed restart deploys the changed source to the same world and leaves another host alive", async (t) => {
  const f = await fixture(t);
  await f.sessions.start(f.id, f.b.id);
  const other = f.sessions.current;
  await f.change([f.next]);
  const status = await f.service.status(f.context),
    oldId = f.worker.session.id;
  const before = await f.profiles.read(f.id);
  await f.service.restart({
    ...f.context,
    confirmed: true,
    token: status.token,
  });
  const current = f.sessions.current;
  assert.notEqual(current.session.id, oldId);
  assert.equal(current.session.worldId, f.a.id);
  assert.deepEqual(current.sourceSnapshot.config.included_mod_dirs, [f.next]);
  assert(other.session.running);
  assert.deepEqual(f.stops, [f.a.id]);
  assert.equal((await f.profiles.read(f.id)).raw, before.raw);
  assert.equal(
    f.worlds.find(await f.worlds.read(), null, f.a.id).profileId,
    f.id,
  );
});
test("invalid paths, stale preview or generation never stop the current game", async (t) => {
  const f = await fixture(t);
  await f.change([f.next]);
  const status = await f.service.status(f.context);
  await assert.rejects(
    f.service.restart({ ...f.context, token: status.token }),
    /确认/,
  );
  await f.change([path.join(f.root, "missing")]);
  await assert.rejects(
    f.service.restart({ ...f.context, confirmed: true, token: status.token }),
    /配置.*变化/,
  );
  const invalid = await f.service.status(f.context);
  await assert.rejects(
    f.service.restart({ ...f.context, confirmed: true, token: invalid.token }),
    /ENOENT|不可用/,
  );
  await assert.rejects(
    f.service.restart({
      ...f.context,
      generation: 2,
      confirmed: true,
      token: invalid.token,
    }),
    /stale/,
  );
  assert(f.worker.session.running);
  assert.deepEqual(f.stops, []);
  assert.equal(f.sessions.restartReservation, null);
});
test("a failed stop is not followed by a new launch; saved menu state can still restart", async (t) => {
  const f = await fixture(t);
  await f.change([f.next]);
  const status = await f.service.status(f.context);
  const original = f.sessions.stop.bind(f.sessions);
  f.sessions.stop = async () => {
    throw Error("stop failed");
  };
  await assert.rejects(
    f.service.restart({ ...f.context, confirmed: true, token: status.token }),
    /stop failed/,
  );
  assert.equal(f.sessions.workers.length, 1);
  assert(f.worker.session.running);
  f.sessions.stop = original;
  f.bridge.state = "game_unavailable";
  await f.service.restart({
    ...f.context,
    confirmed: true,
    token: (await f.service.status(f.context)).token,
  });
  assert.equal(f.sessions.workers.length, 2);
});
test("quick-test source comparison uses its saved choices instead of the bound profile", async (t) => {
  const f = await fixture(t);
  await f.sessions.stop(f.worker.session.id);
  let catalog = await f.mods.list();
  await f.mods.addDirectories([f.old, f.next], catalog.revision);
  catalog = await f.mods.list();
  const one = catalog.mods.find((m) => m.path === f.old).id,
    two = catalog.mods.find((m) => m.path === f.next).id;
  await f.sessions.start(null, f.a.id, null, {
    quickTest: { modIds: [one], revision: catalog.revision },
  });
  const worker = f.sessions.current;
  worker.session.bridgeRegistrationId = "registered";
  worker.bridge = { stopForLaunch: async () => {}, releaseLaunch: () => {} };
  f.bridge.mcdkPid = worker.session.pid;
  assert.equal((await f.service.status(f.context)).changed, false);
  await f.worlds.saveQuickTest(f.a.id, [two]);
  const status = await f.service.status(f.context);
  assert(status.changed);
  const original = (await f.profiles.read(f.id)).raw;
  await f.service.restart({
    ...f.context,
    confirmed: true,
    token: status.token,
  });
  assert.equal(f.sessions.current.session.quickTest, true);
  assert.equal(
    f.sessions.current.sourceSnapshot.config.included_mod_dirs[0].path,
    f.next,
  );
  assert.equal((await f.profiles.read(f.id)).raw, original);
});
test("configuration edits during stop abort startup without falling back to stale sources", async (t) => {
  const f = await fixture(t);
  await f.change([f.next]);
  const status = await f.service.status(f.context);
  const stop = f.sessions.stop.bind(f.sessions);
  f.sessions.stop = async (id) => {
    const state = await stop(id);
    await f.change([f.old]);
    return state;
  };
  await assert.rejects(
    f.service.restart({ ...f.context, confirmed: true, token: status.token }),
    /原游戏已停止.*配置在停止期间/,
  );
  assert.equal(f.sessions.workers.length, 1);
  assert.equal(f.worker.session.running, false);
  assert.equal(f.sessions.restartReservation, null);
});
test("an unrelated failed profile save does not poison later source checks", async (t) => {
  const f = await fixture(t);
  f.profiles.queue = Promise.reject(Error("earlier save failed"));
  f.profiles.queue.catch(() => {});
  assert.equal((await f.service.status(f.context)).changed, false);
  f.profiles.queue = Promise.resolve();
});
test("closing the toolbox during restart cannot launch a new game afterward", async (t) => {
  const f = await fixture(t);
  await f.change([f.next]);
  const status = await f.service.status(f.context);
  const stop = f.sessions.stop.bind(f.sessions);
  f.sessions.stop = async (id) => {
    const state = await stop(id);
    await f.sessions.shutdown();
    return state;
  };
  await assert.rejects(
    f.service.restart({ ...f.context, confirmed: true, token: status.token }),
    /正在关闭/,
  );
  assert.equal(f.sessions.workers.length, 1);
  assert.equal(f.worker.session.running, false);
});
