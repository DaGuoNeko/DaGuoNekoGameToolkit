const { _electron: electron } = require("playwright");
const { buildSync } = require("esbuild");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { Box3, Vector3 } = require("three");
const { worldVertices } = require("./fixtures/model-positions.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");
const cameraFile = artifactPath("build/align-camera.cjs");
buildSync({ entryPoints: [require.resolve("../src/features/mods/model-camera.js")], bundle: true, platform: "node", format: "cjs", outfile: cameraFile, logLevel: "silent" });
const { createViewCamera, frameViewCamera } = require(cameraFile);

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "point-align"), file = path.join(folder, "model.geo.json"); await fs.mkdir(folder, { recursive: true });
  const bones = [{ name: "source", cubes: [
    { name: "a", origin: [0, 0, 0], size: [2, 2, 2], pivot: [1, 1, 1], uv: [0, 0], extension: true },
    { name: "c", origin: [-4, 0, 0], size: [2, 2, 2], uv: [2, 2] },
  ] }, { name: "target", cubes: [{ name: "b", origin: [8, 3, 4], size: [2, 2, 2], uv: [0, 0] }] }];
  const original = "// keep\n" + JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.point_align", texture_width: 64, texture_height: 64 }, bones }] }, null, 2); await fs.writeFile(file, original);
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones;
  const expected = delta => { const copy = structuredClone(bones); for (const cube of copy[0].cubes) { cube.origin = cube.origin.map((n, i) => n + delta[i]); if (cube.pivot) cube.pivot = cube.pivot.map((n, i) => n + delta[i]); } return copy; };
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator('.model-library-open').filter({ hasText: "geometry.point_align" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(data, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), status = () => page.getByRole("status", { name: "顶点对齐状态", exact: true });
    const choose = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
    const selected = async () => { await button("source 立方体 1").click(); await button("source 立方体 2").click({ modifiers: ["Control"] }); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return read(); };
    const undo = async () => { await button("撤销").click(); assert.deepEqual(await save(), bones); await status().filter({ hasText: "第一步" }).waitFor(); };
    const clickVertex = async (position, view = "south", currentBones = bones) => {
      const cell = page.locator('.model-view-cell[data-view="' + view + '"]:visible').last();
      await cell.getByRole("combobox", { name: "视角", exact: true }).focus(); await button("重置视角").click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const rect = await cell.locator('canvas').boundingBox();
      const bounds = new Box3().setFromPoints(Object.values(worldVertices(currentBones)).flat().map(p => new Vector3(...p).multiplyScalar(1 / 16)));
      const camera = createViewCamera(view); const controls = { target: new Vector3(), update: () => camera.lookAt(controls.target) };
      frameViewCamera(camera, controls, bounds, rect.width, rect.height);
      const screen = new Vector3(...position).multiplyScalar(1 / 16).project(camera);
      await page.mouse.click(rect.x + (screen.x + 1) * rect.width / 2, rect.y + (1 - screen.y) * rect.height / 2);
    };
    await selected(); await choose("视角", "前视图（南）"); await button("顶点对齐").click(); await status().filter({ hasText: "第一步" }).waitFor();
    const stage = page.locator('.model-stage canvas'); const box = await stage.boundingBox(); await page.mouse.click(box.x + 15, box.y + 15); await status().filter({ hasText: "第一步" }).waitFor();
    await clickVertex([2, 2, 2]); await status().filter({ hasText: "第二步" }).waitFor(); assert.deepEqual(await read(), bones);
    await capture("source-selected-dark"); await button("重选源点").click(); await status().filter({ hasText: "第一步" }).waitFor();
    await clickVertex([2, 2, 2]); await stage.focus(); await page.keyboard.press("Escape"); assert.equal(await status().count(), 0); assert.deepEqual(await read(), bones);
    await button("顶点对齐").click(); await clickVertex([2, 2, 2]); await clickVertex([8, 3, 6]);
    await page.getByText("已按三轴对齐顶点，可一次撤销", { exact: true }).waitFor(); assert.deepEqual(await read(), bones, "对齐仅改草稿"); assert.deepEqual(await save(), expected([6, 1, 4]));
    await undo(); await button("重做").click(); assert.deepEqual(await save(), expected([6, 1, 4])); await undo();
    for (const [name, delta] of [["仅世界 X", [6, 0, 0]], ["仅世界 Y", [0, 1, 0]], ["仅世界 Z", [0, 0, 4]]]) {
      await choose("顶点对齐轴", name); await clickVertex([2, 2, 2]); await clickVertex([8, 3, 6]); assert.deepEqual(await save(), expected(delta)); await undo();
    }
    console.log("PASS 实际点选源/目标、空点无变化、重选/Esc、三轴与世界单轴、整组撤销重做");
    await clickVertex([2, 2, 2]); await button("隐藏 target").click(); await status().filter({ hasText: "第一步" }).waitFor(); await status().filter({ hasText: "没有可见" }).waitFor(); await button("显示 target").click();
    await clickVertex([2, 2, 2]); await button("source 立方体 1").click(); await status().filter({ hasText: "第一步" }).waitFor(); await selected();
    await choose("顶点对齐轴", "三轴对齐"); await choose("预览布局", "四视图");
    await clickVertex([2, 2, 2], "south"); await status().filter({ hasText: "第二步" }).waitFor();
    await clickVertex([8, 5, 6], "top"); assert.deepEqual(await save(), expected([6, 3, 4])); await undo();
    console.log("PASS 隐藏/选择变化清除旧源点、四视图跨窗口接续对齐");
    await clickVertex([2, 2, 2], "south"); await clickVertex([8, 3, 6], "south");
    const output = artifactPath("outputs/point-align.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const imported = importProject(JSON.parse(await fs.readFile(output, "utf8"))).bones; assert.deepEqual(imported[0].cubes.map(cube => cube.origin), expected([6, 1, 4])[0].cubes.map(cube => cube.origin));
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual(await read(), bones); await fs.rmdir(file + ".bak"); assert.deepEqual(await save(), expected([6, 1, 4]));
    await capture("point-aligned-four"); await close(); await launch(); assert.deepEqual(await read(), expected([6, 1, 4])); assert.equal(await button("顶点对齐").getAttribute("aria-pressed"), "false");
    await selected(); await button("顶点对齐").click(); await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1100, 760); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("point-align-light");
    const bounds = await page.locator('.model-point-align').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, inner: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }; }); assert.ok(bounds.left >= 0 && bounds.right <= bounds.inner && bounds.scroll <= bounds.client);
    await button("退出对齐").click(); assert.equal(await status().count(), 0); assert.deepEqual(errors, []);
    console.log("PASS 未保存导出、失败保留草稿、重启及浅色窄窗布局，无页面异常"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
