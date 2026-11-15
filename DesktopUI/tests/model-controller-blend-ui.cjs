const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-blend");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_blend", texture_width: 16, texture_height: 16 },
    bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] }] }] }));
  const values = { a: [20, 0.5, 1.1], b: [40, 1, 1.2], full: [60, 1.5, 1.32], half: [40, 1, 1.21], zero: [20, 0.5, 1.1] };
  const animations = {};
  for (const [name, [rotation, position, scale]] of Object.entries(values)) animations["animation." + name] = {
    loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, rotation], position: [position, 0, 0], scale: [scale, 1, 1] } },
  };
  const animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(animFile, JSON.stringify({ animations }));
  const originalAnimations = await fs.readFile(animFile);
  const controllerFile = path.join(folder, "model.animation_controllers.json");
  const doc = { format_version: "1.10.0", keep: true, animation_controllers: { "controller.animation.mix": { initial_state: "mix", states: {
    mix: { animations: ["animation.a", "animation.b"], unknown: "keep" },
    full: { animations: ["animation.full"] }, half: { animations: ["animation.half"] }, zero: { animations: ["animation.zero"] },
  } } } };
  await fs.writeFile(controllerFile, JSON.stringify(doc));
  const original = await fs.readFile(controllerFile);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const weight = () => page.getByLabel("动画权重 animation.b", { exact: true });
  const read = async () => JSON.parse(await fs.readFile(controllerFile));
  const entries = value => value.animation_controllers["controller.animation.mix"].states.mix.animations;
  const chooseState = async name => {
    await page.getByRole("combobox", { name: "控制器状态", exact: true }).click();
    await page.getByRole("option", { name: name === "mix" ? "mix · 初始" : name, exact: true }).click();
  };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_blend" }).click(); await button("动画").click();
    await weight().waitFor();
  };
  const close = async () => {
    if (!app) return; const current = app; app = null;
    const timer = setTimeout(() => current.process().kill(), 5000);
    try { await current.close(); } finally { clearTimeout(timer); }
  };
  const capture = async (name, crop = false) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = crop ? await page.locator(".model-view-cell:not([hidden]) canvas").boundingBox() : null;
    const png = await app.evaluate(async ({ BrowserWindow }, box) => {
      const rect = box && Object.fromEntries(Object.entries(box).map(([key, n]) => [key, Math.floor(n)]));
      return (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect || undefined)).toPNG().toString("base64");
    }, box);
    const bytes = Buffer.from(png, "base64"); await fs.writeFile(artifactPath("outputs/" + name + ".png"), bytes);
    return decodePng(bytes);
  };
  const compare = (actual, reference) => {
    assert.equal(actual.pixels.length, reference.pixels.length);
    let changed = 0; for (let i = 0; i < actual.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(actual.pixels[i + k] - reference.pixels[i + k]) > 12)) changed++;
    assert.ok(changed < 150, "混合姿势应与独立计算的单动画参考图一致，差异像素：" + changed);
  };
  const play = async () => { await button("播放控制器").click(); await button("暂停控制器").waitFor(); await button("暂停控制器").click(); };
  const saveWeight = async value => {
    await weight().fill(value); await button("保存权重 animation.b").click();
    await page.waitForFunction(() => { const button = document.querySelector('[aria-label="保存权重 animation.b"]'), input = document.querySelector('[aria-label="动画权重 animation.b"]'); return button && button.disabled && input && !input.disabled; });
    assert.equal(await page.locator(".model-controller-editor > [role=alert]").count(), 0);
  };
  const reference = async name => { await chooseState(name); await play(); const image = await capture("ref-" + name, true); await chooseState("mix"); return image; };
  try {
    await launch();
    const full = await reference("full"), half = await reference("half"), zero = await reference("zero");
    await play(); compare(await capture("mix-full", true), full);
    assert.deepEqual(await fs.readFile(controllerFile), original);
    await weight().fill("0.5"); await fs.mkdir(controllerFile + ".bak");
    await button("保存权重 animation.b").click(); await page.locator(".model-controller-editor > [role=alert]").waitFor();
    assert.deepEqual(await fs.readFile(controllerFile), original);
    assert.equal(await weight().inputValue(), "0.5");
    await fs.rmdir(controllerFile + ".bak"); await button("保存权重 animation.b").click();
    await page.getByText("已保存动画权重", { exact: true }).waitFor();
    assert.deepEqual(entries(await read()), ["animation.a", { "animation.b": 0.5 }]);
    assert.deepEqual(await fs.readFile(controllerFile + ".bak"), original);
    await play(); compare(await capture("mix-half", true), half);
    await button("上移动画 animation.b").click(); await page.getByText("已调整动画顺序", { exact: true }).waitFor();
    assert.deepEqual(entries(await read()), [{ "animation.b": 0.5 }, "animation.a"]);
    await play(); compare(await capture("mix-reordered", true), half);
    await saveWeight("0"); await play(); compare(await capture("mix-zero", true), zero);
    await saveWeight(""); assert.deepEqual(entries(await read()), ["animation.b", "animation.a"]);
    await play(); compare(await capture("mix-default", true), full);
    const beforeReject = await fs.readFile(controllerFile);
    await weight().fill("2"); await button("保存权重 animation.b").click();
    await page.locator(".model-controller-editor > [role=alert]").filter({ hasText: "0–1" }).waitFor();
    assert.deepEqual(await fs.readFile(controllerFile), beforeReject);
    await weight().press("Escape"); assert.equal(await weight().inputValue(), "");
    await saveWeight("query.is_moving"); await button("播放控制器").click();
    await page.getByRole("alert").filter({ hasText: "animation.b 权重" }).waitFor();
    assert.equal(await button("暂停控制器").count(), 0);
    const expression = "q.anim_time < 0.6 ? 0 : 0.5";
    await saveWeight(expression); await button("播放控制器").click();
    await status().filter({ hasText: "animation.b × 0.5" }).waitFor(); await button("暂停控制器").click();
    compare(await capture("mix-time-weight", true), half);
    const paused = await status().innerText(); await page.waitForTimeout(200); assert.equal(await status().innerText(), paused);
    await weight().scrollIntoViewIfNeeded(); await capture("blend-dark");
    const output = artifactPath("outputs/weights.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(output)).animation_controllers, (await read()).animation_controllers);
    assert.equal((await read()).animation_controllers["controller.animation.mix"].states.mix.unknown, "keep");
    await close(); await launch(); assert.equal(await weight().inputValue(), expression);
    await play(); await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "animation.b × 0" }).waitFor();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await weight().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("blend-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await fs.readFile(animFile), originalAnimations);
    assert.deepEqual(errors, []);
    console.log("PASS 多动画全/半/零权重三维像素对照、重排、表达式随时间求值、未知查询拒绝、保存失败重试/备份、工程导出/重启及窄窗主题");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
