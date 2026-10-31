const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { AUTO_IMPORT_PROFILE } = require("../shared/world-import-model.cjs");
const { levelData } = require("./fixtures/zip.cjs");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-auto-profiles-"));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(path.join(root, "app"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "db"), { recursive: true });
  await fs.writeFile(path.join(source, "level.dat"), levelData());
  await fs.writeFile(path.join(source, "db", "progress"), "KEEP");
  const busy = new Set();
  const worlds = new WorldLibrary(store, path.join(root, "worlds"), {
    profiles,
    profileInUse: (id) => busy.has(id),
    createImportProfile: (name, worldId) => profiles.createAutomatic(name + "（自动匹配）", worldId),
  });
  return { root, store, profiles, source, worlds, busy };
}

test("automatic profile follows world recycle/restore/purge while config files and linked source survive", async (t) => {
  const f = await setup(t);
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "自动地图", f.source, "linked");
  const before = await f.profiles.read(w.profileId);
  await f.worlds.recycle(null, w.id, true);
  assert(!f.store.value.projects.some(p => p.id === w.profileId));
  assert.equal(f.store.value.recycledProfiles[0].id, w.profileId);
  await f.worlds.restore(w.profileId, w.id);
  assert.equal((await f.profiles.read(w.profileId)).raw, before.raw);
  await f.worlds.recycle(null, w.id, true);
  await f.worlds.purge([w.id], true);
  assert(!f.store.value.projects.some(p => p.id === w.profileId));
  assert.equal(f.store.value.recycledProfiles.length, 0);
  assert.equal(await fs.readFile(before.file, "utf8"), before.raw);
  assert.equal(await fs.readFile(path.join(f.source, "db", "progress"), "utf8"), "KEEP");
});

test("shared automatic profile is kept until the last reference, and any recycled world can restore it", async (t) => {
  const f = await setup(t);
  const owner = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "owner", f.source);
  const shared = await f.worlds.create(owner.profileId, { name: "shared" });
  await f.worlds.recycle(null, owner.id, true);
  assert(f.store.value.projects.some(p => p.id === owner.profileId));
  await f.worlds.recycle(null, shared.id, true);
  assert(!f.store.value.projects.some(p => p.id === owner.profileId));
  await f.worlds.purge([owner.id], true);
  assert.equal(f.store.value.recycledProfiles[0].id, owner.profileId);
  await f.worlds.restore(owner.profileId, shared.id);
  assert(f.store.value.projects.some(p => p.id === owner.profileId));
  await f.worlds.recycle(null, shared.id, true);
  await f.worlds.purge([shared.id], true);
  assert.equal(f.store.value.recycledProfiles.length, 0);
});

test("rebinding removes only unused pristine automatic registrations; manual copies and edited profiles survive", async (t) => {
  const f = await setup(t);
  const manual = await f.profiles.create("手动自动匹配（自动匹配）");
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "rebind", f.source);
  const copy = await f.profiles.create("manual copy", w.profileId);
  await f.worlds.update(w.id, { profileId: manual.project.id });
  assert(!f.store.value.projects.some(p => p.id === w.profileId));
  assert(f.store.value.projects.some(p => p.id === copy.project.id));
  assert(!f.store.project(copy.project.id).automaticImport);
  await f.worlds.recycle(null, w.id, true);
  await f.worlds.purge([w.id], true);
  assert(f.store.value.projects.some(p => p.id === manual.project.id));
  for (const edit of ["save", "rename", "external"]) {
    const world = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, edit, f.source);
    const snapshot = await f.profiles.read(world.profileId);
    if (edit === "save") await f.profiles.save(world.profileId, snapshot.revision, { user_name: "KeepMe" });
    if (edit === "rename") await f.profiles.rename(world.profileId, "用户命名");
    if (edit === "external") await fs.appendFile(snapshot.file, "\n// external change\n");
    const expected = await fs.readFile(snapshot.file, "utf8");
    await f.worlds.recycle(null, world.id, true);
    await f.worlds.purge([world.id], true);
    assert.equal((await f.profiles.read(world.profileId)).raw, expected);
  }
});

test("running menu profiles are preserved and a later recycle retry finishes cleanup", async (t) => {
  const f = await setup(t);
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "running", f.source);
  f.busy.add(w.profileId);
  await f.worlds.recycle(null, w.id, true);
  assert(f.store.value.projects.some(p => p.id === w.profileId));
  f.busy.clear();
  await f.worlds.recycle(null, w.id, true);
  assert(!f.store.value.projects.some(p => p.id === w.profileId));
});
test("reconciliation avoids process probes for unchanged active or archived profiles", async (t) => {
  const f = await setup(t);
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "probe", f.source);
  const probe = t.mock.fn(() => false);
  await f.profiles.reconcileAutomatic((await f.worlds.list()).worlds, probe);
  assert.equal(probe.mock.callCount(), 0);
  await f.worlds.recycle(null, w.id, true);
  await f.profiles.reconcileAutomatic((await f.worlds.list()).worlds, probe);
  assert.equal(probe.mock.callCount(), 0);
});

