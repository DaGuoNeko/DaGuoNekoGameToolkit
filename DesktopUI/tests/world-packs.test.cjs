const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const {
  editWorldPack,
  inspectWorldPacks,
  inspectWorldPackHealth,
  inspectWorldPackVersions,
  prepareWorldPacks: preparePacks,
  rewriteWorldPackUuids,
  syncWorldPackVersions,
} = require("../electron/domains/worlds/world-packs.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { AUTO_IMPORT_PROFILE } = require("../shared/world-import-model.cjs");
const { zip, levelData } = require("./fixtures/zip.cjs");
const { Sessions } = require("../electron/sessions.cjs");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const managed = (root, dir) =>
  path.join(root, ".toolbox-packs", path.relative(root, dir));
const prepareWorldPacks = (root, plan, external, canMutate, run = path.join(path.dirname(root), "runs", crypto.randomUUID())) =>
  preparePacks(root, plan, external, canMutate, run);
async function temp(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-world-packs-"));
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert(path.basename(base).startsWith("dgn-world-packs-"));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, "world");
  await fs.mkdir(root);
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
    loaded.map((x) => x.toolbox_source_path),
    [b.dir, a.dir, r.dir],
  );
  assert.deepEqual(
    await fs.readFile(path.join(a.dir, "pack_manifest.json")),
    before,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(path.dirname(path.dirname(path.dirname(loaded[1].path))), "pack-manifests", a.ref.pack_id.replaceAll("-", "") + ".json"),
        "utf8",
      ),
    ),
    a.manifest,
  );
  await fs.access(path.join(unused.dir, "pack_manifest.json"));
  await assert.rejects(
    fs.access(path.join(unused.dir, "manifest.json")),
    {
      code: "ENOENT",
    },
  );
  await lists(root, [{ pack_id: crypto.randomUUID(), version: [0, 0, 1] }]);
  assert.deepEqual(
    (await prepareWorldPacks(root, plan, [])).map((x) => x.toolbox_source_path),
    [b.dir, a.dir, r.dir],
  );
  const withSameDir = await prepareWorldPacks(root, plan, [
    { path: a.dir, enabled: true, hot_reload: false },
  ]);
  assert.equal(
    withSameDir.filter((x) => x.toolbox_source_path === a.dir).length,
    1,
  );
  assert.equal(withSameDir.at(-1).hot_reload, false);
  const container = await prepareWorldPacks(root, plan, [
    { path: path.join(root, "behavior_packs"), enabled: true, hot_reload: false },
  ]);
  assert.deepEqual(
    container.filter((x) => x.toolbox_source_path?.includes("behavior_packs"))
      .map((x) => x.toolbox_source_path).sort(),
    [a.dir, b.dir, unused.dir].sort(),
  );
  assert(container.filter((x) => x.toolbox_source_path?.includes("behavior_packs"))
    .every((x) => x.hot_reload === false && !x.toolbox_hot_reload));
  const legacyRoot = await temp(t), legacy = await putPack(legacyRoot,"behavior","B",true);
  await lists(legacyRoot,[legacy.ref]);
  const legacyPlan = await inspectWorldPacks(legacyRoot);
  const compatible = await preparePacks(legacyRoot, legacyPlan, [legacy.dir]);
  assert.equal(compatible[0].toolbox_hot_reload,true);
  assert.equal(compatible[0].path,managed(legacyRoot,legacy.dir));
});

test("pack version inspection reports differences and sync keeps backups", async (t) => {
  const root = await temp(t),
    pack = await putPack(root, "behavior", "customlizi");
  await lists(root, [{ ...pack.ref, version: [0, 0, 2] }]);
  const plan = await inspectWorldPacks(root),
    before = await fs.readFile(path.join(root, "world_behavior_packs.json"), "utf8"),
    checked = await inspectWorldPackVersions(root, plan);
  assert.deepEqual(checked.issues[0], {
    kind: "behavior",
    status: "version",
    packId: pack.ref.pack_id,
    packName: "customlizi",
    expected: [0, 0, 2],
    actual: [1, 0, 0],
  });
  const synced = await syncWorldPackVersions(root, plan, async () => {});
  assert.equal(synced.changed, true);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, "world_behavior_packs.json"), "utf8"))[0].version,
    [1, 0, 0],
  );
  assert.equal(
    await fs.readFile(path.join(synced.backupPath, "0.bak"), "utf8"),
    before,
  );
});

