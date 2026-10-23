const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { WorkspaceStore } = require("../electron/services.cjs");
const { validateReloadKeys } = require("../electron/reload-options.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-global-keys-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-global-keys-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store: new WorkspaceStore(root) };
}
test("global key migration backs up settings, preserves profiles and imports explicit old bindings once", async (t) => {
  const { root, store } = await fixture(t);
  const profile = path.join(root, "profile");
  await fs.mkdir(profile);
  const raw =
    '// kept\n{"debug_options":{"reload_key":"106","reload_world_key":"111","reload_key_global":false,"unknown":42}}';
  await fs.writeFile(path.join(profile, ".mcdev.json"), raw);
  const original = JSON.stringify({
    settings: { ThemeHue: 210 },
    projects: [{ id: "p", root: profile }],
    unknown: "KEEP",
  });
  await fs.writeFile(store.file, original);
  await store.load();
  assert.equal(store.value.settings.ReloadKeys.reload_key, "106");
  assert.equal(store.value.settings.ReloadKeys.reload_world_key, "111");
  assert.equal(store.value.settings.ReloadKeys.reload_key_global, true);
  const backup = (await fs.readdir(root)).find((n) =>
    n.startsWith("settings.json.before-global-reload-"),
  );
  assert.equal(await fs.readFile(path.join(root, backup), "utf8"), original);
  assert.equal(
    await fs.readFile(path.join(profile, ".mcdev.json"), "utf8"),
    raw,
  );
  assert.equal(
    JSON.parse(await fs.readFile(store.file, "utf8")).unknown,
    "KEEP",
  );
  await store.updateSettings({ ReloadKeys: { reload_key: "117" } });
  await fs.writeFile(path.join(profile, ".mcdev.json"), "{}");
  const again = new WorkspaceStore(root);
  await again.load();
  assert.equal(again.value.settings.ReloadKeys.reload_key, "117");
  assert.equal(
    (await fs.readdir(root)).filter((n) =>
      n.startsWith("settings.json.before-global-reload-"),
    ).length,
    1,
  );
});
test("partial global key updates serialize and reject invalid values without losing other bindings", async (t) => {
  const { root, store } = await fixture(t);
  await store.load();
  await Promise.all([
    store.updateSettings({ ReloadKeys: { reload_key: "117" } }),
    store.updateSettings({ ReloadKeys: { reload_world_key: "119" } }),
  ]);
  assert.equal(store.value.settings.ReloadKeys.reload_key, "117");
  assert.equal(store.value.settings.ReloadKeys.reload_world_key, "119");
  const before = await fs.readFile(store.file, "utf8");
  for (const ReloadKeys of [
    null,
    [],
    { reload_key: "999" },
    { reload_key_global: "yes" },
    { unrelated: 1 },
  ])
    await assert.rejects(store.updateSettings({ ReloadKeys }));
  assert.equal(await fs.readFile(store.file, "utf8"), before);
  const again = new WorkspaceStore(root);
  await again.load();
  assert.deepEqual(
    again.value.settings.ReloadKeys,
    store.value.settings.ReloadKeys,
  );
  assert.equal(validateReloadKeys({ reload_key: "082" }).reload_key, "82");
});
test("invalid stored global keys are reported while the original file remains intact", async (t) => {
  const { store } = await fixture(t);
  const raw = JSON.stringify({ settings: { ReloadKeys: null }, projects: [] });
  await fs.writeFile(store.file, raw);
  await store.load();
  assert.match(store.warning, /全局快捷键/);
  assert.equal(store.value.settings.ReloadKeys.reload_key, "82");
  assert.equal(await fs.readFile(store.file, "utf8"), raw);
});