test("a failed final import write retains provenance so its partial world can remove the generated profile", async (t) => {
  const f = await setup(t);
  const write = f.worlds.write.bind(f.worlds);
  let failed = false;
  const fault = t.mock.method(f.worlds, "write", async data => {
    if (!failed && data.worlds.some(w => !w.copying)) { failed = true; throw Error("final index unavailable"); }
    return write(data);
  });
  await assert.rejects(f.worlds.importWorld(AUTO_IMPORT_PROFILE, "partial", f.source), /final index unavailable/);
  fault.mock.restore();
  const partial = (await f.worlds.list()).worlds[0];
  const p = f.store.value.projects.find(p => p.automaticImport?.worldId === partial.id);
  assert(p);
  assert(partial.copying);
  await f.worlds.recycle(null, partial.id, true);
  assert(!f.store.value.projects.some(x => x.id === p.id));
  await f.worlds.purge([partial.id], true);
  assert(!f.store.value.recycledProfiles.some(x => x.id === p.id));
});

test("profile-index failures after world mutations remain retryable without losing archive metadata", async (t) => {
  const f = await setup(t);
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "retry", f.source);
  const fault = () => t.mock.method(f.store, "mutate", async () => { throw Error("profile index locked"); });
  let failure = fault();
  await assert.rejects(f.worlds.recycle(null, w.id, true), /profile index locked/);
  failure.mock.restore();
  assert((await f.worlds.list()).worlds[0].deleted);
  assert(f.store.value.projects.some(p => p.id === w.profileId));
  await f.worlds.recycle(null, w.id, true);
  failure = fault();
  await assert.rejects(f.worlds.restore(null, w.id), /profile index locked/);
  failure.mock.restore();
  await f.worlds.restore(null, w.id);
  assert(f.store.value.projects.some(p => p.id === w.profileId));
  await f.worlds.recycle(null, w.id, true);
  failure = fault();
  await assert.rejects(f.worlds.purge([w.id], true), /profile index locked/);
  failure.mock.restore();
  assert.equal((await f.worlds.list()).worlds.length, 0);
  assert(f.store.value.recycledProfiles.some(p => p.id === w.profileId));
  await f.profiles.reconcileAutomatic([], () => false);
  assert.equal((await f.worlds.list()).worlds.length, 0);
  assert.equal(f.store.value.projects.some(p => p.id === w.profileId), false);
});

test("reopening retains archived profiles and repairs an interrupted recycle, preserving unknown legacy origins", async (t) => {
  const f = await setup(t);
  const w = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "reopen", f.source);
  const legacy = await f.profiles.create("旧地图（自动匹配）");
  const legacyWorld = await f.worlds.importWorld(legacy.project.id, "旧地图", f.source);
  await f.worlds.recycle(null, legacyWorld.id, true);
  assert(f.store.value.projects.some(p => p.id === legacy.project.id));
  const fail = t.mock.method(f.store, "mutate", async () => { throw Error("interrupted"); });
  await assert.rejects(f.worlds.recycle(null, w.id, true), /interrupted/);
  fail.mock.restore();
  const store = new WorkspaceStore(path.dirname(f.store.file));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  const worlds = new WorldLibrary(store, f.worlds.worldsRoot, { profiles });
  await worlds.migrateProfiles();
  assert(!store.value.projects.some(p => p.id === w.profileId));
  assert.equal(store.value.recycledProfiles[0].id, w.profileId);
  await fs.appendFile(path.join(store.value.recycledProfiles[0].root, ".mcdev.json"), "\n// recovered user edit\n");
  await worlds.restore(w.profileId, w.id);
  assert.match((await profiles.read(w.profileId)).raw, /recovered user edit/);
});

test("cloning an imported world records an independent automatic owner", async (t) => {
  const f = await setup(t);
  const original = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "original", f.source);
  const clone = await f.worlds.importWorld(AUTO_IMPORT_PROFILE, "clone", undefined, "copy", original.id);
  assert.notEqual(original.profileId, clone.profileId);
  assert.equal(f.store.project(clone.profileId).automaticImport.worldId, clone.id);
  await f.worlds.recycle(null, clone.id, true);
  await f.worlds.purge([clone.id], true);
  assert(f.store.value.projects.some(p => p.id === original.profileId));
  assert(!f.store.value.projects.some(p => p.id === clone.profileId));
});
