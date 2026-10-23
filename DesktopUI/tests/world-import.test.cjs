const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { WorldLibrary } = require("../electron/worlds.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/profiles.cjs");
const { zip, levelData } = require("./fixtures/zip.cjs");
const { folderFor } = require("../electron/world-path.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-world-import-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-world-import-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const flags = { game: false },
    worlds = new WorldLibrary(store, path.join(root, "game/minecraftWorlds"), {
      gameRunning: async () => flags.game,
    });
  return { root, store, worlds, flags, id: store.value.projects[0].id };
}

test("linked directories use the same files on both sides and recycle/purge never delete the source", async (t) => {
  const { root, store, worlds, id } = await setup(t);
  const source = path.join(root, "编辑中的地图");
  await fs.mkdir(path.join(source, "db"), { recursive: true });
  await fs.writeFile(path.join(source, "level.dat"), levelData("Linked room"));
  await fs.writeFile(path.join(source, "db/progress"), "original");
  const original = (await store.readProject(id)).raw;
  const w = await worlds.importWorld(id, "direct", source, "linked");
  assert.equal((await worlds.list()).worlds[0].path, source);
  assert.equal(await worlds.openPath(null, w.id), source);
  await assert.rejects(fs.lstat(worlds.location(w.id)), { code: "ENOENT" });
  const config = {
    world_folder_name: folderFor(w.id),
    reset_world: false,
    world_source_path: null,
  };
  await assert.rejects(
    worlds.checkLaunch(id, { ...config, reset_world: true }),
    /禁止重建/,
  );
  await assert.rejects(
    worlds.checkLaunch(id, { ...config, world_source_path: source }),
    /禁止重建/,
  );
  await worlds.checkLaunch(id, config);
  assert((await fs.lstat(worlds.location(w.id))).isSymbolicLink());
  assert.equal(
    await fs.realpath(worlds.location(w.id)),
    await fs.realpath(source),
  );
  await fs.writeFile(path.join(source, "db/progress"), "edited externally");
  assert.equal(
    await fs.readFile(path.join(worlds.location(w.id), "db/progress"), "utf8"),
    "edited externally",
  );
  await fs.writeFile(
    path.join(worlds.location(w.id), "db/progress"),
    "game save",
  );
  assert.equal(
    await fs.readFile(path.join(source, "db/progress"), "utf8"),
    "game save",
  );
  const { readJoinRoom } = require("../electron/client-join-room.cjs");
  assert.equal(
    (await readJoinRoom(worlds, w.id)).source,
    "level.dat/LevelName",
  );
  await assert.rejects(
    worlds.importWorld(id, "duplicate", source, "linked"),
    /已经登记/,
  );
  await worlds.recycle(null, w.id, true);
  await assert.rejects(fs.lstat(worlds.location(w.id)), { code: "ENOENT" });
  await assert.rejects(
    worlds.importWorld(id, "duplicate", source, "linked"),
    /已经登记/,
  );
  await worlds.restore(null, w.id);
  await worlds.checkLaunch(id, config);
  await worlds.recycle(null, w.id, true);
  await worlds.purge([w.id], true);
  assert.equal((await worlds.list()).worlds.length, 0);
  assert.equal(
    await fs.readFile(path.join(source, "db/progress"), "utf8"),
    "game save",
  );
  assert.equal((await store.readProject(id)).raw, original);
});

