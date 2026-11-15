const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "batch-actions"), file = path.join(folder, "model.geo.json"); await fs.mkdir(folder, { recursive: true });
  const bones = [{ name: "body", pivot: [0, 6, 0], extension: true, cubes: [
    { origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0], extension: { keep: [42] } },
    { origin: [9, 0, -2], size: [3, 4, 4], uv: [8, 4] },
  ] }, { name: "arm", parent: "body", pivot: [4, 10, 0], cubes: [{ origin: [4, 3, -2], size: [3, 7, 4], uv: { north: { uv: [3, 4], uv_size: [-3, 7], uv_rotation: 90 } }, rotation: [0, 10, 0] }] }];
  const original = "// keep comment\n" + JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.batch_actions", texture_width: 64, texture_height: 64 }, bones }], extra: true }, null, 2); await fs.writeFile(file, original);
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones;
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator('.model-library-open').filter({ hasText: "geometry.batch_actions" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(data, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true });
    const selected = async names => { const actual = await page.locator('.model-tree .model-cube.active').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))); assert.deepEqual(actual.sort(), names.slice().sort()); };
    const select = async names => { for (let i = 0; i < names.length; i++) await button(names[i]).click(i ? { modifiers: ["Control"] } : {}); await selected(names); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return read(); };
    const undo = async expected => { await button("撤销").click(); assert.deepEqual(await save(), expected); };
    await button("隐藏 arm 立方体 1").click();
    await select(["body 立方体 1", "arm 立方体 1"]); await button("复制").click();
    await selected(["body 立方体 3", "arm 立方体 2"]); assert.equal(await button("显示 arm 立方体 1").count(), 1); assert.equal(await button("隐藏 arm 立方体 2").count(), 1);
    const copied = structuredClone(bones); copied[0].cubes.push(structuredClone(bones[0].cubes[0])); copied[1].cubes.push(structuredClone(bones[1].cubes[0]));
    assert.deepEqual(await read(), bones, "复制仅改草稿"); assert.deepEqual(await save(), copied);
    await page.locator('.model-stage canvas:visible').focus(); await page.keyboard.press("ArrowRight");
    const moved = structuredClone(copied); moved[0].cubes[2].origin[0]++; moved[1].cubes[1].origin[0]++; assert.deepEqual(await save(), moved); await undo(copied); await selected(["body 立方体 3", "arm 立方体 2"]);
    await undo(bones); await selected(["body 立方体 1", "arm 立方体 1"]); assert.equal(await button("显示 arm 立方体 1").count(), 1);
    await button("重做").click(); assert.deepEqual(await save(), copied); await selected(["body 立方体 3", "arm 立方体 2"]);
    await page.locator('.model-stage canvas:visible').focus(); await page.keyboard.press("Delete"); await selected([]); assert.deepEqual(await save(), bones);
    await undo(copied); await selected(["body 立方体 3", "arm 立方体 2"]); await button("重做").click(); assert.deepEqual(await save(), bones); await selected([]);
    console.log("PASS 跨骨骼复制/移动/删除、独立副本、原隐藏身份、单步撤销重做和选择恢复");
    await select(["body 立方体 1", "arm 立方体 1"]); await button("删除").click(); const deleted = structuredClone(bones); deleted[0].cubes.shift(); deleted[1].cubes = []; assert.deepEqual(await save(), deleted); assert.equal(await page.locator('.model-tree').getByRole("button", { name: "arm", exact: true }).count(), 1); await selected([]);
    await undo(bones); await selected(["body 立方体 1", "arm 立方体 1"]); assert.equal(await button("显示 arm 立方体 1").count(), 1);
    await page.locator('.model-stage canvas:visible').focus(); await page.keyboard.press("Control+d"); await selected(["body 立方体 3", "arm 立方体 2"]);
    await page.getByLabel("批量起点X", { exact: true }).fill("999"); await page.getByLabel("批量起点X", { exact: true }).press("Delete"); await page.getByLabel("批量起点X", { exact: true }).press("Control+d"); await page.getByLabel("批量起点X", { exact: true }).press("Escape"); await page.getByLabel("批量起点X", { exact: true }).press("Tab");
    assert.equal(await page.locator('.model-tree .model-cube').count(), 5);
    const output = artifactPath("outputs/batch-actions.bbmodel"); await button("显示 arm 立方体 1").click(); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = importProject(JSON.parse(await fs.readFile(output, "utf8"))); assert.deepEqual(project.bones.map(bone => bone.cubes.length), [3, 2]);
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual(await read(), bones); await selected(["body 立方体 3", "arm 立方体 2"]);
    await fs.rmdir(file + ".bak"); assert.deepEqual(await save(), copied); assert.ok((await fs.readFile(file, "utf8")).startsWith("// keep comment")); assert.equal((await fs.readFile(file, "utf8")).includes('"dgnId"'), false);
    await capture("batch-actions-dark"); await close(); await launch(); assert.equal(await page.locator('.model-tree .model-cube').count(), 5); await selected([]); assert.deepEqual(await read(), copied);
    await select(["body 立方体 1", "body 立方体 2", "body 立方体 3", "arm 立方体 1", "arm 立方体 2"]); await button("删除").click(); assert.deepEqual((await save()).map(bone => bone.cubes.length), [0, 0]);
    await undo(copied); await selected(["body 立方体 1", "body 立方体 2", "body 立方体 3", "arm 立方体 1", "arm 立方体 2"]);
    await page.locator('.model-tree').getByRole("button", { name: "body", exact: true }).click(); await button("复制").click(); const skeletonCopy = await save(); assert.equal(skeletonCopy.length, 4); assert.equal(skeletonCopy[3].parent, skeletonCopy[2].name); await undo(copied); assert.equal(await page.locator('.model-tree button.active').innerText(), "body");
    await select(["body 立方体 1", "arm 立方体 1"]);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("batch-actions-small-light");
    assert.deepEqual(errors, []); console.log("PASS 隐藏元素删除恢复、Ctrl+D/Delete 输入保护、未保存导出、失败重试、重启、全删空骨骼保留和骨骼复制回归"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