test("pack version sync updates an existing managed baseline", async (t) => {
  const root = await temp(t),
    pack = await putPack(root, "behavior", "managed");
  await lists(root, [{ ...pack.ref, version: [0, 0, 2] }]);
  const plan = await inspectWorldPacks(root),
    managedRoot = path.join(root, ".toolbox-packs");
  await fs.mkdir(managedRoot);
  await fs.writeFile(
    path.join(managedRoot, "pack-plan.json"),
    JSON.stringify(plan),
  );
  await fs.rename(
    path.join(root, "behavior_packs"),
    path.join(managedRoot, "behavior_packs"),
  );
  let next;
  await syncWorldPackVersions(root, plan, async value => { next = value; });
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(managedRoot, "pack-plan.json"), "utf8"),
    ).behavior[0].version,
    [1, 0, 0],
  );
  await prepareWorldPacks(root, next, []);
});

test("world listing detects stale pack versions before the first launch", async (t) => {
  const root = await temp(t),
    source = path.join(root, "source"),
    pack = await putPack(source, "behavior", "stale");
  await lists(source, [{ ...pack.ref, version: [0, 0, 2] }]);
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  const store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const worlds = new WorldLibrary(store, path.join(root, "worlds")),
    w = await worlds.importWorld(store.value.projects[0].id, "stale", source);
  const data = await worlds.read();
  delete data.worlds[0].embeddedPacks;
  await worlds.write(data);
  const listed = (await worlds.list(null, true)).worlds.find((item) => item.id === w.id);
  assert.equal(listed.packIssues.length, 1);
  assert.equal(listed.packIssues[0].packName, "stale");
});

test("world pack browser diagnoses health, edits a pack and rebinds UUIDs", async (t) => {
  const root = await temp(t),
    first = await putPack(root, "behavior", "first"),
    second = await putPack(root, "behavior", "second");
  second.manifest.dependencies = [{ uuid: first.ref.pack_id, version: [1, 0, 0] }];
  await fs.writeFile(path.join(second.dir, "manifest.json"), JSON.stringify(second.manifest));
  await lists(root, [first.ref, second.ref]);
  const plan = await inspectWorldPacks(root),
    health = await inspectWorldPackHealth(root, plan);
  assert.equal(health.summary.total, 2);
  assert.equal(health.ok, true);
  let nextPlan;
  await editWorldPack(root, plan, first.ref.pack_id, {
    name: "first-renamed",
    version: [2, 0, 1],
    enabled: true,
  }, async value => { nextPlan = value; });
  const edited = JSON.parse(await fs.readFile(path.join(first.dir, "manifest.json"), "utf8"));
  assert.equal(edited.header.name, "first-renamed");
  assert.deepEqual(edited.header.version, [2, 0, 1]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "world_resource_packs.json"), "utf8")), []);
  const rebound = await rewriteWorldPackUuids(root, nextPlan, first.ref.pack_id, async () => {});
  const reboundManifest = JSON.parse(await fs.readFile(path.join(first.dir, "manifest.json"), "utf8")),
    dependent = JSON.parse(await fs.readFile(path.join(second.dir, "manifest.json"), "utf8")),
    list = JSON.parse(await fs.readFile(path.join(root, "world_behavior_packs.json"), "utf8"));
  assert.notEqual(reboundManifest.header.uuid, first.ref.pack_id);
  assert.equal(dependent.dependencies[0].uuid, reboundManifest.header.uuid);
  assert.ok(list.some((entry) => entry.pack_id === reboundManifest.header.uuid));
  assert.equal(rebound.updated, 1);
  assert.equal((await inspectWorldPackHealth(root, rebound.plan)).ok, true);
});

