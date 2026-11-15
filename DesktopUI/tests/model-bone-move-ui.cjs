const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "bone-move"), file = path.join(folder, "model.geo.json"); await fs.mkdir(folder, { recursive: true });
  const bones = [{ name: "body", pivot: [0, 6, 0], extension: true, cubes: [
    { origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0], extension: { keep: [42] } },
    { origin: [9, 0, -2], size: [3, 4, 4], uv: [8, 4] },
    { origin: [-8, 0, -2], size: [3, 4, 4], uv: [16, 4], rotation: [0, 10, 0] },
  ] }, { name: "arm", parent: "body", pivot: [4, 10, 0], rotation: [0, 0, 15], cubes: [{ origin: [4, 3, -2], size: [3, 7, 4], pivot: [5, 8, 0], uv: { north: { uv: [3, 4], uv_size: [-3, 7], uv_rotation: 90 } } }] }, { name: "target", pivot: [0, 0, 0], rotation: [0, 20, 0], cubes: [] }];
  const original = "// keep comment\n" + JSON.stringify({ format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: "geometry.bone_move", texture_width: 64, texture_height: 64 }, bones }], extra: true }, null, 2); await fs.writeFile(file, original);
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones;
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator('.model-library-open').filter({ hasText: "geometry.bone_move" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(image, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), boneButton = name => page.locator('.model-tree').getByRole("button", { name, exact: true });
    const selected = async names => { const actual = await page.locator('.model-tree .model-cube.active').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))); assert.deepEqual(actual.sort(), names.slice().sort()); };
    const select = async names => { for (let i = 0; i < names.length; i++) await button(names[i]).click(i ? { modifiers: ["Control"] } : {}); await selected(names); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return read(); };
    const undo = async expected => { await button("撤销").click(); assert.deepEqual(await save(), expected); };
    const pickTarget = async name => { await page.getByRole("combobox", { name: "目标骨骼", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); };
    await button("隐藏 body 立方体 1").click(); await select(["body 立方体 1", "arm 立方体 1"]);
    await pickTarget("target"); await button("移入骨骼").click(); await selected(["target 立方体 1", "target 立方体 2"]);
    const moved = structuredClone(bones); moved[0].cubes.shift(); moved[1].cubes = []; moved[2].cubes = [structuredClone(bones[0].cubes[0]), structuredClone(bones[1].cubes[0])];
    assert.deepEqual(await read(), bones, "移动先留在草稿"); assert.deepEqual(await save(), moved); assert.equal(await button("显示 target 立方体 1").count(), 1);
    await undo(bones); await selected(["body 立方体 1", "arm 立方体 1"]); assert.equal(await button("显示 body 立方体 1").count(), 1);
    await button("重做").click(); assert.deepEqual(await save(), moved); await selected(["target 立方体 1", "target 立方体 2"]); await undo(bones);
    console.log("PASS 下拉跨骨骼整组移动、坐标/UV/旋转字段不变、空骨骼保留及选择/隐藏撤销恢复");
    await button("arm 立方体 1").dragTo(boneButton("target")); await selected(["target 立方体 1", "target 立方体 2"]); assert.deepEqual(await save(), moved); await undo(bones);
    await select(["body 立方体 1", "body 立方体 3"]); await button("body 立方体 3").dragTo(button("body 立方体 2"));
    const ordered = structuredClone(bones); ordered[0].cubes = [bones[0].cubes[0], bones[0].cubes[2], bones[0].cubes[1]]; assert.deepEqual(await save(), ordered); await selected(["body 立方体 1", "body 立方体 2"]); await undo(bones);
    await button("body 立方体 1").dragTo(button("body 立方体 3")); assert.deepEqual(await save(), bones); await selected(["body 立方体 1", "body 立方体 3"]);
    await button("arm 立方体 1").dragTo(button("body 立方体 2")); const single = structuredClone(bones); single[0].cubes.splice(1, 0, single[1].cubes[0]); single[1].cubes = [];
    assert.deepEqual(await save(), single); await selected(["body 立方体 2"]); await undo(bones);
    await boneButton("target").dispatchEvent("drop"); assert.deepEqual(await save(), bones);
    await boneButton("arm").dragTo(boneButton("target")); const parented = structuredClone(bones); parented[1].parent = "target"; assert.deepEqual(await save(), parented); await undo(bones);
    await boneButton("body").dragTo(boneButton("arm")); await page.getByText("不能把骨骼挂到自己的子级上", { exact: true }).waitFor(); assert.deepEqual(await save(), bones);
    await select(["body 立方体 1", "arm 立方体 1"]);
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await button("body 立方体 1").dispatchEvent("dragstart", { dataTransfer: transfer });
    await page.getByLabel("批量起点Y", { exact: true }).fill("7"); await page.getByLabel("批量起点Y", { exact: true }).press("Enter");
    await boneButton("target").dispatchEvent("drop", { dataTransfer: transfer }); await transfer.dispose();
    await page.getByText("模型在拖动期间变化，请重新拖动", { exact: true }).waitFor();
    const editedDuringDrag = structuredClone(bones); editedDuringDrag[0].cubes[0].origin[1] = 7; editedDuringDrag[1].cubes[0].origin[1] = 7; assert.deepEqual(await save(), editedDuringDrag); await undo(bones);
    await select(["body 立方体 1", "arm 立方体 1"]); await pickTarget("body"); await button("移入骨骼").click();
    const combined = structuredClone(bones); combined[0].cubes = [bones[0].cubes[1], bones[0].cubes[2], bones[0].cubes[0], bones[1].cubes[0]]; combined[1].cubes = [];
    assert.deepEqual(await save(), combined); await selected(["body 立方体 3", "body 立方体 4"]); await undo(bones);
    console.log("PASS 真实大纲拖动批量移入/重排、单元素和骨骼拖动、循环与过期拖动拒绝");
    await pickTarget("target"); await button("移入骨骼").click(); await button("显示 target 立方体 1").click();
    const output = artifactPath("outputs/moved.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const imported = importProject(JSON.parse(await fs.readFile(output, "utf8"))); assert.deepEqual(imported.bones.map(b => b.cubes.length), [2, 0, 2]); assert.deepEqual(imported.bones[2].cubes.map(cube => cube.origin), moved[2].cubes.map(cube => cube.origin));
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual(await read(), bones); await selected(["target 立方体 1", "target 立方体 2"]);
    await fs.rmdir(file + ".bak"); assert.deepEqual(await save(), moved); assert.ok((await fs.readFile(file, "utf8")).startsWith("// keep comment")); assert.equal((await fs.readFile(file, "utf8")).includes('"dgnId"'), false);
    await capture("bone-move-dark"); await close(); await launch(); assert.deepEqual(await read(), moved); await select(["target 立方体 1", "target 立方体 2"]);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await page.getByRole("combobox", { name: "目标骨骼", exact: true }).scrollIntoViewIfNeeded(); await capture("bone-move-small-light");
    assert.deepEqual(errors, []); console.log("PASS 目标中已有选择的移动、未保存导出、失败重试、重开与窄窗浅色布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
