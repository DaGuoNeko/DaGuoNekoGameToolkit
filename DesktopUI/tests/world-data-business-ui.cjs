const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { worldDataFixture } = require("./fixtures/world-data.cjs");
const { Database } = require("@jsprismarine/leveldb");
const { patchRecord } = require("../electron/domains/worlds/world-data-edit-codec.cjs");
(async () => {
  let app;
  try {
    const root = artifactPath("ui"), source = path.join(root, "source"), inactive = path.join(root, "inactive"), plain = path.join(root, "plain"), other = path.join(root, "other");
    await worldDataFixture(source); await worldDataFixture(other, { changed: true });
    await worldDataFixture(inactive, { enabledMods: false }); await worldDataFixture(plain, { enabledMods: false, extra: false });
    const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: path.join(root, "data") }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: process.env.DGN_GAME_TEST_EXE || undefined, args: process.env.DGN_GAME_TEST_EXE ? [] : ["."], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.toolkit.call("settings.update", { AppearanceMode: "Light" }));
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, dialog }, source) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      BrowserWindow.getAllWindows()[0].setSize(1440, 980);
      globalThis.fixtureSource = source;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.fixtureSource] });
    }, source);
    const capture = async name => {
      const bytes = await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await new Promise(resolve => setTimeout(resolve, 150));
        return (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString("base64");
      });
      await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(bytes, "base64"));
    };
    const select = async (label, option) => { if (label === "数据视图") { await page.getByRole("tab", { name: option, exact: true }).click(); return; } await page.getByRole("combobox", { name: label, exact: true }).click(); await page.getByRole("option", { name: option, exact: true }).click(); };
    const category = async name => { await page.locator(".data-categories button").filter({ hasText: new RegExp("^" + name + "\\s*\\d+$") }).click(); };
    const scan = async (expectedSource = source) => { await page.locator(".world-location").filter({ hasText: expectedSource }).waitFor(); await page.getByText("受支持记录扫描完成", { exact: true }).waitFor({ timeout: 60000 }); await page.getByText("扫描中，请等待", { exact: true }).waitFor({ state: "hidden" }); };
    await page.getByRole("button", { name: "打开外部存档", exact: true }).click();
    await page.getByRole("navigation", { name: "存档工作区" }).getByRole("button", { name: "世界数据", exact: true }).click();
    await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await scan();
    await category("NPC"); await page.locator(".data-object-header h3").filter({ hasText: "旅行向导" }).waitFor();
    await page.locator(".data-layout").scrollIntoViewIfNeeded(); await capture("npc-light");
    await page.getByRole("tab", { name: "双向引用", exact: true }).click();
    await page.locator(".data-edge-node strong").filter({ hasText: /^入口$/ }).waitFor();
    await page.locator(".data-edge-node").filter({ hasText: "library:entry" }).click();
    await page.locator(".data-object-header h3").filter({ hasText: /^入口$/ }).waitFor();
    await page.locator(".data-summary h4").filter({ hasText: /^命令序列/ }).waitFor();
    await page.getByRole("tab", { name: "双向引用", exact: true }).click(); await select("引用方向", "谁引用了我");
    await page.locator(".data-edge-node strong").filter({ hasText: /^旅行向导$/ }).waitFor();
    await capture("reverse-references");
    await page.getByRole("tab", { name: "原始字段", exact: true }).click();
    await page.locator(".data-field button").filter({ hasText: /commands/ }).click();
    await page.locator(".data-fields .data-toolbar code").filter({ hasText: /^\/commands$/ }).waitFor();
    await page.getByRole("button", { name: "根节点", exact: true }).click();
    await category("任务"); await page.locator(".data-object-header h3").filter({ hasText: /^采集任务$/ }).waitFor();
    await page.locator(".data-summary-row").filter({ hasText: "任务目标" }).waitFor();
    await category("容器"); await page.locator(".data-summary-row").filter({ hasText: "fixture:apple × 2" }).waitFor();
    await category("RPG 属性"); await page.locator(".data-summary h4").filter({ hasText: /^已保存属性/ }).waitFor();
    await category("ExtraData"); await page.getByRole("tab", { name: "原始字段", exact: true }).click(); await page.locator(".data-field").first().waitFor();
    await select("数据视图", "关系图"); await page.getByRole("button", { name: "展开目标关联", exact: true }).first().waitFor();
    await page.getByRole("button", { name: "展开目标关联", exact: true }).first().click(); await page.getByRole("button", { name: "返回全部关系", exact: true }).waitFor();
    await app.evaluate((_, other) => { globalThis.fixtureSource = other; }, other);
    await page.getByRole("button", { name: "比较另一目录", exact: true }).click(); await page.getByText(/处对象变化/).waitFor({ timeout: 60000 });
    await page.locator(".data-difference summary").filter({ hasText: /字段变化.*采集任务/ }).click();
    await page.locator(".data-diff-field strong").filter({ hasText: "目标数量" }).waitFor(); await capture("comparison-light");
    await select("数据视图", "对象与字段"); await category("指令库"); await page.locator(".data-object-header h3").filter({ hasText: /^入口$/ }).waitFor();
    await page.getByRole("button", { name: "编辑业务内容", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "字段值", exact: true }); await draft.waitFor();
    const value = JSON.parse(await draft.inputValue()); value.commands[0].cmd = "say saved through UI";
    await draft.fill(JSON.stringify(value, null, 2));
    await page.getByRole("button", { name: "关闭并保留草稿", exact: true }).click();
    for (let i = 0; i < 9; i++) {
      const next = path.join(root, "draft-cache-" + i); await worldDataFixture(next, { enabledMods: false, extra: false });
      await app.evaluate((_, next) => { globalThis.fixtureSource = next; }, next);
      await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await scan(next);
    }
    await app.evaluate((_, source) => { globalThis.fixtureSource = source; }, source);
    await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await scan(); await category("指令库");
    await page.getByRole("button", { name: "编辑业务内容", exact: true }).click(); await draft.waitFor();
    assert.equal(JSON.parse(await draft.inputValue()).commands[0].cmd, "say saved through UI");
    await page.getByRole("button", { name: "预览变更", exact: true }).click();
    await page.getByRole("button", { name: "备份并保存", exact: true }).waitFor(); await capture("write-preview");
    await page.getByRole("button", { name: "备份并保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60000 });
    await page.getByText("已保存并重新读取。自动备份可用于撤销本次改动。", { exact: true }).waitFor({ timeout: 60000 });
    await page.locator(".data-summary-row").filter({ hasText: "say saved through UI" }).waitFor();
    const scriptKey = Buffer.from("scriptData");
    let savedScript;
    const external = await Database.open(path.join(source, "db"));
    try {
      savedScript = Buffer.from(external.get(scriptKey));
      external.put(scriptKey, patchRecord(savedScript, "/scriptData/DAGUOMIAO_API_MOD_data_v1/command_library/data/entry/commands/0/cmd", "say external change", { worldScript: true }).bytes);
    } finally { await external.close(); }
    await page.getByRole("button", { name: "撤销上次保存", exact: true }).click(); await page.getByRole("button", { name: "确认恢复备份", exact: true }).click();
    await page.getByText(/保存目标已变化/).first().waitFor({ timeout: 60000 });
    const restoreFixture = await Database.open(path.join(source, "db"));
    try { restoreFixture.put(scriptKey, savedScript); } finally { await restoreFixture.close(); }
    await page.getByRole("button", { name: "撤销上次保存", exact: true }).click(); await page.getByRole("button", { name: "确认恢复备份", exact: true }).click();
    await page.getByText("已恢复本次修改前的记录，并重新读取。", { exact: true }).waitFor({ timeout: 60000 });
    await select("数据视图", "版本与兼容");
    await page.getByRole("textbox", { name: "最低启动版本", exact: true }).fill("3.10.0.420447");
    await page.getByRole("textbox", { name: "最高启动版本", exact: true }).fill("3.10.0.436581");
    await page.getByRole("button", { name: "预览启动范围变更", exact: true }).click(); await page.getByRole("button", { name: "备份并保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60000 });
    await page.getByText("已保存并重新读取。自动备份可用于撤销本次改动。", { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(JSON.parse(await fs.readFile(path.join(source, ".daguoneko-versions.json"), "utf8")).maximum, "3.10.0.436581");
    await page.getByRole("textbox", { name: "最低兼容客户端版本", exact: true }).fill("1.18.0");
    await page.getByRole("textbox", { name: "最后打开版本", exact: true }).fill("1.20.0");
    await page.getByRole("button", { name: "预览兼容标记变更", exact: true }).click(); await page.getByRole("button", { name: "备份并保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 60000 });
    await page.getByText("已保存并重新读取。自动备份可用于撤销本次改动。", { exact: true }).waitFor({ timeout: 60000 });
    const parsedLevel = require("../electron/domains/worlds/world-data-codec.cjs").parseNbtRecord((await fs.readFile(path.join(source, "level.dat"))).subarray(8));
    assert.deepEqual(parsedLevel.value.MinimumCompatibleClientVersion, [1, 18, 0, 0, 0]); await capture("versions-light");
    await select("数据视图", "对象与字段"); await category("指令库"); await page.locator(".data-results > button").first().click();
    for (const [theme, width, height, zoom] of [["Light", 1240, 820, 1], ["Dark", 900, 650, 1], ["Dark", 900, 650, 1.25]]) {
      await page.evaluate(theme => window.toolkit.call("settings.update", { AppearanceMode: theme }), theme);
      await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(width, height); win.webContents.setZoomFactor(zoom); }, { width, height, zoom });
      await page.locator(".data-detail").scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "页面不应横向溢出");
      assert(await page.evaluate(() => { const node = document.querySelector(".data-detail"); return node.scrollWidth <= node.clientWidth + 1; }), "详情不应横向溢出");
      await capture(`library-${theme}-${zoom}`);
    }
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1240, 820); win.webContents.setZoomFactor(1); });
    for (const [next, hasExtra] of [[inactive, true], [plain, false]]) {
      await app.evaluate((_, next) => { globalThis.fixtureSource = next; }, next);
      await page.getByRole("button", { name: "选择外部文件夹", exact: true }).click(); await scan(next);
      for (const name of ["NPC", "任务", "对话", "指令库", "RPG 属性"]) assert.equal(await page.locator(".data-categories button").filter({ hasText: new RegExp("^" + name + "\\s*\\d+$") }).count(), 0);
      assert.equal(await page.locator(".data-categories button").filter({ hasText: /^ExtraData/ }).count(), hasExtra ? 1 : 0);
      await page.locator(".data-coverage summary").click();
      if (!hasExtra) await page.getByText("本次未读取到网易 ExtraData，这是可选数据，不代表存档异常。", { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log("Business UI passed: mod gating, optional ExtraData, summaries, reverse references, fields, graph expansion, semantic comparison, themes and 125% zoom");
  } catch (error) { console.error(error); throw error; }
  finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
