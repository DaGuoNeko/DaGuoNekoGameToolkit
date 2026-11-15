const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { worldVertices } = require("./fixtures/model-positions.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "vertex-snap"), file = path.join(folder, "model.geo.json"); await fs.mkdir(folder, { recursive: true });
  const bones = [{ name: "source", cubes: [{ name: "a", origin: [0, 0, 0], size: [2, 2, 2], pivot: [1, 1, 1], uv: [0, 0], extension: true }] }, { name: "target", cubes: [{ name: "b", origin: [3.3, 0, 0], size: [2, 2, 2], uv: [0, 0] }] }];
  const original = "// keep\n" + JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.vertex_snap", texture_width: 64, texture_height: 64 }, bones }] }, null, 2); await fs.writeFile(file, original);
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones;
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator('.model-library-open').filter({ hasText: "geometry.vertex_snap" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(data, "base64")); };
  const near = (value, expected) => assert.ok(Math.abs(Number(value) - expected) < 1e-6, value + " != " + expected);
  const touching = current => { const vertices = worldVertices(current); return vertices.a.some(point => vertices.b.some(target => point.every((n, i) => Math.abs(n - target[i]) < 1e-6))); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true });
    const choose = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return read(); };
    const undo = async () => { await button("撤销").click(); assert.deepEqual(await save(), bones); };
    await button("source 立方体 1").click(); assert.equal(await button("顶点吸附").getAttribute("aria-pressed"), "false");
    await page.locator('.model-stage canvas').focus(); await page.keyboard.press("ArrowRight"); near((await save())[0].cubes[0].origin[0], 1); await undo();
    await button("顶点吸附").click(); await page.locator('.model-stage canvas').focus(); await page.keyboard.press("ArrowRight");
    await page.getByRole("status", { name: "顶点吸附状态", exact: true }).filter({ hasText: "已吸附" }).waitFor();
    assert.deepEqual(await read(), bones, "键盘吸附先改草稿"); let saved = await save(); near(saved[0].cubes[0].origin[0], 1.3); near(saved[0].cubes[0].pivot[0], 2.3); assert.ok(touching(saved)); assert.deepEqual(saved[1], bones[1]);
    await undo(); await button("重做").click(); assert.ok(touching(await save())); await undo();
    await button("吸附").click(); await page.locator('.model-stage canvas').focus(); await page.keyboard.press("ArrowRight"); near((await save())[0].cubes[0].origin[0], 1.3); await undo(); await button("吸附").click();
    await button("隐藏 target").click(); await page.locator('.model-stage canvas').focus(); await page.keyboard.press("ArrowRight"); near((await save())[0].cubes[0].origin[0], 1); await undo(); await button("显示 target").click();
    await choose("视角", "前视图（南）"); await button("聚焦").click();
    const stage = page.locator('.model-stage canvas');
    const drag = async cancel => {
      const box = await stage.boundingBox(); const x = box.x + box.width / 2 + box.height * 0.24, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + box.height / 2.6, y, { steps: 12 });
      if (cancel === "escape") await page.keyboard.press("Escape");
      if (cancel === "pointer") await stage.dispatchEvent("pointercancel");
      if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up();
    };
    for (const kind of ["escape", "pointer", "blur"]) { await drag(kind); near(await page.getByLabel("起点X", { exact: true }).inputValue(), 0); assert.deepEqual(await save(), bones); }
    await drag(); near(await page.getByLabel("起点X", { exact: true }).inputValue(), 1.3); assert.ok(touching(await save()));
    await button("重置视角").click(); await capture("vertex-snap-dark"); await undo();
    console.log("PASS 开关、方向键与真实手柄吸附、隐藏目标排除、撤销重做和 Esc/指针/失焦取消");
    await button("target 立方体 1").click({ modifiers: ["Control"] }); await stage.focus(); await page.keyboard.press("ArrowRight");
    saved = await save(); near(saved[0].cubes[0].origin[0], 1); near(saved[1].cubes[0].origin[0], 4.3); assert.equal(await page.getByRole("status", { name: "顶点吸附状态" }).innerText().then(s => s.includes("已吸附")), false); await undo();
    await button("source 立方体 1").click(); await stage.focus(); await page.keyboard.press("ArrowRight");
    const output = artifactPath("outputs/snapped.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const imported = importProject(JSON.parse(await fs.readFile(output, "utf8"))).bones; imported[0].cubes[0].name = "a"; imported[1].cubes[0].name = "b"; assert.ok(touching(imported));
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual(await read(), bones);
    await fs.rmdir(file + ".bak"); assert.ok(touching(await save())); await close(); await launch(); assert.ok(touching(await read()));
    await button("source 立方体 1").click(); assert.equal(await button("顶点吸附").getAttribute("aria-pressed"), "false"); await button("顶点吸附").click();
    await choose("预览布局", "四视图");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1100, 760); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("vertex-snap-four-light");
    assert.equal(await page.locator('.model-view-cell:visible').count(), 4); assert.deepEqual(errors, []);
    console.log("PASS 多选不互吸、未保存工程导出、保存失败重试、重开、四视图和浅色布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
