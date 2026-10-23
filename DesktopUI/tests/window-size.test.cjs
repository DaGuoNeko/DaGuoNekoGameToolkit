const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { WorkspaceStore } = require("../electron/services.cjs");
const {
  applyWindowSize,
  validateWindowSize,
  windowSizeDefaults,
} = require("../electron/window-size.cjs");
test("default window size preserves per-profile styles and explicit size overrides", () => {
  const source = {
    window_style: { always_on_top: true, fixed_position: [10, 20] },
  };
  assert.deepEqual(
    applyWindowSize(source, { enabled: true, width: 960, height: 540 })
      .window_style,
    { ...source.window_style, fixed_size: [960, 540] },
  );
  assert.equal(source.window_style.fixed_size, undefined);
  const explicit = { window_style: { fixed_size: [1600, 900] } };
  assert.equal(applyWindowSize(explicit, windowSizeDefaults), explicit);
  assert.deepEqual(
    applyWindowSize({}, { ...windowSizeDefaults, enabled: false }),
    {},
  );
  for (const width of [0, 639, 7681, 1280.5, "1280", NaN])
    assert.throws(
      () => validateWindowSize({ ...windowSizeDefaults, width }),
      /整数像素/,
    );
});
test("window settings save/reopen and reject invalid drafts without overwriting saved values", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-window-size-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-window-size-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new WorkspaceStore(root);
  await store.load();
  assert.deepEqual(store.value.settings.GameWindowSize, windowSizeDefaults);
  const value = { enabled: true, width: 1600, height: 900 };
  await store.updateSettings({ GameWindowSize: value });
  await assert.rejects(
    store.updateSettings({ GameWindowSize: { ...value, height: 0 } }),
    /整数像素/,
  );
  const reopened = new WorkspaceStore(root);
  await reopened.load();
  assert.deepEqual(reopened.value.settings.GameWindowSize, value);
  const raw = JSON.parse(await fs.readFile(store.file, "utf8"));
  raw.settings.GameWindowSize = { enabled: true, width: -2, height: 900 };
  await fs.writeFile(store.file, JSON.stringify(raw));
  const bad = new WorkspaceStore(root);
  await bad.load();
  assert.deepEqual(bad.value.settings.GameWindowSize, windowSizeDefaults);
  assert.match(bad.warning, /窗口大小无效/);
});
