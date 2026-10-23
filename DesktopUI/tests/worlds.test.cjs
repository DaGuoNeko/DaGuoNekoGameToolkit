const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  WorkspaceStore,
  Launcher,
  validateConfig,
} = require("../electron/services.cjs");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { folderFor, managedId } = require("../electron/world-path.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-world-test-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-world-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const store = new WorkspaceStore(path.join(root, "profile"));
  await store.load();
  await store.addProject(project);
  const id = store.value.projects[0].id;
  await fs.writeFile(
    path.join(project, ".mcdev.json"),
    '{\n // keep me\n "world_folder_name":"legacy", "world_name":"Old", "custom":{"unchanged":42}\n}',
  );
  const flags = { busy: false, game: false };
  const worlds = new WorldLibrary(store, path.join(root, "minecraftWorlds"), {
    busy: () => flags.busy,
    gameRunning: async () => flags.game,
  });
  return { root, project, store, id, worlds, flags };
}
test("world cards are isolated by project and selection preserves JSONC and unknown config fields", async (t) => {
  const { root, store, id, worlds } = await setup(t);
  assert.deepEqual((await worlds.list(id)).worlds, []);
  await assert.rejects(fs.stat(worlds.root), { code: "ENOENT" });
  const w = await worlds.create(id, {
    name: "Test 世界",
    seed: 42,
    worldType: 2,
    gameMode: 0,
  });
  assert.equal((await worlds.list(id)).worlds[0].ready, false);
  await assert.rejects(fs.stat(worlds.location(w.id)), { code: "ENOENT" });
  const before = await store.readProject(id),
    after = await worlds.select(id, w.id, before.revision);
  assert.equal(after.config.world_folder_name, folderFor(w.id));
  assert.equal(after.config.world_source_path, null);
  assert.equal(after.config.game_mode, 0);
  assert.equal(after.config.world_type, 2);
  assert.equal(after.config.reset_world, false);
  assert.match(after.raw, /keep me/);
  assert.equal(after.config.custom.unchanged, 42);
  await assert.rejects(worlds.select(id, w.id, before.revision), /外部/);
  const other = path.join(root, "other");
  await fs.mkdir(other);
  await store.addProject(other);
  const otherId = store.value.projects.find((p) => p.root === other).id;
  assert.equal((await worlds.list(otherId)).worlds.length, 0);
  await assert.rejects(worlds.rename(otherId, w.id, "bad"), /不属于/);
  await worlds.rename(id, w.id, "卡片新名");
  assert.equal((await worlds.list(id)).worlds[0].name, "卡片新名");
});
test("recycle/restore preserve bytes and block active games, path escapes and redirected directories", async (t) => {
  const { root, store, id, worlds, flags } = await setup(t);
  const w = await worlds.create(id, { name: "world" }),
    dir = worlds.location(w.id);
  await fs.mkdir(path.join(dir, "db"), { recursive: true });
  await fs.writeFile(path.join(dir, "level.dat"), "level fixture");
  await fs.writeFile(path.join(dir, "db", "progress"), "SAVE");
  flags.game = true;
  await assert.rejects(worlds.recycle(id, w.id, true), /游戏仍在运行/);
  flags.game = false;
  await assert.rejects(worlds.recycle(id, w.id, false), /确认/);
  await assert.rejects(worlds.recycle(id, "../legacy", true), /无效/);
  await worlds.recycle(id, w.id, true);
  assert.equal((await worlds.list(id)).worlds[0].deleted, true);
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(w.id, true), "db", "progress"),
      "utf8",
    ),
    "SAVE",
  );
  await assert.rejects(
    worlds.checkLaunch(id, {
      ...(await store.readProject(id)).config,
      world_folder_name: folderFor(w.id),
    }),
    /已删除/,
  );
  await worlds.restore(id, w.id);
  assert.equal(
    await fs.readFile(path.join(dir, "db", "progress"), "utf8"),
    "SAVE",
  );
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "original");
  const link = path.join(dir, "redirect");
  await fs.symlink(outside, link, "junction");
  await assert.rejects(worlds.recycle(id, w.id, true), /目录链接/);
  assert.equal(
    await fs.readFile(path.join(outside, "keep"), "utf8"),
    "original",
  );
  await fs.unlink(link);
  flags.busy = true;
  await assert.rejects(worlds.recycle(id, w.id, true), /停止/);
  flags.busy = false;
});
test("target-scoped mutation preserves active world while recycling/restoring/purging another", async (t) => {
  const { id, worlds, flags } = await setup(t);
  const active = await worlds.create(id, { name: "active" });
  const idle = await worlds.create(id, { name: "idle" });
  for (const w of [active, idle]) {
    await fs.mkdir(path.join(worlds.location(w.id), "db"), { recursive: true });
    await fs.writeFile(path.join(worlds.location(w.id), "level.dat"), w.id);
  }
  flags.busy = flags.game = true;
  worlds.mutationGuard = async (ids) => {
    if (ids.includes(active.id)) throw Error("该存档正在运行");
  };
  await assert.rejects(worlds.recycle(id, active.id, true), /正在运行/);
  await worlds.recycle(id, idle.id, true);
  await worlds.restore(id, idle.id);
  assert.equal(
    await fs.readFile(path.join(worlds.location(idle.id), "level.dat"), "utf8"),
    idle.id,
  );
  await worlds.recycle(id, idle.id, true);
  assert.deepEqual(await worlds.purge([idle.id], true), { deleted: 1 });
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(active.id), "level.dat"),
      "utf8",
    ),
    active.id,
  );
  assert.deepEqual(
    (await worlds.list()).worlds.map((w) => w.id),
    [active.id],
  );
});