test("editing preserves JSONC bytes and the opposite list; failure restores metadata", async t => {
  const root = await temp(t), b = await putPack(root, "behavior", "folder"), r = await putPack(root, "resource", "R");
  await lists(root, [b.ref], [r.ref]);
  const file = path.join(b.dir, "manifest.json"), list = path.join(root, "world_behavior_packs.json");
  const raw = "\uFEFF" + JSON.stringify(b.manifest, null, 4).replace(/\n/g, "\r\n").replace('"header": {', '"header": { /* 保留注释 */');
  await fs.writeFile(file, raw);
  await fs.writeFile(list, "\uFEFF[\r\n // 保留加载顺序\r\n " + JSON.stringify({...b.ref, custom: "keep"}) + "\r\n]");
  const plan = await inspectWorldPacks(root), beforeList = await fs.readFile(list, "utf8"), opposite = await fs.readFile(path.join(root, "world_resource_packs.json"));
  await assert.rejects(editWorldPack(root, plan, b.ref.pack_id, {name:"new name"}, async () => { throw Error("index failed"); }), /index failed/);
  assert.equal(await fs.readFile(file, "utf8"), raw);
  const rename = await editWorldPack(root, plan, b.ref.pack_id, {name:"new name"}, async () => {});
  assert.equal(await fs.readFile(file, "utf8"), raw.replace('"name": "folder"', '"name": "new name"'));
  assert.equal(await fs.readFile(list, "utf8"), beforeList);
  const result = await editWorldPack(root, plan, b.ref.pack_id, {enabled:false}, async () => {});
  assert.deepEqual(result.plan.behavior, []);
  assert.deepEqual(await fs.readFile(path.join(root, "world_resource_packs.json")), opposite);
  assert.notEqual(rename.backupPath, result.backupPath);
  const enabled = await editWorldPack(root, result.plan, b.ref.pack_id, {enabled:true}, async () => {});
  assert.deepEqual(enabled.plan.behavior, [b.ref]);
  assert.deepEqual(await fs.readFile(path.join(root, "world_resource_packs.json")), opposite);
  await assert.rejects(editWorldPack(root, plan, b.ref.pack_id, {enabled:"false"}, async()=>{}), /布尔/);
});

test("all UUID rebinds preserve disabled packs and module uniqueness and both manifest aliases", async t => {
  const root = await temp(t), b = await putPack(root, "behavior", "B"), r = await putPack(root, "resource", "R"),
    off = await putPack(root, "behavior", "disabled");
  b.manifest.dependencies = [{uuid:r.ref.pack_id, version:r.ref.version}, off.ref.pack_id];
  const original = JSON.stringify(b.manifest);
  await fs.writeFile(path.join(b.dir, "manifest.json"), original);
  await fs.writeFile(path.join(b.dir, "pack_manifest.json"), original);
  await lists(root, [b.ref], [r.ref]);
  const plan = await inspectWorldPacks(root), result = await rewriteWorldPackUuids(root, plan, undefined, async()=>{});
  const m = JSON.parse(await fs.readFile(path.join(b.dir, "manifest.json"), "utf8"));
  assert.equal(await fs.readFile(path.join(b.dir, "pack_manifest.json"), "utf8"), JSON.stringify(m));
  assert.equal(result.mapping.length, 6);
  assert.equal(new Set(result.mapping.map(x=>x.to)).size, 6);
  assert.equal(m.dependencies[0].uuid, result.plan.resource[0].pack_id);
  assert.equal(m.dependencies[1], result.mapping.find(x=>x.from===off.ref.pack_id).to);
  assert.equal(result.plan.behavior.length, 1);
  await prepareWorldPacks(root, result.plan, []);
});

test("pack services reject stale previews and running games; copies never edit their source", async t => {
  const root = await temp(t), source = path.join(root, "source"), b = await putPack(source, "behavior", "B");
  await lists(source, [b.ref]); await fs.writeFile(path.join(source, "level.dat"), levelData());
  const store = new WorkspaceStore(path.join(root, "app")); await store.load();
  const profiles = new Profiles(store); await profiles.initialize();
  let busy = false;
  const worlds = new WorldLibrary(store, path.join(root,"worlds"), {busy:()=>busy});
  const world = await worlds.importWorld(store.value.projects[0].id, "fixture", source);
  const report = await worlds.inspectPackHealth(world.id), file = path.join(worlds.location(world.id), "behavior_packs/B/manifest.json");
  await assert.rejects(worlds.rebindPackUuids(world.id, undefined, false, report.revision), /确认/);
  await fs.appendFile(file, " ");
  await assert.rejects(worlds.editPack(world.id,b.ref.pack_id,{name:"new"},true,report.revision), /变化/);
  const fresh = await worlds.inspectPackHealth(world.id); busy = true;
  await assert.rejects(worlds.editPack(world.id,b.ref.pack_id,{name:"new"},true,fresh.revision), /停止当前启动会话/);
  busy = false;
  await worlds.editPack(world.id,b.ref.pack_id,{name:"new"},true,fresh.revision);
  assert.equal(JSON.parse(await fs.readFile(path.join(b.dir,"manifest.json"),"utf8")).header.name,"B");
  assert.equal((await worlds.inspectPackHealth(world.id)).packs[0].name,"new");
});

