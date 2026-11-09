const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { bedrockMap } = require("./fixtures/map-world.cjs");
(async () => {
  let app;
  try {
    const data = artifactPath("data"), store = new WorkspaceStore(data); await store.load();
    const profiles = new Profiles(store); await profiles.initialize();
    for (let i = 1; i < 12; i++) await profiles.create("Performance profile " + i);
    const worlds = new WorldLibrary(store, path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"));
    for (let i = 0; i < 3; i++) { const world = await worlds.create(store.value.projects[0].id, { name: "Performance world " + i }); await bedrockMap(worlds.location(world.id)); }
    const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.DGN_GAME_TEST_EXE || undefined, args: process.env.DGN_GAME_TEST_EXE ? [] : ["."], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      globalThis.perfCounts = {};
      const original = ipcMain._invokeHandlers.get("request");
      if (!original) throw Error("IPC observation unavailable");
      ipcMain._invokeHandlers.set("request", async (event, method, args) => { globalThis.perfCounts[method] = (globalThis.perfCounts[method] || 0) + 1; return original(event, method, args); });
    });
    const phases = [];
    for (const name of ["存档", "启动配置"]) {
      await page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(() => !document.documentElement.dataset.pageAnimating); await page.waitForTimeout(500);
      await app.evaluate(() => { globalThis.perfCounts = {}; });
      for (let i = 0; i < 10; i++) {
        await app.evaluate(({ BrowserWindow }, completed) => BrowserWindow.getAllWindows()[0].webContents.send("activity-state", { tasks: [{ id: "synthetic", method: "world-data.scan", status: "running", completed, total: 10 }], events: [{ id: "scan", level: "info", method: "world-data.scan" }] }), i);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(300);
      const counts = await app.evaluate(() => globalThis.perfCounts);
      for (const method of ["profiles.list", "worlds.list", "project.read"]) assert.equal(counts[method] || 0, 0, method + " must not follow unrelated progress");
      phases.push({ name, progressEvents: 10, counts });
    }
    await page.evaluate(() => window.toolkit.call("profiles.create", { name: "Created through real IPC" }));
    await page.getByRole("article", { name: "启动配置 Created through real IPC", exact: true }).waitFor();
    await page.locator(".sidebar").getByRole("button", { name: "存档", exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.pageAnimating);
    const id = (await page.evaluate(() => window.toolkit.call("worlds.list"))).worlds[0].id;
    await page.evaluate(worldId => window.toolkit.call("worlds.update", { worldId, name: "Changed through real IPC" }), id);
    await page.getByRole("article", { name: "存档 Changed through real IPC", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await fs.writeFile(artifactPath("outputs/performance.json"), JSON.stringify({ profiles: 12, worlds: 3, phases, mutationsVisible: true }, null, 2), "utf8");
    console.log("PASS performance UI: 10 progress events produce zero resource reads; real mutations remain visible");
  } finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