test("copy imports legacy data without moving it; reset-disable and metadata conflicts require explicit handling", async (t) => {
  const { store, id, worlds } = await setup(t);
  const legacy = path.join(worlds.worldsRoot, "legacy");
  await fs.mkdir(path.join(legacy, "db"), { recursive: true });
  await fs.writeFile(path.join(legacy, "level.dat"), "legacy");
  await fs.writeFile(path.join(legacy, "db", "x"), "progress");
  let before = await store.readProject(id);
  const w = await worlds.copyCurrent(id, "副本", before.revision);
  assert.equal(
    await fs.readFile(path.join(legacy, "db", "x"), "utf8"),
    "progress",
  );
  assert.equal(
    await fs.readFile(path.join(worlds.location(w.id), "db", "x"), "utf8"),
    "progress",
  );
  before = await store.saveProject(id, before.revision, { reset_world: true });
  await assert.rejects(worlds.select(id, w.id, before.revision), /重建/);
  const selected = await worlds.select(id, w.id, before.revision, true);
  assert.equal(selected.config.reset_world, false);
  assert.equal(selected.config.world_source_path, "auto");
  const registry = await worlds.read();
  await fs.appendFile(worlds.file, " ");
  await assert.rejects(worlds.write(registry), /外部修改/);
  for (const folder of [
    "../escape",
    "DaGuoNekoGameToolkit/../x",
    "DaGuoNekoGameToolkit/w_bad",
    "C:/evil",
    "DaGuoNekoGameToolkit",
    "daguonekogametoolkit",
  ])
    assert.throws(
      () => validateConfig({ world_folder_name: folder }),
      /存档目录/,
    );
  assert.equal(managedId(folderFor(w.id)), w.id);
});
test("managed launch rejects attach mode before spawning or creating game data", async (t) => {
  const { root, store, id, worlds } = await setup(t);
  const w = await worlds.create(id, { name: "world" });
  let s = await worlds.select(id, w.id, (await store.readProject(id)).revision);
  const exe = path.join(root, "fake.exe");
  await fs.writeFile(exe, "test");
  s = await store.saveProject(id, s.revision, { game_executable_path: exe });
  let spawned = false;
  const launcher = new Launcher(store, exe, {
    worlds,
    detectRunning: async () => true,
    spawn: () => {
      spawned = true;
      throw Error("must not spawn");
    },
  });
  await assert.rejects(launcher.start(id, s.revision), /附加启动/);
  assert.equal(spawned, false);
  assert.equal(launcher.starting, false);
  await assert.rejects(fs.stat(worlds.location(w.id)), { code: "ENOENT" });
});

test("permanent deletion only removes confirmed recycled cards and their exact directories", async (t) => {
  const { id, worlds, store } = await setup(t);
  const live = await worlds.create(id, { name: "keep" });
  const recycled = await worlds.create(id, { name: "delete" });
  const empty = await worlds.create(id, { name: "never generated" });
  for (const w of [live, recycled]) {
    await fs.mkdir(path.join(worlds.location(w.id), "db"), { recursive: true });
    await fs.writeFile(path.join(worlds.location(w.id), "level.dat"), "LEVEL");
    await fs.writeFile(path.join(worlds.location(w.id), "db", "keep"), "SAVE");
  }
  const config = (await store.readProject(id)).raw;
  await worlds.recycle(id, recycled.id, true);
  await worlds.recycle(id, empty.id, true);
  const unknown = path.join(worlds.root, ".trash", "not-registered");
  await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, "keep"), "FOREIGN");
  await assert.rejects(worlds.purge([recycled.id], false), /确认/);
  await assert.rejects(
    worlds.purge([recycled.id, live.id], true),
    /只能永久删除/,
  );
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(recycled.id, true), "db", "keep"),
      "utf8",
    ),
    "SAVE",
  );
  assert.deepEqual(await worlds.purge([recycled.id, empty.id], true), {
    deleted: 2,
  });
  assert.deepEqual(
    (await worlds.list()).worlds.map((w) => w.id),
    [live.id],
  );
  await assert.rejects(fs.stat(worlds.location(recycled.id, true)), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(live.id), "db", "keep"),
      "utf8",
    ),
    "SAVE",
  );
  assert.equal(
    await fs.readFile(path.join(unknown, "keep"), "utf8"),
    "FOREIGN",
  );
  assert.equal((await store.readProject(id)).raw, config);
  await assert.rejects(worlds.purge([recycled.id], true), /不属于/);
});

