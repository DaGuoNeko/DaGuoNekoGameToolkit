const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { Database } = require("@jsprismarine/leveldb");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { worldDataFixture } = require("./fixtures/world-data.cjs");
const { patchRecord } = require("../electron/domains/worlds/world-data-edit-codec.cjs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
async function changeCommand(source, command) {
  const key = Buffer.alloc(9); key[8] = 0x31;
  const db = await Database.open(path.join(source, "db"));
  try { db.put(key, patchRecord(db.get(key), "/Command", command).bytes); } finally { await db.close(); }
}
(async () => {
  let app;
  try {
    const root = artifactPath("ui"), data = path.join(root, "data"), store = new WorkspaceStore(data); await store.load();
    const profiles = new Profiles(store); await profiles.initialize();
    // 与应用使用相同的测试存档库位置。
    const library = new WorldLibrary(store, path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"));
    const a = await library.create(store.value.projects[0].id, { name: "自动加载 A" }), b = await library.create(store.value.projects[0].id, { name: "自动加载 B" });
    const empty = await library.create(store.value.projects[0].id, { name: "尚未生成的存档" });
    await worldDataFixture(library.location(a.id)); await worldDataFixture(library.location(b.id));
    await changeCommand(library.location(b.id), "say second-world");
    const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.DGN_GAME_TEST_EXE || undefined, args: process.env.DGN_GAME_TEST_EXE ? [] : ["."], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      globalThis.scans = []; globalThis.stateReads = 0; globalThis.holdNext = true;
      const original = ipcMain._invokeHandlers.get("request");
      ipcMain._invokeHandlers.set("request", async (event, method, args) => {
        if (method === "world-data.state") globalThis.stateReads++;
        if (method !== "world-data.scan") return original(event, method, args);
        const hold = globalThis.holdNext; globalThis.holdNext = false;
        const entry = { requestId: args.requestId, worldId: args.worldId, reuseRequestId: args.reuseRequestId }; globalThis.scans.push(entry);
        const result = await original(event, method, args); entry.resultId = result.result?.requestId; entry.error = result.error;
        // 只延迟真实扫描的响应交付，读取、授权和缓存仍经过原 IPC/worker。
        if (hold) await new Promise(resolve => { globalThis.releaseScan = () => { globalThis.releaseScan = null; resolve(); }; });
        entry.delivered = true; return result;
      });
    });
    const waitMain = async (count, held = false) => app.evaluate(async ({}, { count, held }) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (held ? !!globalThis.releaseScan : globalThis.scans.length >= count && globalThis.scans.at(-1).delivered) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error("等待自动扫描状态超时");
    }, { count, held });
    const tab = name => page.getByRole("navigation", { name: "存档工作区" }).getByRole("button", { name, exact: true }).click();
    const scanCount = () => app.evaluate(() => globalThis.scans.length);
    const ready = async () => { await page.waitForTimeout(100); await page.getByText("受支持记录扫描完成", { exact: true }).waitFor({ timeout: 60000 }); await page.getByText("扫描中，请等待", { exact: true }).waitFor({ state: "hidden" }); };
    await page.getByRole("button", { name: "自动加载 A", exact: true }).click();
    await waitMain(1, true);
    assert.equal(await app.evaluate(() => globalThis.scans.length), 1);
    assert.equal(await app.evaluate(() => globalThis.stateReads), 0, "后台子页不轮询扫描进度");
    await tab("世界数据"); await page.getByText("扫描中，请等待", { exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "重新扫描", exact: true }).isDisabled());
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      return (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64");
    });
    await fs.writeFile(artifactPath("outputs/automatic-loading.png"), Buffer.from(bytes, "base64"));
    await tab("地图"); await tab("世界数据");
    assert.equal(await app.evaluate(() => globalThis.scans.length), 1, "切换子页复用正在进行的任务");
    await app.evaluate(() => globalThis.releaseScan()); await ready();
    const firstId = await app.evaluate(() => globalThis.scans[0].resultId);
    assert.equal(typeof firstId, "string");
    let before = await scanCount();
    await tab("概览"); await tab("世界数据"); await waitMain(before + 1); await ready();
    assert.equal(await app.evaluate(() => globalThis.scans.at(-1).resultId), firstId, "来源未变化时保留同一快照");
    await changeCommand(library.location(a.id), "say changed-on-disk");
    before = await scanCount();
    await tab("概览"); await tab("世界数据"); await waitMain(before + 1); await ready();
    await page.locator(".data-summary-row").filter({ hasText: "say changed-on-disk" }).waitFor();
    const changedId = await app.evaluate(() => globalThis.scans.at(-1).resultId); assert.notEqual(changedId, firstId);
    for (let i = 0; i < 4; i++) await page.evaluate(({ worldId, requestId }) => window.toolkit.call("world-data.scan", { worldId, requestId, scope: "gameplay", summaryOnly: true }), { worldId: a.id, requestId: "evict-" + i });
    before = await scanCount();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await page.getByRole("button", { name: "自动加载 A", exact: true }).click(); await tab("世界数据"); await waitMain(before + 1); await ready();
    assert.notEqual(await app.evaluate(() => globalThis.scans.at(-1).resultId), changedId, "快照淘汰后自动重新读取");
    await app.evaluate(() => { globalThis.holdNext = true; });
    await page.getByRole("button", { name: "重新扫描", exact: true }).click(); await waitMain(0, true);
    before = await scanCount();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await page.getByRole("button", { name: "自动加载 B", exact: true }).click(); await tab("世界数据"); await waitMain(before + 1); await ready();
    await app.evaluate(() => globalThis.releaseScan());
    await page.locator(".data-summary-row").filter({ hasText: "say second-world" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "自动加载 B", exact: true }).count(), 1, "旧响应不能替换新存档");
    before = await scanCount();
    await page.getByRole("combobox", { name: "读取范围", exact: true }).click(); await page.getByRole("option", { name: "世界与玩家数据", exact: true }).click();
    await waitMain(before + 1); await ready();
    assert.equal(await page.locator(".data-categories button").filter({ hasText: /^命令方块/ }).count(), 0);
    before = await scanCount();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await page.getByRole("button", { name: "尚未生成的存档", exact: true }).click(); await tab("世界数据");
    await page.getByText("存档尚未生成或暂不可用", { exact: true }).waitFor(); await page.waitForTimeout(100);
    assert.equal(await scanCount(), before, "未生成的存档不扫描");
    assert(!await app.evaluate(({}, id) => globalThis.scans.some(scan => scan.worldId === id), empty.id));
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await page.getByRole("button", { name: "打开外部存档", exact: true }).click(); await tab("世界数据");
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, library.location(a.id));
    before = await scanCount();
    await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await waitMain(before + 1); await ready();
    const externalId = await app.evaluate(() => globalThis.scans.at(-1).resultId);
    before = await scanCount();
    await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await waitMain(before + 1); await ready();
    assert.notEqual(await app.evaluate(() => globalThis.scans.at(-1).resultId), externalId, "重新选择同一来源也自动刷新");
    assert.deepEqual(errors, []);
    await fs.writeFile(artifactPath("outputs/loading-checks.json"), JSON.stringify({ scans: await app.evaluate(() => globalThis.scans), hiddenProgressPolling: 0, oldResponseDiscarded: true }, null, 2), "utf8");
    console.log("PASS automatic loading: workspace preload, loading state, shared task, validated reuse, source changes, eviction, source switching and scope reload");
  } catch (error) { if (app) await fs.writeFile(artifactPath("outputs/scan-failure.json"), JSON.stringify(await app.evaluate(() => globalThis.scans).catch(() => []), null, 2), "utf8"); console.error(error); throw error; }
  finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
