const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { sampleTrack, trackOf } = require("../src/features/skins/npc-clip.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "bezier"), file = path.join(folder, "curve.animation.json");
  await fs.mkdir(folder, { recursive: true });
  const geometry = { "minecraft:geometry": [{ description: { identifier: "geometry.bezier", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }] }] };
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify(geometry));
  const source = { loop: false, animation_length: 2, bones: { body: { rotation: { "0": { post: [0, 0, 0], note: "keep" }, "1.000": { post: [80, 20, 40], note: "end" }, "2": [0, 0, 0] }, position: [1, 2, 3] } } };
  const smooth = structuredClone(source); smooth.bones.body.rotation["1.000"].lerp_mode = "catmullrom";
  await fs.writeFile(file, JSON.stringify({ animations: { "animation.bezier": source, "animation.smooth": smooth } }));
  const read = async () => JSON.parse(await fs.readFile(file, "utf8")).animations["animation.bezier"];
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator(".model-library-open").filter({ hasText: "geometry.bezier" }).click();
    await page.getByRole("button", { name: "动画", exact: true }).click(); await page.getByRole("button", { name: "animation.bezier", exact: true }).click(); await page.locator('.model-bone-list').getByRole("button", { name: "body", exact: true }).click();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), modal = () => page.getByRole("dialog");
    const open = async () => { await page.getByRole("tab", { name: "曲线", exact: true }).click(); await button("贝塞尔缓动").click(); await modal().getByRole("heading", { name: "贝塞尔缓动", exact: true }).waitFor(); };
    await open();
    const handle = modal().getByRole("slider", { name: "起点控制点", exact: true });
    const originalControl = await handle.getAttribute("aria-valuetext");
    const drag = async cancel => {
      const box = await handle.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 25, box.y - 30, { steps: 6 });
      if (cancel === "escape") await page.keyboard.press("Escape"); if (cancel === "pointer") await handle.dispatchEvent("pointercancel"); if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up();
    };
    for (const cancel of ["escape", "pointer", "blur"]) { await drag(cancel); assert.equal(await handle.getAttribute("aria-valuetext"), originalControl); assert.deepEqual(await read(), source); }
    await drag(); assert.notEqual(await handle.getAttribute("aria-valuetext"), originalControl); assert.deepEqual(await read(), source);
    await handle.focus(); await handle.press("ArrowUp");
    await modal().getByLabel("起点时间比例", { exact: true }).fill("0.9"); await modal().getByLabel("终点时间比例", { exact: true }).fill("0.2"); await modal().getByRole("alert").filter({ hasText: "控制点" }).waitFor(); assert.equal(await button("生成关键帧").isDisabled(), true);
    await button("取消").click(); assert.deepEqual(await read(), source);
    await open();
    for (const [name, value] of [["起点时间比例", "0.25"], ["起点数值比例", "0"], ["终点时间比例", "0.75"], ["终点数值比例", "0"]]) await modal().getByLabel(name, { exact: true }).fill(value);
    await capture("bezier-controls-dark");
    await fs.mkdir(file + ".bak"); await button("生成关键帧").click(); await modal().getByRole("alert").waitFor(); assert.deepEqual(await read(), source); assert.equal(await modal().count(), 1);
    await fs.rmdir(file + ".bak"); await button("生成关键帧").click(); await page.getByText("已生成贝塞尔关键帧，可一次撤销", { exact: true }).waitFor();
    const baked = await read(); assert.equal(Object.keys(baked.bones.body.rotation).length, 22); assert.deepEqual(baked.bones.body.rotation["0.50"], [10, 10, 20]); assert.deepEqual(baked.bones.body.rotation["0"], source.bones.body.rotation["0"]); assert.deepEqual(baked.bones.body.rotation["1.000"], source.bones.body.rotation["1.000"]); assert.deepEqual(baked.bones.body.position, source.bones.body.position);
    assert.deepEqual(JSON.parse(await fs.readFile(file + ".bak", "utf8")).animations["animation.bezier"], source);
    const time = page.getByRole("slider", { name: "时间", exact: true }); await time.fill("0.5"); await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转X"]').value) === 10);
    const curveValue = await page.locator('.model-curve').evaluate(node => { const points = node.querySelector('polyline').getAttribute('points').split(' ').map(p => p.split(',').map(Number)); const box = node.viewBox.baseVal; const target = 6 + 0.5 / 2 * (box.width - 12); const near = points.reduce((a, b) => Math.abs(a[0] - target) < Math.abs(b[0] - target) ? a : b); return Number(node.dataset.min) + (1 - (near[1] - 10) / (box.height - 20)) * (Number(node.dataset.max) - Number(node.dataset.min)); }); assert.ok(Math.abs(curveValue - 10) < 0.001);
    const timeline = page.locator('.model-timeline'); await timeline.getByRole("button", { name: "撤销", exact: true }).click(); await page.getByText("已撤销", { exact: true }).waitFor(); assert.deepEqual(await read(), source);
    await timeline.getByRole("button", { name: "重做", exact: true }).click(); await page.getByText("已重做", { exact: true }).waitFor(); assert.deepEqual(await read(), baked);
    console.log("PASS 控制点拖动/键盘/取消、无效输入、失败保留预览后重试、真实关键帧与曲线/播放一致、整组撤销重做");
    const output = artifactPath("outputs/bezier.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output, "utf8"));
    const native = Object.values(project.animations.find(item => item.name === "animation.bezier").animators)[0].keyframes.filter(item => item.channel === "rotation");
    assert.equal(native.length, 3);
    assert.ok(native.every(frame => frame.interpolation === "bezier"));
    assert.deepEqual(native[0].bezier_right_time, [0.25, 1 / 3, 1 / 3]);
    const imported = importProject(project).animations["animation.bezier"];
    for (const at of [0.025, 0.25, 0.5, 0.75, 0.975, 1.25]) assert.deepEqual(sampleTrack(trackOf(imported.bones.body.rotation), at), sampleTrack(trackOf(baked.bones.body.rotation), at));
    await capture("bezier-baked-timeline"); await close(); await launch(); await page.getByRole("slider", { name: "时间", exact: true }).fill("0.5"); await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转X"]').value) === 10);
    await button("animation.smooth").click(); await open(); await modal().getByRole("alert").filter({ hasText: "线性" }).waitFor(); assert.equal(await button("生成关键帧").isDisabled(), true);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("bezier-small-light");
    const fits = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }); assert.equal(fits, true);
    assert.deepEqual(await read(), baked); assert.deepEqual(errors, []); console.log("PASS 工程导出往返、重启播放、平滑区间拒绝、小窗口与浅色主题"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
