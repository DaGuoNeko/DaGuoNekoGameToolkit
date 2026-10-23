const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const {
  inspectWorldPacks,
  prepareWorldPacks,
} = require("../electron/world-packs.cjs");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/profiles.cjs");
const { AUTO_IMPORT_PROFILE } = require("../src/world-import-model.cjs");
const { zip, levelData } = require("./fixtures/zip.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const managed = (root, dir) =>
  path.join(root, ".toolbox-packs", path.relative(root, dir));
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-world-packs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function putPack(
  root,
  kind,
  name,
  legacy = false,
  id = crypto.randomUUID(),
) {
  const dir = path.join(root, kind + "_packs", name),
    manifest = {
      format_version: 1,
      header: { name, uuid: id, version: [1, 0, 0] },
      modules: [
        {
          type: kind === "behavior" ? "data" : "resources",
          uuid: crypto.randomUUID(),
          version: [1, 0, 0],
        },
      ],
    };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, legacy ? "pack_manifest.json" : "manifest.json"),
    JSON.stringify(manifest),
  );
  return { dir, manifest, ref: { pack_id: id, version: [1, 0, 0] } };
}
async function lists(root, behavior, resource = []) {
  for (const [kind, refs] of [
    ["behavior", behavior],
    ["resource", resource],
  ])
    await fs.writeFile(
      path.join(root, "world_" + kind + "_packs.json"),
      JSON.stringify(refs),
    );
}

test("enabled map order and legacy manifests survive MCDK list rewrites without enabling unused folders", async (t) => {
  const root = await temp(t),
    a = await putPack(root, "behavior", "A", true),
    b = await putPack(root, "behavior", "B"),
    r = await putPack(root, "resource", "R", true),
    unused = await putPack(root, "behavior", "unused", true);
  await lists(root, [b.ref, a.ref], [r.ref]);
  const before = await fs.readFile(path.join(a.dir, "pack_manifest.json"));
  const plan = await inspectWorldPacks(root);
  const loaded = await prepareWorldPacks(root, plan, []);
  assert.deepEqual(
    loaded.map(({ hot_reload, toolbox_hot_reload }) => [
      hot_reload,
      toolbox_hot_reload === true,
    ]),
    [
      [false, true],
      [false, true],
      [true, false],
    ],
  );
  assert.deepEqual(
    loaded.map((x) => x.path),
    [b.dir, a.dir, r.dir].map((dir) => managed(root, dir)),
  );
  assert.deepEqual(
    await fs.readFile(path.join(managed(root, a.dir), "pack_manifest.json")),
    before,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(managed(root, a.dir), "manifest.json"),
        "utf8",
      ),
    ),
    a.manifest,
  );
  await fs.access(path.join(managed(root, unused.dir), "pack_manifest.json"));
  await assert.rejects(
    fs.access(path.join(managed(root, unused.dir), "manifest.json")),
    {
      code: "ENOENT",
    },
  );
  await lists(root, [{ pack_id: crypto.randomUUID(), version: [0, 0, 1] }]);
  assert.deepEqual(
    (await prepareWorldPacks(root, plan, [])).map((x) => x.path),
    [b.dir, a.dir, r.dir].map((dir) => managed(root, dir)),
  );
  const withSameDir = await prepareWorldPacks(root, plan, [
    { path: a.dir, enabled: true, hot_reload: false },
  ]);
  assert.equal(
    withSameDir.filter((x) => x.path === managed(root, a.dir)).length,
    1,
  );
  assert.equal(withSameDir.at(-1).hot_reload, false);
});