test("missing linked sources cannot be recreated by launch, but their cards can be removed", async (t) => {
  const { root, worlds, id } = await setup(t),
    source = path.join(root, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  const w = await worlds.importWorld(id, "direct", source, "linked");
  const config = { world_folder_name: folderFor(w.id) };
  await worlds.checkLaunch(id, config);
  await fs.rename(source, source + "-moved");
  await assert.rejects(worlds.checkLaunch(id, config), /原存档目录不存在/);
  await assert.rejects(worlds.launchWorld(w.id, id), /原存档目录不存在/);
  await worlds.recycle(null, w.id, true);
  await assert.rejects(worlds.restore(null, w.id), /原存档目录不存在/);
  await worlds.purge([w.id], true);
  await fs.access(path.join(source + "-moved", "level.dat"));
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
});

test("linked launch and deletion reject substituted mounts and descendant links", async (t) => {
  const { root, worlds, id } = await setup(t),
    source = path.join(root, "source"),
    other = path.join(root, "other");
  for (const dir of [source, other]) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "level.dat"), levelData());
  }
  const w = await worlds.importWorld(id, "direct", source, "linked");
  await fs.symlink(other, worlds.location(w.id), "junction");
  await assert.rejects(
    worlds.checkLaunch(id, { world_folder_name: folderFor(w.id) }),
    /运行入口已被替换/,
  );
  await assert.rejects(worlds.recycle(null, w.id, true), /运行入口已被替换/);
  await fs.unlink(worlds.location(w.id));
  await fs.symlink(other, path.join(source, "injected"), "junction");
  await assert.rejects(
    worlds.checkLaunch(id, { world_folder_name: folderFor(w.id) }),
    /含目录链接/,
  );
  await fs.unlink(path.join(source, "injected"));
  await worlds.recycle(null, w.id, true);
  await worlds.purge([w.id], true);
  await fs.access(path.join(other, "level.dat"));
  await fs.access(path.join(source, "level.dat"));
});
test("imports an external folder and wrapped ZIP as independent cards without changing sources or profiles", async (t) => {
  const { root, store, worlds, id } = await setup(t);
  const source = path.join(root, "Downloads", "folder");
  await fs.mkdir(path.join(source, "db"), { recursive: true });
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  await fs.writeFile(path.join(source, "db/progress"), "SAVE");
  const profile = (await store.readProject(id)).raw;
  const first = await worlds.importWorld(id, "folder copy", source);
  assert.equal(first.options.keep_inventory, false);
  const file = path.join(root, "world.zip"),
    bytes = zip([
      { name: "wrapper/世界/level.dat", data: levelData() },
      { name: "wrapper/世界/db/progress", data: "ZIP_SAVE" },
      { name: "wrapper/readme.txt", data: "not world data" },
    ]);
  await fs.writeFile(file, bytes);
  const second = await worlds.importWorld(id, "zip copy", file);
  assert.notEqual(second.id, first.id);
  assert.equal(second.options.keep_inventory, false);
  assert.equal(
    await fs.readFile(
      path.join(worlds.location(second.id), "db/progress"),
      "utf8",
    ),
    "ZIP_SAVE",
  );
  await assert.rejects(
    fs.stat(path.join(worlds.location(second.id), "wrapper")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(
    await fs.readFile(path.join(source, "db/progress"), "utf8"),
    "SAVE",
  );
  assert.equal((await store.readProject(id)).raw, profile);
  await worlds.checkLaunch(id, { world_folder_name: folderFor(second.id) });
});
test("root ZIPs with leading dot folders work and ambiguous or missing worlds are rejected before registration", async (t) => {
  const { root, worlds, id } = await setup(t);
  const file = path.join(root, "world.zip");
  await fs.writeFile(
    file,
    zip([
      { name: "./", attributes: (0x41ed << 16) >>> 0 },
      { name: "./level.dat", data: levelData() },
      { name: "./db/a", data: "A" },
    ]),
  );
  await worlds.importWorld(id, "root", file);
  for (const entries of [
    [{ name: "readme", data: "nothing" }],
    [
      { name: "one/level.dat", data: levelData() },
      { name: "two/level.dat", data: levelData() },
    ],
  ]) {
    await fs.writeFile(file, zip(entries));
    await assert.rejects(
      worlds.importWorld(id, "bad", file),
      /没有找到|多个存档/,
    );
  }
  assert.equal((await worlds.list()).worlds.length, 1);
});
test("ZIP traversal, aliases, links, encryption, duplicates and oversized output cannot write outside the new world", async (t) => {
  const { root, worlds, id } = await setup(t);
  const file = path.join(root, "bad.zip");
  const bad = [
    { name: "../escape" },
    { name: "/absolute" },
    { name: "C:/escape" },
    { name: "world/CON.txt" },
    { name: "world/CON .txt" },
    { name: "world/CONOUT$" },
    { name: "world/data:stream" },
    { name: "world/end." },
    { name: "world/link", attributes: (0xa1ff << 16) >>> 0 },
    { name: "world/secret", flags: 0x801 },
    { name: "world/huge", size: 0x80000001 },
  ];
  for (const item of bad) {
    await fs.writeFile(
      file,
      zip([{ name: "world/level.dat", data: levelData() }, item]),
    );
    await assert.rejects(worlds.importWorld(id, "bad", file));
  }
  for (const pair of [
    [{ name: "world/db/a" }, { name: "world/db/A" }],
    [{ name: "world/db" }, { name: "world/db/a" }],
  ]) {
    await fs.writeFile(
      file,
      zip([{ name: "world/level.dat", data: levelData() }, ...pair]),
    );
    await assert.rejects(worlds.importWorld(id, "bad", file), /冲突/);
  }
  await fs.writeFile(
    file,
    zip([
      { name: "level.dat", data: levelData() },
      ...Array.from({ length: 5 }, (_, i) => ({
        name: "db/" + i,
        data: "x",
        size: 2 * 1024 ** 3,
      })),
    ]),
  );
  await assert.rejects(worlds.importWorld(id, "bomb", file), /8 GiB/);
  assert.equal((await worlds.list()).worlds.length, 0);
  await assert.rejects(fs.stat(path.join(root, "escape")), { code: "ENOENT" });
});
test("CRC failure preserves an unlaunchable partial card; active games and managed-library source folders are refused", async (t) => {
  const { root, worlds, id, flags } = await setup(t);
  const file = path.join(root, "broken.zip");
  await fs.writeFile(
    file,
    zip([
      { name: "level.dat", data: levelData() },
      { name: "db/progress", data: "bad", crc: 0 },
    ]),
  );
  flags.game = true;
  await assert.rejects(worlds.importWorld(id, "broken", file), /游戏仍在运行/);
  flags.game = false;
  await assert.rejects(worlds.importWorld(id, "broken", file), /未完成.*CRC/);
  const record = (await worlds.list()).worlds[0];
  assert.equal(record.copying, true);
  await assert.rejects(
    worlds.checkLaunch(id, { world_folder_name: folderFor(record.id) }),
    /未复制完成/,
  );
  await assert.rejects(
    worlds.importWorld(id, "self", worlds.location(record.id)),
    /存档库/,
  );
  await assert.rejects(
    worlds.importWorld(id, "parent", worlds.worldsRoot),
    /存档库/,
  );
  await worlds.recycle(id, record.id, true);
  await worlds.purge([record.id], true);
  await fs.rename(file, file + ".moved"); // The failed import released the source ZIP handle.
});
