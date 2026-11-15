const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");
const { worldVertices } = require("./fixtures/model-positions.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "pose"), file = path.join(folder, "model.geo.json"); await fs.mkdir(folder, { recursive: true });
  const bones = [
    { name: "root", pivot: [1, 2, 3], rotation: [5, 25, -15], cubes: [] },
    { name: "body", parent: "root", pivot: [0, 6, 0], rotation: [15, -20, 10], cubes: [{ name: "a", origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0], rotation: [10, 20, -10], inflate: 0.1, extension: true }] },
    { name: "arm", parent: "body", pivot: [5, 10, 0], rotation: [-20, 15, 35], cubes: [{ name: "b", origin: [4, 3, -2], size: [3, 7, 4], pivot: [5, 8, 1], uv: { north: { uv: [3, 4], uv_size: [-3, 7], uv_rotation: 90 } }, rotation: [0, 10, 15] }] },
    { name: "target", parent: "root", pivot: [6, -2, 5], rotation: [-30, 40, -35], cubes: [] },
  ];
  const original = "// keep comment\n" + JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.pose", texture_width: 64, texture_height: 64 }, bones }] }, null, 2); await fs.writeFile(file, original);
  const animation = JSON.stringify({ animations: { "animation.pose": { loop: true, animation_length: 1, bones: { body: { rotation: [10, 0, 0] }, target: { rotation: [0, 20, 0] } } } } }); await fs.writeFile(path.join(folder, "pose.animation.json"), animation);
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones;
  const vertices = worldVertices(bones);
  const same = current => { const actual = worldVertices(current); assert.deepEqual(Object.keys(actual).sort(), Object.keys(vertices).sort()); for (const name of Object.keys(vertices)) for (let i = 0; i < vertices[name].length; i++) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(vertices[name][i][axis] - actual[name][i][axis]) < 1e-6, name + " vertex " + i); };
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator('.model-library-open').filter({ hasText: "geometry.pose" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(image, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), boneButton = name => page.locator('.model-tree').getByRole("button", { name, exact: true });
    const selected = async names => assert.deepEqual((await page.locator('.model-tree .model-cube.active').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')))).sort(), names.slice().sort());
    const select = async () => { await button("body 立方体 1").click(); await button("arm 立方体 1").click({ modifiers: ["Control"] }); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return read(); };
    const target = async name => { await page.getByRole("combobox", { name: "目标骨骼", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); };
    await select(); let keep = page.getByRole("checkbox", { name: "保持静止姿态", exact: true }); assert.equal(await keep.isChecked(), false);
    await target("target"); await keep.check(); await capture("pose-before-dark"); await button("移入骨骼").click();
    assert.deepEqual(await read(), bones, "移动只改草稿"); await selected(["target 立方体 1", "target 立方体 2"]);
    const output = artifactPath("outputs/rest-pose.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const imported = importProject(JSON.parse(await fs.readFile(output, "utf8")));
    imported.bones.find(b => b.name === "target").cubes.forEach((cube, i) => { cube.name = ["a", "b"][i]; }); same(imported.bones);
    const moved = await save(); same(moved); assert.deepEqual(moved.slice(0, 3).map(b => b.cubes.length), [0, 0, 0]);
    for (const [i, originalCube] of [bones[1].cubes[0], bones[2].cubes[0]].entries()) { const { origin, pivot, rotation, ...rest } = moved[3].cubes[i]; const { origin: a, pivot: b, rotation: c, ...old } = originalCube; assert.deepEqual(rest, old); }
    await capture("pose-after-dark");
    await button("撤销").click(); assert.deepEqual(await save(), bones); await selected(["body 立方体 1", "arm 立方体 1"]);
    await button("重做").click(); assert.deepEqual(await save(), moved); await button("撤销").click(); assert.deepEqual(await save(), bones);
    await button("arm 立方体 1").dragTo(boneButton("target")); const dragged = await save(); same(dragged); assert.deepEqual(dragged, moved); await button("撤销").click(); assert.deepEqual(await save(), bones);
    await keep.uncheck(); await button("移入骨骼").click(); const unchangedCoords = await save(); assert.deepEqual(unchangedCoords[3].cubes, [bones[1].cubes[0], bones[2].cubes[0]]); assert.notDeepEqual(worldVertices(unchangedCoords), vertices); await button("撤销").click(); assert.deepEqual(await save(), bones);
    console.log("PASS 下拉/真实拖动保持每个渲染顶点，关闭选项保留旧行为，选择/撤销/重做及未保存工程导出");
    await keep.check(); await button("移入骨骼").click(); await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual(await read(), bones);
    await fs.rmdir(file + ".bak"); same(await save()); assert.equal(await fs.readFile(path.join(folder, "pose.animation.json"), "utf8"), animation);
    await close(); await launch(); keep = page.getByRole("checkbox", { name: "保持静止姿态", exact: true }); same(await read()); await button("target 立方体 1").click(); await button("target 立方体 2").click({ modifiers: ["Control"] }); assert.equal(await keep.isChecked(), false);
    await keep.check(); await target("body");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await keep.scrollIntoViewIfNeeded(); await capture("pose-small-light");
    assert.deepEqual(errors, []); console.log("PASS 保存失败重试、重开姿态、动画不改写和深浅/小窗口布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