test("missing refs, versions and external UUID conflicts fail before legacy aliases are written", async (t) => {
  const root = await temp(t),
    world = path.join(root, "world"),
    a = await putPack(world, "behavior", "A", true),
    missing = { pack_id: crypto.randomUUID(), version: [2, 0, 0] };
  await lists(world, [a.ref, missing]);
  const plan = await inspectWorldPacks(world);
  await assert.rejects(prepareWorldPacks(world, plan, []), /缺失或版本/);
  await assert.rejects(fs.access(path.join(a.dir, "manifest.json")), {
    code: "ENOENT",
  });
  const x = await putPack(
    path.join(root, "outside"),
    "behavior",
    "X",
    false,
    a.ref.pack_id,
  );
  await assert.rejects(
    prepareWorldPacks(world, { ...plan, behavior: [a.ref] }, [x.dir]),
    /UUID 冲突/,
  );
  await assert.rejects(
    prepareWorldPacks(
      world,
      { ...plan, behavior: [{ ...a.ref, version: [9, 0, 0] }] },
      [],
    ),
    /版本不一致/,
  );
  await assert.rejects(fs.access(path.join(a.dir, "manifest.json")), {
    code: "ENOENT",
  });
  const resolved = await prepareWorldPacks(
    world,
    { ...plan, behavior: [a.ref] },
    [{ path: x.dir, enabled: false }],
  );
  assert.equal(resolved[0].path, managed(world, a.dir));
});

