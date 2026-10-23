const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { ModLibrary } = require("../electron/domains/profiles/mod-library.cjs");
const { modRows, setModOption } = require("../shared/mod-selection.cjs");
const { modKey, withoutMod, removeModJson } = require("../shared/mod-removal.cjs");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mod-library-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-mod-library-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(path.join(root, "data"));
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  return { root, store, profiles, library: new ModLibrary(store, profiles) };
}
test("library seeds without edits, then removal clears relative, disabled and duplicate references from every profile", async (t) => {
  const { root, store, profiles, library } = await setup(t);
  const folder = path.join(root, "shared");
  await fs.mkdir(folder);
  const first = await profiles.read(store.value.projects[0].id);
  const raw = JSON.stringify({
    included_mod_dirs: [
      path.relative(first.project.root, folder),
      { path: folder.toUpperCase(), enabled: false, hot_reload: false },
    ],
    unknown: { keep: 42 },
  });
  await profiles.save(first.project.id, first.revision, undefined, raw);
  const second = await profiles.create("other", first.project.id);
  const before = await Promise.all(
    store.value.projects.map((p) =>
      fs.readFile(path.join(p.root, ".mcdev.json"), "utf8"),
    ),
  );
  const value = await library.list();
  // Copied profiles keep their baseDirectory, so both relative paths match.
  assert.equal(value.mods.length, 1);
  assert.equal(value.mods[0].path, folder);
  assert.equal(value.mods[0].available, true);
  assert.deepEqual(
    await Promise.all(
      store.value.projects.map((p) =>
        fs.readFile(path.join(p.root, ".mcdev.json"), "utf8"),
      ),
    ),
    before,
  );
  const empty = await library.remove(value.mods[0].id, value.revision);
  assert.equal(empty.mods.length, 0);
  assert.equal(empty.changes.length, 2);
  assert.equal(empty.removedReferences, 4);
  assert.equal((await new ModLibrary(store, profiles).list()).mods.length, 0);
  const imported = await library.importProfiles(empty.revision);
  assert.equal(imported.added, 0);
  assert.equal((await library.importProfiles(imported.revision)).added, 0);
  for (const p of store.value.projects) {
    const updated = await profiles.read(p.id);
    assert.deepEqual(updated.config.included_mod_dirs, []);
    assert.equal(JSON.parse(updated.raw).unknown.keep, 42);
  }
  assert(second.config);
});