test("health reports independent invalid manifests and duplicate IDs without hiding other packs", async t => {
  const root = await temp(t), b = await putPack(root,"behavior","B"), duplicate = await putPack(root,"behavior","duplicate",false,b.ref.pack_id);
  await putPack(root,"resource","R");
  await fs.mkdir(path.join(root,"behavior_packs/bad"));
  await fs.writeFile(path.join(root,"behavior_packs/bad/manifest.json"), "{broken");
  await lists(root,[b.ref]);
  const health = await inspectWorldPackHealth(root,{format:1,behavior:[b.ref],resource:[]});
  assert(health.issues.some(i=>i.code==="duplicate-pack-uuid"));
  assert(health.issues.some(i=>i.code==="invalid-manifest"));
  assert.equal(health.packs.length,3);
  assert(health.readOnlyReason);
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
  assert.equal(resolved[0].toolbox_source_path, a.dir);
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
      mods = await worlds.prepareWorldPacks(w.id, started.embeddedPacks, [], false, path.join(root, "runs", crypto.randomUUID()));
    assert.equal(
      mods[0].toolbox_source_path,
      path.join(worlds.location(w.id), "behavior_packs/A"),
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
    const script = path.join(activeRoot, "behavior_packs/B/main.py");
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
    await assert.rejects(fs.access(path.join(activeRoot, ".toolbox-packs")), {
      code: "ENOENT",
    });
    await fs.access(path.join(activeRoot, "behavior_packs/B"));
    await fs.access(path.join(activeRoot, "resource_packs/R"));
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
          path.join(
            dir,
            "world-packs/behavior_packs",
            bp.ref.pack_id.replaceAll("-", ""),
          ),
          path.join(
            dir,
            "world-packs/resource_packs",
            rp.ref.pack_id.replaceAll("-", ""),
          ),
        ],
      );
      assert.deepEqual(
        config.included_mod_dirs.map((x) => x.toolbox_source_path),
        [
          path.join(activeRoot, "behavior_packs/B"),
          path.join(activeRoot, "resource_packs/R"),
        ],
      );
      assert.equal(config.include_debug_mod, true);
      assert.equal(config.included_mod_dirs[0].toolbox_hot_reload, true);
      assert.equal(config.included_mod_dirs[0].hot_reload, false);
      assert.equal(config.included_mod_dirs[1].hot_reload, true);
      assert.equal(config.auto_hot_reload_mods, dir === snapshots[0]);
      if (dir === snapshots.at(-1))
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
    await fs.access(path.join(bp.dir, "pack_manifest.json"));
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
    prepareWorldPacks(root, plan, [], async () => false, path.join(root, "invalid")),
    /不能位于原存档/,
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
  await assert.rejects(prepareWorldPacks(root, plan, [], async () => false), /退出其他游戏/);
  await lists(root, [{ pack_id: crypto.randomUUID(), version: [1, 0, 0] }]);
  const prepared = await prepareWorldPacks(root, plan, []);
  assert.equal(prepared.length, 2);
  await assert.rejects(fs.access(path.join(root, ".toolbox-packs")), {
    code: "ENOENT",
  });
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
      x.toolbox_source_path.startsWith(exported) && !x.path.startsWith(exported),
    ),
  );
});

test("new launch restores legacy .toolbox-packs and stages packs outside the world", async (t) => {
  const root = await temp(t),
    pack = await putPack(root, "behavior", "legacy", true);
  await lists(root, [pack.ref]);
  const plan = await inspectWorldPacks(root),
    managedRoot = path.join(root, ".toolbox-packs");
  await fs.mkdir(managedRoot);
  await fs.writeFile(
    path.join(managedRoot, "pack-plan.json"),
    JSON.stringify(plan),
  );
  await fs.rename(
    path.join(root, "behavior_packs"),
    path.join(managedRoot, "behavior_packs"),
  );
  const run = path.join(path.dirname(root), path.basename(root) + "-launcher-run"),
    loaded = await prepareWorldPacks(root, plan, [], async () => true, run);
  assert.equal(
    loaded[0].path,
    path.join(run, "world-packs/behavior_packs", pack.ref.pack_id.replaceAll("-", "")),
  );
  assert.equal(
    loaded[0].toolbox_source_path,
    path.join(root, "behavior_packs/legacy"),
  );
  await fs.access(path.join(root, "behavior_packs/legacy/pack_manifest.json"));
  await assert.rejects(fs.access(managedRoot), { code: "ENOENT" });
  await fs.access(
    path.join(run, "pack-manifests", pack.ref.pack_id.replaceAll("-", "") + ".json"),
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