test("duplicate pack identities and links are rejected; missing lists do not silently activate every pack", async (t) => {
  const root = await temp(t),
    a = await putPack(root, "behavior", "A");
  await assert.rejects(inspectWorldPacks(root), /缺少 world_behavior/);
  await lists(root, [a.ref, a.ref]);
  await assert.rejects(inspectWorldPacks(root), /重复/);
  await lists(root, [a.ref]);
  await putPack(root, "behavior", "duplicate", false, a.ref.pack_id);
  await assert.rejects(inspectWorldPacks(root), /UUID 重复/);
  const linked = path.join(await temp(t), "world");
  await fs.mkdir(linked);
  await fs.symlink(
    path.join(root, "behavior_packs"),
    path.join(linked, "behavior_packs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(inspectWorldPacks(linked), /不是普通目录/);
});

test("folder and ZIP import capture enabled packages, keep source/profile unchanged, and resolve only the owned copy", async (t) => {
  const root = await temp(t),
    source = path.join(root, "original"),
    a = await putPack(source, "behavior", "A", true);
  await lists(source, [a.ref]);
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  await fs.mkdir(path.join(source, "db"));
  await fs.writeFile(path.join(source, "db", "progress"), "MAP DATA");
  const store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const id = store.value.projects[0].id,
    before = (await profiles.read(id)).raw;
  const worlds = new WorldLibrary(
    store,
    path.join(root, "game/minecraftWorlds"),
  );
  const archive = path.join(root, "map.zip");
  await fs.writeFile(
    archive,
    zip([
      { name: "map/level.dat", data: levelData() },
      { name: "map/world_behavior_packs.json", data: JSON.stringify([a.ref]) },
      { name: "map/world_resource_packs.json", data: "[]" },
      {
        name: "map/behavior_packs/A/pack_manifest.json",
        data: JSON.stringify(a.manifest),
      },
    ]),
  );
  for (const file of [source, archive]) {
    const w = await worlds.importWorld(id, "test", file);
    assert.deepEqual(w.embeddedPacks.behavior, [a.ref]);
    const started = await worlds.launchWorld(w.id, id),
      mods = await worlds.prepareWorldPacks(w.id, started.embeddedPacks, []);
    assert.equal(
      mods[0].path,
      path.join(worlds.location(w.id), ".toolbox-packs/behavior_packs/A"),
    );
    assert.ok(mods.every((m) => !m.path.startsWith(source)));
    assert.deepEqual(
      (await worlds.list()).worlds.find((x) => x.id === w.id).embeddedPacks,
      w.embeddedPacks,
    );
  }
  assert.equal((await profiles.read(id)).raw, before);
  await assert.rejects(fs.access(path.join(a.dir, "manifest.json")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(path.join(source, "db/progress"), "utf8"),
    "MAP DATA",
  );
});

for (const mode of ["copy", "linked"])
  test(`automatic ${mode} import creates a clean profile and Sessions loads current packs on both launches`, async (t) => {
    const root = await temp(t),
      source = path.join(root, "source"),
      bp = await putPack(source, "behavior", "B", true),
      rp = await putPack(source, "resource", "R");
    await lists(source, [bp.ref], [rp.ref]);
    await fs.writeFile(path.join(source, "level.dat"), levelData());
    const runtime = path.join(root, "Runtime.exe"),
      game = path.join(root, "Game.exe");
    await fs.writeFile(runtime, "fixture");
    await fs.writeFile(game, "fixture");
    const store = new WorkspaceStore(path.join(root, "app"));
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    await store.updateSettings({ GamePath: game });
    const originalId = store.value.projects[0].id;
    const old = await profiles.read(originalId);
    await profiles.save(originalId, old.revision, {
      included_mod_dirs: [path.join(root, "unrelated-mod")],
      game_executable_path: path.join(root, "old-game.exe"),
    });
    const original = (await profiles.read(originalId)).raw;
    const worlds = new WorldLibrary(store, path.join(root, "worlds"), {
      createImportProfile: (name) => profiles.create(name + "（自动匹配）"),
    });
    const w = await worlds.importWorld(
        AUTO_IMPORT_PROFILE,
        "bundled",
        source,
        mode,
      ),
      children = [],
      snapshots = [];
    const id = w.profileId;
    assert.notEqual(id, originalId);
    assert.equal(store.value.projects.length, 2);
    assert.equal(w.projectId, id);
    const automatic = await profiles.read(id);
    assert.deepEqual(automatic.config.included_mod_dirs, []);
    assert.equal(automatic.config.game_executable_path, "");
    const manager = new Sessions(store, runtime, {
      profiles,
      worlds,
      detectPids: async () => [],
      launcherOptions: {
        spawn: (_file, _args, options) => {
          const child = new EventEmitter();
          Object.assign(child, {
            pid: 1000 + children.length,
            exitCode: null,
            signalCode: null,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          children.push(child);
          snapshots.push(options.cwd);
          process.nextTick(() => child.emit("spawn"));
          return child;
        },
        kill: async (pid) => {
          const child = children.find((x) => x.pid === pid);
          child.exitCode = 0;
          process.nextTick(() => child.emit("close", 0));
        },
      },
    });
    t.after(() => manager.shutdown());
    const first = await manager.start(id, w.id);
    await manager.stop(first.selectedSession);
    const activeRoot = mode === "linked" ? source : worlds.location(w.id);
    const script = path.join(
      activeRoot,
      ".toolbox-packs/behavior_packs/B/main.py",
    );
    await fs.writeFile(script, "# revised source after first launch\n");
    await lists(worlds.location(w.id), [
      { pack_id: crypto.randomUUID(), version: [0, 0, 1] },
    ]);
    await profiles.save(id, automatic.revision, {
      auto_hot_reload_mods: false,
    });
    const disabled = await profiles.read(id);
    const second = await manager.start(id, w.id);
    await manager.stop(second.selectedSession);
    for (const dir of snapshots) {
      const config = JSON.parse(
        await fs.readFile(path.join(dir, ".mcdev.json"), "utf8"),
      );
      assert.equal(config.world_source_path, null);
      assert.equal(config.game_executable_path, game);
      assert.equal(config.reset_world, false);
      assert.deepEqual(
        config.included_mod_dirs.map((x) => x.path),
        [
          path.join(activeRoot, ".toolbox-packs/behavior_packs/B"),
          path.join(activeRoot, ".toolbox-packs/resource_packs/R"),
        ],
      );
      assert.equal(config.include_debug_mod, true);
      assert.equal(config.included_mod_dirs[0].toolbox_hot_reload, true);
      assert.equal(config.included_mod_dirs[0].hot_reload, false);
      assert.equal(config.included_mod_dirs[1].hot_reload, true);
      assert.equal(config.auto_hot_reload_mods, dir === snapshots[0]);
      assert.equal(
        await fs.readFile(
          path.join(config.included_mod_dirs[0].path, "main.py"),
          "utf8",
        ),
        "# revised source after first launch\n",
      );
    }
    assert.equal((await profiles.read(originalId)).raw, original);
    assert.equal((await profiles.read(id)).raw, disabled.raw);
    await assert.rejects(fs.access(path.join(bp.dir, "manifest.json")), {
      code: "ENOENT",
    });
  });

test("automatic import works without existing profiles and does not create profiles for invalid or incomplete copies", async (t) => {
  const root = await temp(t),
    store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store),
    source = path.join(root, "source");
  const worlds = new WorldLibrary(store, path.join(root, "worlds"), {
    createImportProfile: (n) => profiles.create(n + "（自动匹配）"),
  });
  await assert.rejects(
    worlds.importWorld(AUTO_IMPORT_PROFILE, "bad", path.join(root, "missing")),
    /不存在/,
  );
  assert.equal(store.value.projects.length, 0);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  await putPack(source, "behavior", "broken-list-pack");
  await fs.writeFile(
    path.join(source, "world_behavior_packs.json"),
    "invalid json",
  );
  await assert.rejects(
    worlds.importWorld(AUTO_IMPORT_PROFILE, "broken", source),
    /未完成/,
  );
  assert.equal(store.value.projects.length, 0);
  const partial = (await worlds.list()).worlds[0];
  assert.equal(partial.copying, true);
  await worlds.recycle(null, partial.id, true);
  const plain = path.join(root, "plain");
  await fs.mkdir(plain);
  await fs.writeFile(path.join(plain, "level.dat"), levelData());
  const w = await worlds.importWorld(AUTO_IMPORT_PROFILE, "plain", plain);
  assert.equal(store.value.projects.length, 1);
  assert.equal(w.profileId, store.value.projects[0].id);
  assert.deepEqual(
    (await profiles.read(w.profileId)).config.included_mod_dirs,
    [],
  );
});

test("partial relocation resumes, managed copies retain their import baseline, and active games prevent first mutation", async (t) => {
  const root = await temp(t),
    b = await putPack(root, "behavior", "B", true),
    r = await putPack(root, "resource", "R");
  await lists(root, [b.ref], [r.ref]);
  const plan = await inspectWorldPacks(root);
  await assert.rejects(
    prepareWorldPacks(root, plan, [], async () => false),
    /退出其他游戏/,
  );
  await assert.rejects(fs.access(path.join(b.dir, "manifest.json")), {
    code: "ENOENT",
  });
  await fs.mkdir(path.join(root, ".toolbox-packs"));
  await fs.writeFile(
    path.join(root, ".toolbox-packs/pack-plan.json"),
    JSON.stringify(plan),
  );
  await fs.rename(
    path.join(root, "behavior_packs"),
    path.join(root, ".toolbox-packs/behavior_packs"),
  );
  const prepared = await prepareWorldPacks(root, plan, []);
  assert.equal(prepared.length, 2);
  await assert.rejects(fs.access(path.join(root, "resource_packs")), {
    code: "ENOENT",
  });
  await lists(root, [{ pack_id: crypto.randomUUID(), version: [1, 0, 0] }]);
  assert.deepEqual(await inspectWorldPacks(root), plan);
  // Already-normalized data needs no mutation and can be inspected even while
  // another isolated menu client is alive.
  assert.equal(
    (await prepareWorldPacks(root, plan, [], async () => false)).length,
    2,
  );
  const exported = path.join(await temp(t), "exported");
  await fs.cp(root, exported, { recursive: true });
  assert.deepEqual(await inspectWorldPacks(exported), plan);
  assert.ok(
    (await prepareWorldPacks(exported, plan, [])).every((x) =>
      x.path.startsWith(exported),
    ),
  );
});

test("world index size limit rejects oversized metadata without overwriting readable data", async (t) => {
  const root = await temp(t),
    store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const worlds = new WorldLibrary(store, path.join(root, "worlds"));
  await worlds.create(store.value.projects[0].id, { name: "size test" });
  const before = await fs.readFile(worlds.file),
    data = await worlds.read();
  data.worlds[0].extra = "x".repeat(4 * 1024 * 1024);
  await assert.rejects(worlds.write(data), /4 MiB/);
  assert.deepEqual(await fs.readFile(worlds.file), before);
  assert.equal((await worlds.read()).worlds[0].extra, undefined);
});
