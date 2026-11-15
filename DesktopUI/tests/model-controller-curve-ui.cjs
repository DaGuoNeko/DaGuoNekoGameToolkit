const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "transition-curve");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.transition_curve", texture_width: 16, texture_height: 16 },
    bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] }] }] }));
  const clip = (rotation, position, scale) => ({ loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, rotation], position: [position, 0, 0], scale: [scale, 1, 1] } } });
  const animations = { "animation.a": clip(0, 0, 1.1), "animation.b": clip(80, 2, 1.3), "animation.reference": clip(0, 0, 1) };
  const animFile = path.join(folder, "model.animation.json"), file = path.join(folder, "model.animation_controllers.json"), id = "controller.animation.curve";
  await fs.writeFile(animFile, JSON.stringify({ animations }));
  const source = { format_version: "1.10.0", keep: true, animation_controllers: { [id]: { initial_state: "a", states: {
    a: { animations: ["animation.a"], blend_transition: 2, transitions: [{ b: "q.anim_time >= 0.2" }], keep: "unknown" },
    b: { animations: ["animation.b"] }, reference: { animations: ["animation.reference"] },
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const modal = () => page.getByRole("dialog");
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const progress = () => page.getByRole("status", { name: "状态过渡进度" });
  const select = async (name, value, scope = page) => { await scope.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const read = async () => JSON.parse(await fs.readFile(file));
  const curveOf = value => value.animation_controllers[id].states.a.blend_transition;
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.transition_curve" }).click(); await button("动画").click(); await button("编辑过渡曲线").waitFor();
  };
  const close = async () => {
    if (!app) return; const current = app; app = null; const timer = setTimeout(() => current.process().kill(), 5000);
    try { await current.close(); } finally { clearTimeout(timer); }
  };
  const capture = async (name, crop = false) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = crop ? await page.locator(".model-view-cell:not([hidden]) canvas").boundingBox() : null;
    const png = await app.evaluate(async ({ BrowserWindow }, box) => {
      const rect = box && Object.fromEntries(Object.entries(box).map(([key, n]) => [key, Math.floor(n)]));
      return (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect || undefined)).toPNG().toString("base64");
    }, box);
    const bytes = Buffer.from(png, "base64"); await fs.writeFile(artifactPath("outputs/" + name + ".png"), bytes); return decodePng(bytes);
  };
  const different = (a, b) => {
    assert.equal(a.pixels.length, b.pixels.length);
    let count = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) count++;
    return count;
  };
  const openCurve = async () => { await button("编辑过渡曲线").click(); await modal().getByRole("heading", { name: "状态过渡曲线", exact: true }).waitFor(); };
  try {
    await launch(); await openCurve(); await select("曲线预设", "缓入", modal());
    const handle = () => modal().getByRole("slider", { name: "过渡曲线点 2", exact: true });
    const before = await handle().getAttribute("aria-valuetext");
    for (const cancel of ["escape", "pointer", "blur"]) {
      const box = await handle().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + 24, box.y + 25, { steps: 4 });
      if (cancel === "escape") await page.keyboard.press("Escape");
      if (cancel === "pointer") await handle().dispatchEvent("pointercancel");
      if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up(); assert.equal(await handle().getAttribute("aria-valuetext"), before);
      assert.deepEqual(await fs.readFile(file), original);
    }
    const box = await handle().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 20, box.y + 15, { steps: 4 }); await page.mouse.up();
    assert.notEqual(await handle().getAttribute("aria-valuetext"), before);
    await handle().focus(); await handle().press("ArrowDown");
    await button("取消").click(); assert.deepEqual(await fs.readFile(file), original);
    await openCurve(); await button("添加中间点").click();
    assert.equal(await modal().getByLabel("时间比例", { exact: true }).inputValue(), "0.5");
    await modal().getByLabel("源状态权重", { exact: true }).fill("0.8");
    await button("添加中间点").click(); assert.equal(await modal().getByRole("slider").count(), 4);
    await button("删除曲线点").click(); assert.equal(await modal().getByRole("slider").count(), 3);
    await modal().getByLabel("时间比例", { exact: true }).fill("1");
    await modal().getByRole("alert").waitFor(); assert.equal(await button("应用过渡曲线").isDisabled(), true);
    await modal().getByLabel("源状态权重", { exact: true }).fill("0.7");
    assert.equal(await button("应用过渡曲线").isDisabled(), true);
    await modal().getByLabel("源状态权重", { exact: true }).fill("0.8");
    await modal().getByLabel("时间比例", { exact: true }).fill("0.5");
    await capture("curve-editor-dark"); await fs.mkdir(file + ".bak");
    await button("应用过渡曲线").click(); await modal().getByRole("alert").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.deepEqual(await fs.readFile(file), original); assert.equal(await button("应用过渡曲线").isDisabled(), false);
    await fs.rmdir(file + ".bak"); await button("应用过渡曲线").click(); await modal().waitFor({ state: "detached" });
    const saved = await fs.readFile(file);
    assert.deepEqual(curveOf(await read()), { "0": 1, "1": 0.8, "2": 0 }); assert.deepEqual(await fs.readFile(file + ".bak"), original);
    await button("播放控制器").click(); await progress().waitFor();
    await page.waitForFunction(() => {
      const text = document.querySelector('[aria-label="控制器播放状态"]')?.textContent || "";
      return text.startsWith("b ·") && Number(text.split(" · ").at(-1).split(" ")[0]) >= 0.8;
    });
    await button("暂停控制器").click();
    const paused = await status().innerText(), stopped = await progress().innerText(), t = Number(paused.split(" · ").at(-1).split(" ")[0]);
    const alpha = t <= 1 ? 0.2 * t : 0.2 + 0.8 * (t - 1);
    const image = await capture("curve-pose", true); await capture("curve-preview-dark");
    await page.waitForTimeout(250); assert.equal(await status().innerText(), paused); assert.equal(await progress().innerText(), stopped);
    await button("播放控制器").click(); await progress().waitFor({ state: "detached" }); await button("暂停控制器").click();
    assert.ok(different(image, await capture("curve-end", true)) > 500);
    animations["animation.reference"] = clip(80 * alpha, 2 * alpha, (1 + 0.3 * alpha) * (1 + 0.1 * (1 - alpha)));
    await fs.writeFile(animFile, JSON.stringify({ animations }));
    await select("控制器状态", "reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    assert.ok(different(image, await capture("curve-reference", true)) < 500, "曲线姿势须与独立插值参考图一致");
    assert.deepEqual(await fs.readFile(file), saved);
    await select("控制器状态", "a · 初始");
    await page.getByLabel("状态过渡时长", { exact: true }).fill("4"); await button("保存过渡时长").click();
    await page.getByText("已保存状态过渡时长", { exact: true }).waitFor();
    assert.deepEqual(curveOf(await read()), { "0": 1, "2": 0.8, "4": 0 });
    const output = artifactPath("outputs/curve.bbmodel");
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output));
    assert.deepEqual(project.animation_controllers, (await read()).animation_controllers);
    assert.deepEqual(importProject(project).controllers, project.animation_controllers);
    await close(); await launch(); assert.equal(await page.getByLabel("状态过渡时长", { exact: true }).inputValue(), "4");
    await openCurve(); await select("选中曲线点", "点 1 · 0.5", modal()); assert.equal(await modal().getByLabel("源状态权重", { exact: true }).inputValue(), "0.8");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("curve-small-light");
    assert.equal(await modal().evaluate(node => { const r = node.getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), true);
    await select("曲线预设", "缓出", modal()); await button("取消").click();
    assert.deepEqual(curveOf(await read()), { "0": 1, "2": 0.8, "4": 0 });
    await openCurve(); await select("曲线预设", "线性", modal()); await button("应用过渡曲线").click(); await modal().waitFor({ state: "detached" });
    assert.equal(curveOf(await read()), 4); assert.equal((await read()).animation_controllers[id].states.a.keep, "unknown");
    assert.deepEqual(errors, []);
    console.log("PASS 自定义过渡曲线预设/增删点/拖动/键盘/取消、无效输入、保存失败重试/备份、非线性三维像素参考、暂停续播、时长缩放、工程往返/重启/恢复线性和深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
