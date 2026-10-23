const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-global-game-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-global-game-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = path.join(root, "A.exe"),
    b = path.join(root, "B.exe");
  await fs.writeFile(a, "A");
  await fs.writeFile(b, "B");
  return { root, a, b, store: new WorkspaceStore(path.join(root, "data")) };
}
test("legacy blank-game preference seeds global game once without modifying profile files", async (t) => {
  const { root, a, b, store } = await setup(t),
    profile = path.join(root, "profile");
  await fs.mkdir(profile);
  await fs.mkdir(path.dirname(store.file));
  const raw =
    "// unchanged\n" + JSON.stringify({ game_executable_path: a, custom: 42 });
  await fs.writeFile(path.join(profile, ".mcdev.json"), raw);
  const settings = JSON.stringify({
    settings: { BlankGamePath: b, ReloadKeys: { reload_key: "82" } },
    projects: [{ id: "p", root: profile }],
  });
  await fs.writeFile(store.file, settings);
  await store.load();
  assert.equal(store.value.settings.GamePath, b);
  assert.equal(
    await fs.readFile(path.join(profile, ".mcdev.json"), "utf8"),
    raw,
  );
  const backup = (await fs.readdir(path.dirname(store.file))).find((n) =>
    n.includes(".before-global-game-"),
  );
  assert(backup);
  assert.equal(
    await fs.readFile(path.join(path.dirname(store.file), backup), "utf8"),
    settings,
  );
  await store.updateSettings({ GamePath: "" });
  const again = new WorkspaceStore(path.dirname(store.file));
  await again.load();
  assert.equal(again.value.settings.GamePath, "");
});
test("migration resolves legacy relative game paths against the original base and preserves explicit overrides", async (t) => {
  const { root, a, store } = await setup(t);
  await fs.mkdir(path.dirname(store.file));
  const p = path.join(root, "saved-profile");
  await fs.mkdir(p);
  const raw = JSON.stringify({ game_executable_path: "A.exe" });
  await fs.writeFile(path.join(p, ".mcdev.json"), raw);
  await fs.writeFile(
    store.file,
    "\ufeff" +
      JSON.stringify({
        settings: { ReloadKeys: { reload_key: "82" } },
        projects: [{ id: "p", root: p, baseDirectory: root }],
      }),
  );
  await store.load();
  assert.equal(store.value.settings.GamePath, a);
  assert.equal(await fs.readFile(path.join(p, ".mcdev.json"), "utf8"), raw);
  await assert.rejects(
    store.updateSettings({ GamePath: "relative.exe" }),
    /绝对路径/,
  );
  await assert.rejects(
    store.updateSettings({ GamePath: path.join(root, "bad.txt") }),
    /EXE/,
  );
});
test("inherited launches follow global changes, overrides remain pinned, and prior run snapshots stay immutable", async (t) => {
  const { root, a, b, store } = await setup(t);
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const inherited = await profiles.read(store.value.projects[0].id),
    pinned = await profiles.create("pinned");
  await profiles.save(pinned.project.id, pinned.revision, {
    game_executable_path: a,
  });
  const worlds = new WorldLibrary(store, path.join(root, "worlds"));
  const children = [],
    launched = [];
  let pid = 100;
  const manager = new Sessions(store, a, {
    profiles,
    worlds,
    detectPids: async () => [],
    launcherOptions: {
      spawn: (_, __, opts) => {
        const child = new EventEmitter();
        Object.assign(child, {
          pid: ++pid,
          exitCode: null,
          signalCode: null,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        children.push(child);
        launched.push(opts.cwd);
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
      kill: async (id) => {
        const child = children.find((c) => c.pid === id);
        child.exitCode = 0;
        process.nextTick(() => child.emit("close", 0));
      },
    },
  });
  t.after(() => manager.shutdown());
  await store.updateSettings({ GamePath: a });
  await manager.start(inherited.project.id);
  await store.updateSettings({ GamePath: b });
  await manager.start(inherited.project.id);
  await manager.start(pinned.project.id);
  const snapshots = await Promise.all(
    launched.map((dir) =>
      fs.readFile(path.join(dir, ".mcdev.json"), "utf8").then(JSON.parse),
    ),
  );
  assert.deepEqual(
    snapshots.map((s) => s.game_executable_path),
    [a, b, a],
  );
  assert.equal(
    (await profiles.read(inherited.project.id)).config.game_executable_path,
    "",
  );
  assert.equal((await profiles.read(inherited.project.id)).raw, inherited.raw);
  await store.updateSettings({ GamePath: path.join(root, "missing.exe") });
  await assert.rejects(
    manager.start(inherited.project.id),
    /全局游戏程序不存在/,
  );
  assert.equal(launched.length, 3);
  await assert.rejects(manager.blankGame(), /全局游戏程序不存在/);
  await store.updateSettings({ GamePath: "" });
  await assert.rejects(manager.start(inherited.project.id), /全局游戏程序/);
  assert.equal(launched.length, 3);
  await manager.start(inherited.project.id, null, null, {
    runtimeConfig: structuredClone(snapshots[0]),
    playerName: "JoinedSnapshot",
  });
  const joined = JSON.parse(
    await fs.readFile(path.join(launched[3], ".mcdev.json"), "utf8"),
  );
  assert.equal(joined.game_executable_path, a);
  assert.equal(joined.user_name, "JoinedSnapshot");
  assert.equal(joined.auto_join_game, false);
  assert.equal((await profiles.read(inherited.project.id)).raw, inherited.raw);
});