async function removalFixture(t) {
  const h = await setup(t);
  const target = path.join(h.root, "remove"),
    other = path.join(h.root, "retain");
  await fs.mkdir(target);
  await fs.mkdir(other);
  const a = await h.profiles.read(h.store.value.projects[0].id);
  await h.profiles.save(
    a.project.id,
    a.revision,
    undefined,
    `{// preserve\n"included_mod_dirs":[${JSON.stringify(target)},{"path":${JSON.stringify(other)},"enabled":false,"custom":7}],"unknown":"KEEP"}`,
  );
  const b = await h.profiles.create("second", a.project.id);
  const catalog = await h.library.list();
  return {
    ...h,
    a: await h.profiles.read(a.project.id),
    b,
    target,
    other,
    catalog,
    mod: catalog.mods.find((m) => m.path === target),
  };
}
test("JSONC removal handles compact last entries, all subsets, separator comments, trailing commas and BOM", () => {
  const jsonc = require("jsonc-parser");
  const entries = [
    "C:/one",
    { path: "C:/two", custom: 7 },
    "C:/three",
    "C:/four",
  ];
  for (const layout of [0, 1, 2])
    for (let mask = 0; mask < 16; mask++) {
      const array = entries
        .map(JSON.stringify)
        .join(layout === 0 ? "," : ", /* separator, ] */\n");
      const raw =
        (layout === 2 ? "\uFEFF" : "") +
        `{// header\n"included_mod_dirs":[${array}${layout === 2 ? "," : ""}],"unknown":99}`;
      const targets = new Set(
        entries
          .filter((_, i) => (mask >> i) & 1)
          .map((v) => (typeof v === "string" ? v : v.path)),
      );
      const result = removeModJson(raw, (value) => targets.has(value));
      const errors = [],
        parsed = jsonc.parse(result.replace(/^\uFEFF/, ""), errors, {
          allowTrailingComma: true,
        });
      assert.deepEqual(errors, []);
      assert.deepEqual(
        parsed.included_mod_dirs,
        entries.filter((_, i) => !((mask >> i) & 1)),
      );
      assert.equal(parsed.unknown, 99);
      assert.match(result, /header/);
      if (layout) assert.equal(result.split("/* separator, ] */").length, 4);
      if (layout === 2) assert(result.startsWith("\uFEFF"));
    }
  assert.throws(
    () =>
      removeModJson(
        '{"included_mod_dirs":["a"],"included_mod_dirs":["b"]}',
        () => true,
      ),
    /重复/,
  );
});
test("preflight failures and stale catalog revisions do not change any profile", async (t) => {
  const h = await removalFixture(t);
  await assert.rejects(h.library.remove(h.mod.id, "stale"), /已变化/);
  assert.equal((await h.profiles.read(h.a.project.id)).raw, h.a.raw);
  await fs.writeFile(h.b.file, "BROKEN");
  await assert.rejects(
    h.library.remove(h.mod.id, h.catalog.revision),
    /second/,
  );
  assert.equal((await h.profiles.read(h.a.project.id)).raw, h.a.raw);
  assert((await h.library.list()).mods.some((m) => m.id === h.mod.id));
});
test("partial write failure retains the catalog entry and reports cleaned profiles; retry completes without restoring removed references", async (t) => {
  const h = await removalFixture(t),
    original = h.store.writeProject.bind(h.store);
  h.store.writeProject = async (id, ...args) => {
    if (id === h.b.project.id) throw Error("fixture read-only config");
    return original(id, ...args);
  };
  await assert.rejects(
    h.library.remove(h.mod.id, h.catalog.revision),
    /已清理 1 套配置/,
  );
  assert((await h.library.list()).mods.some((m) => m.id === h.mod.id));
  assert.deepEqual(
    (await h.profiles.read(h.a.project.id)).config.included_mod_dirs,
    [{ path: h.other, enabled: false, custom: 7 }],
  );
  assert.equal((await h.profiles.read(h.b.project.id)).raw, h.b.raw);
  h.store.writeProject = original;
  const done = await h.library.remove(h.mod.id, h.catalog.revision);
  assert.equal(done.removedReferences, 1);
  assert.match((await h.profiles.read(h.a.project.id)).raw, /preserve/);
  assert.equal((await h.library.importProfiles(done.revision)).added, 0);
});
test("external edits are preserved and queued stale draft saves cannot resurrect removed entries", async (t) => {
  const h = await removalFixture(t),
    original = h.store.writeProject.bind(h.store);
  let inserted = false;
  h.store.writeProject = async (id, ...args) => {
    if (!inserted) {
      inserted = true;
      await fs.appendFile(h.a.file, "\n// external");
    }
    return original(id, ...args);
  };
  await assert.rejects(
    h.library.remove(h.mod.id, h.catalog.revision),
    /已清理 0/,
  );
  assert.match(await fs.readFile(h.a.file, "utf8"), /external/);
  h.store.writeProject = original;
  const stale = await h.profiles.read(h.a.project.id);
  const removal = h.library.remove(h.mod.id, h.catalog.revision);
  // Let removal acquire the profiles queue before submitting an old editor save.
  await new Promise((r) => setImmediate(r));
  const save = h.profiles.save(stale.project.id, stale.revision, {
    included_mod_dirs: stale.config.included_mod_dirs,
  });
  const results = await Promise.allSettled([removal, save]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.deepEqual(
    (await h.profiles.read(stale.project.id)).config.included_mod_dirs,
    [{ path: h.other, enabled: false, custom: 7 }],
  );
});
test("draft cleanup matches Windows paths, retains other entries and JSONC, and rejects invalid JSON", () => {
  for (const [base, value] of [
    ["C:\\profiles\\a", "..\\mods\\one"],
    ["C:\\profiles", "C:/mods/./one/"],
    ["\\\\server\\share\\profiles", "..\\mods"],
    ["\\\\server\\share\\profiles", "\\mods"],
    ["C:\\profiles", "C:mods"],
  ])
    assert.equal(modKey(value, base), modKey(path.win32.resolve(base, value)));
  const entries = [
    "../mods",
    { path: "C:/MODS/", enabled: false },
    { path: "C:/mods/child", custom: 7 },
  ];
  assert.deepEqual(withoutMod(entries, "C:/profiles", "C:/mods"), [entries[2]]);
  const raw = `{// KEEP\n"user_name":"draft","included_mod_dirs":${JSON.stringify(entries)},"custom":{"keep":1}}`;
  const clean = removeModJson(
    raw,
    (value) => modKey(value, "C:/profiles") === modKey("C:/mods"),
  );
  assert.match(clean, /KEEP/);
  const parsed = require("jsonc-parser").parse(clean);
  assert.deepEqual(parsed.included_mod_dirs, [entries[2]]);
  assert.equal(parsed.user_name, "draft");
  assert.equal(parsed.custom.keep, 1);
  assert.throws(
    () => removeModJson('{"included_mod_dirs":[', () => true),
    /JSON/,
  );
});

test("folder opening resolves registered library entries and saved profile-only paths without accepting arbitrary targets", async (t) => {
  const { root, store, profiles, library } = await setup(t);
  const dir = path.join(root, "module");
  await fs.mkdir(dir);
  const initial = await library.list(),
    saved = await library.save({
      name: "module",
      directory: dir,
      revision: initial.revision,
    });
  assert.equal(await library.folder({ id: saved.mods[0].id }), dir);
  await assert.rejects(library.folder({ id: "missing" }), /移除/);
  const profile = await profiles.read(store.value.projects[0].id);
  await profiles.save(profile.project.id, profile.revision, {
    included_mod_dirs: [dir],
  });
  assert.equal(
    await library.folder({
      profileId: profile.project.id,
      index: 0,
      expectedPath: dir,
    }),
    dir,
  );
  await assert.rejects(
    library.folder({
      profileId: profile.project.id,
      index: 0,
      expectedPath: root,
    }),
    /已变化/,
  );
  await assert.rejects(
    library.folder({
      profileId: profile.project.id,
      index: 3,
      expectedPath: dir,
    }),
    /已变化/,
  );
});
test("library CRUD persists separately, rejects stale and duplicate edits, and preserves files on removal", async (t) => {
  const { root, store, profiles, library } = await setup(t);
  const folder = path.join(root, "mod");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "keep.py"), "KEEP");
  const initial = await library.list();
  let value = await library.save({
    name: "测试模组",
    directory: folder,
    revision: initial.revision,
  });
  const id = value.mods[0].id;
  await assert.rejects(
    library.save({
      id,
      name: "stale",
      directory: folder,
      revision: initial.revision,
    }),
    /变化/,
  );
  await assert.rejects(
    library.save({
      name: "duplicate",
      directory: folder.toUpperCase() + path.sep,
      revision: value.revision,
    }),
    /已经在/,
  );
  value = await library.save({
    id,
    name: "新名称",
    directory: folder,
    revision: value.revision,
  });
  assert.equal(
    (await new ModLibrary(store, profiles).list()).mods[0].name,
    "新名称",
  );
  await assert.rejects(
    library.save({
      name: "relative",
      directory: "../x",
      revision: value.revision,
    }),
    /绝对目录/,
  );
  await library.remove(id, value.revision);
  assert.equal(await fs.readFile(path.join(folder, "keep.py"), "utf8"), "KEEP");
  await fs.stat(library.file + ".bak");
});
test("catalog corruption is retained and unavailable imported paths stay visible without rewriting profiles", async (t) => {
  const { root, store, profiles, library } = await setup(t);
  const p = await profiles.read(store.value.projects[0].id);
  await profiles.save(p.project.id, p.revision, {
    included_mod_dirs: [path.join(root, "missing")],
  });
  const value = await library.list();
  assert.equal(value.mods[0].available, false);
  await fs.writeFile(library.file, "BROKEN");
  await assert.rejects(library.list(), /损坏/);
  assert.equal(await fs.readFile(library.file, "utf8"), "BROKEN");
});
test("external and simultaneous library edits cannot silently overwrite each other", async (t) => {
  const { root, library } = await setup(t);
  const a = path.join(root, "a"),
    b = path.join(root, "b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const initial = await library.list();
  const result = await Promise.allSettled([
    library.save({ name: "a", directory: a, revision: initial.revision }),
    library.save({ name: "b", directory: b, revision: initial.revision }),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const value = await library.list();
  await fs.appendFile(library.file, " ");
  await assert.rejects(
    library.remove(value.mods[0].id, value.revision),
    /变化/,
  );
  assert.equal((await library.list()).mods.length, 1);
});
test("quick selection preserves duplicates, original relative strings, custom flags and independent hot reload", () => {
  const entries = [
    "../shared",
    {
      path: "C:/mods/shared",
      enabled: false,
      hot_reload: false,
      custom: "KEEP",
    },
    { path: "C:/local", enabled: true, hot_reload: false },
  ];
  const snapshot = {
    config: { included_mod_dirs: entries },
    resolvedModPaths: ["C:/mods/shared", "C:/mods/shared", "C:/local"],
  };
  const catalog = [
    { id: "one", name: "shared", path: "c:\\mods\\shared", available: true },
    { id: "two", name: "other", path: "C:/mods/other", available: true },
  ];
  const rows = modRows(catalog, entries, snapshot);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].indexes, [0, 1]);
  assert.equal(rows[2].local, true);
  const disabled = setModOption(entries, rows[0], "enabled", false);
  assert.equal(disabled[0].path, "../shared");
  assert.equal(disabled[1].custom, "KEEP");
  assert.equal(disabled[1].hot_reload, false);
  assert.equal(disabled[2], entries[2]);
  const enabled = setModOption(disabled, rows[0], "enabled", true);
  assert.equal(enabled[1].hot_reload, false);
  const hot = setModOption(enabled, rows[0], "hot_reload", false);
  assert.equal(hot[0].hot_reload, false);
  assert.equal(hot[1].custom, "KEEP");
  const added = setModOption(hot, rows[1], "enabled", true);
  assert.equal(added.length, 4);
  assert.equal(added[3].path, "C:/mods/other");
  assert.equal(entries[0], "../shared");
  assert.equal(entries[1].enabled, false);
});

test("batch directory registration preserves drag-in workflow and validates the whole batch before saving", async (t) => {
  const { root, library } = await setup(t);
  const a = path.join(root, "drag-a"),
    b = path.join(root, "drag-b"),
    file = path.join(root, "file.txt");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(file, "KEEP");
  const initial = await library.list();
  await assert.rejects(
    library.addDirectories([a, file], initial.revision),
    /目录/,
  );
  assert.equal((await library.list()).mods.length, 0);
  const saved = await library.addDirectories(
    [a, b, a.toUpperCase()],
    initial.revision,
  );
  assert.equal(saved.added, 2);
  assert.equal(saved.selectedIds.length, 2);
  const repeated = await library.addDirectories([a, b], saved.revision);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.mods.length, 2);
});