test("purge blocks active sessions, invalid IDs, links and conflicting live data", async (t) => {
  const { root, id, worlds, flags } = await setup(t);
  const w = await worlds.create(id, { name: "world" });
  await worlds.recycle(id, w.id, true);
  flags.game = true;
  await assert.rejects(worlds.purge([w.id], true), /游戏仍在运行/);
  flags.game = false;
  flags.busy = true;
  await assert.rejects(worlds.purge([w.id], true), /停止/);
  flags.busy = false;
  for (const ids of [[], [w.id, w.id], ["../outside"], [".trash"], "all"])
    await assert.rejects(worlds.purge(ids, true), /无效/);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "keep"), "KEEP");
  const dir = worlds.location(w.id, true);
  await fs.symlink(outside, dir, "junction");
  await assert.rejects(worlds.purge([w.id], true), /重定向/);
  await fs.unlink(dir);
  await fs.mkdir(dir);
  await fs.symlink(outside, path.join(dir, "link"), "junction");
  await assert.rejects(worlds.purge([w.id], true), /目录链接/);
  await fs.unlink(path.join(dir, "link"));
  await fs.mkdir(worlds.location(w.id));
  await assert.rejects(worlds.purge([w.id], true), /同时存在/);
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "KEEP");
});

test("interrupted purge persists a non-restorable tombstone and can be retried after reopening", async (t) => {
  const { id, worlds, store } = await setup(t);
  const a = await worlds.create(id, { name: "first" });
  const b = await worlds.create(id, { name: "interrupted" });
  for (const w of [a, b]) {
    await fs.mkdir(worlds.location(w.id));
    await fs.writeFile(path.join(worlds.location(w.id), "level.dat"), "LEVEL");
    await worlds.recycle(id, w.id, true);
  }
  const original = fs.rm;
  const mocked = t.mock.method(fs, "rm", async function (target, opts) {
    if (target === worlds.location(b.id, true)) {
      await fs.unlink(path.join(target, "level.dat"));
      throw Error("simulated file lock");
    }
    return original(target, opts);
  });
  await assert.rejects(
    worlds.purge([a.id, b.id], true),
    /已永久删除 1.*simulated file lock/,
  );
  mocked.mock.restore();
  const reopened = new WorldLibrary(store, worlds.worldsRoot);
  const records = (await reopened.list()).worlds;
  assert.equal(records.length, 1);
  assert.equal(records[0].purging, true);
  await assert.rejects(reopened.restore(id, b.id), /不能恢复/);
  await assert.rejects(
    reopened.checkLaunch(id, { world_folder_name: folderFor(b.id) }),
    /已删除/,
  );
  await reopened.purge([b.id], true);
  assert.equal((await reopened.list()).worlds.length, 0);
});

test("purge does not delete data when its index marker cannot be persisted", async (t) => {
  const { id, worlds } = await setup(t);
  const w = await worlds.create(id, { name: "locked registry" });
  await fs.mkdir(worlds.location(w.id));
  await fs.writeFile(path.join(worlds.location(w.id), "level.dat"), "KEEP");
  await worlds.recycle(id, w.id, true);
  const mock = t.mock.method(worlds, "write", async () => {
    throw Error("index locked");
  });
  await assert.rejects(worlds.purge([w.id], true), /index locked/);
  mock.mock.restore();
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(w.id, true), "level.dat"),
      "utf8",
    ),
    "KEEP",
  );
  assert.equal((await worlds.read()).worlds[0].purging, undefined);
});

test("purge retries index removal after data deletion and retains newly recycled worlds outside confirmed IDs", async (t) => {
  const { id, worlds } = await setup(t);
  const w = await worlds.create(id, { name: "confirmed" });
  const later = await worlds.create(id, { name: "recycled later" });
  await fs.mkdir(worlds.location(w.id));
  await fs.writeFile(path.join(worlds.location(w.id), "level.dat"), "DATA");
  await worlds.recycle(id, w.id, true);
  const confirmed = [w.id];
  await worlds.recycle(id, later.id, true);
  const write = worlds.write.bind(worlds);
  let writes = 0;
  const mock = t.mock.method(worlds, "write", async (data) => {
    if (++writes === 2) throw Error("index finalization failed");
    return write(data);
  });
  await assert.rejects(
    worlds.purge(confirmed, true),
    /index finalization failed/,
  );
  mock.mock.restore();
  await assert.rejects(fs.stat(worlds.location(w.id, true)), {
    code: "ENOENT",
  });
  assert.equal(
    (await worlds.list()).worlds.find((x) => x.id === w.id).purging,
    true,
  );
  await worlds.purge(confirmed, true);
  assert.deepEqual(
    (await worlds.list()).worlds.map((x) => x.id),
    [later.id],
  );
});
