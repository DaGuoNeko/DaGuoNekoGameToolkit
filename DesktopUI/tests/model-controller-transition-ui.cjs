const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "transition");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.transition_ui", texture_width: 16, texture_height: 16 },
    bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] }] }] }));
  const clip = (rotation, position, scale) => ({ loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, rotation], position: [position, 0, 0], scale: [scale, 1, 1] } } });
  const animations = { "animation.a": clip(0, 0, 1.1), "animation.b": clip(80, 2, 1.3), "animation.reference": clip(0, 0, 1) };
  const animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(animFile, JSON.stringify({ animations }));
  const controllerFile = path.join(folder, "model.animation_controllers.json");
  const id = "controller.animation.transition";
  const doc = { format_version: "1.10.0", untouched: true, animation_controllers: {
    [id]: { initial_state: "a", states: {
      a: { animations: ["animation.a"], transitions: [{ b: "q.anim_time >= 0.2" }], keep: "source" },
      b: { animations: ["animation.b"], blend_transition: 9 },
      reference: { animations: ["animation.reference"] },
    } },
    "controller.animation.curve": { initial_state: "default", states: { default: { animations: [], blend_transition: { "0": 1, "1": 2 } } } },
  } };
  await fs.writeFile(controllerFile, JSON.stringify(doc)); const original = await fs.readFile(controllerFile);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const combo = name => page.getByRole("combobox", { name, exact: true });
  const select = async (name, option) => { await combo(name).click(); await page.getByRole("option", { name: option, exact: true }).click(); };
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const progress = () => page.getByRole("status", { name: "状态过渡进度" });
  const duration = () => page.getByLabel("状态过渡时长", { exact: true });
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.transition_ui" }).click(); await button("动画").click(); await duration().waitFor();
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
    let changed = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) changed++;
    return changed;
  };
  try {
    await launch(); await duration().fill("-1"); await button("保存过渡时长").click();
    await page.locator(".model-controller-editor > [role=alert]").filter({ hasText: "0–60" }).waitFor();
    assert.deepEqual(await fs.readFile(controllerFile), original);
    await duration().fill("2"); await fs.mkdir(controllerFile + ".bak");
    await button("保存过渡时长").click(); await page.locator(".model-controller-editor > [role=alert]").filter({ hasText: "只能修改普通文件" }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="状态过渡时长"]').disabled);
    assert.deepEqual(await fs.readFile(controllerFile), original); assert.equal(await duration().inputValue(), "2");
    await fs.rmdir(controllerFile + ".bak"); await button("保存过渡时长").click();
    await page.getByText("已保存状态过渡时长", { exact: true }).waitFor();
    const saved = await fs.readFile(controllerFile);
    assert.equal(JSON.parse(saved).animation_controllers[id].states.a.blend_transition, 2);
    assert.deepEqual(await fs.readFile(controllerFile + ".bak"), original);
    await button("播放控制器").click();
    await progress().waitFor();
    await page.waitForFunction(() => {
      const text = document.querySelector('[aria-label="控制器播放状态"]')?.textContent || "";
      return text.startsWith("b ·") && Number(text.split(" · ").at(-1).split(" ")[0]) >= 0.8;
    });
    await button("暂停控制器").click();
    const paused = await status().innerText(), pausedProgress = await progress().innerText();
    const t = Number(paused.split(" · ").at(-1).split(" ")[0]), alpha = t / 2;
    assert.ok(alpha > 0 && alpha < 1);
    assert.ok(Math.abs(Number(pausedProgress.split(" · ")[1].replace("%", "")) - alpha * 100) < 1);
    const middle = await capture("transition-middle", true); await capture("transition-dark");
    await page.waitForTimeout(250); assert.equal(await status().innerText(), paused); assert.equal(await progress().innerText(), pausedProgress);
    await button("播放控制器").click(); await progress().waitFor({ state: "detached" }); await button("暂停控制器").click();
    const end = await capture("transition-end", true);
    assert.ok(different(middle, end) > 500);
    // 独立按显示的状态时间计算参考姿势，容许显示时间两位小数造成的亚像素偏差。
    animations["animation.reference"] = clip(80 * alpha, 2 * alpha, (1 + 0.3 * alpha) * (1 + 0.1 * (1 - alpha)));
    await fs.writeFile(animFile, JSON.stringify({ animations }));
    await select("控制器状态", "reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    const reference = await capture("transition-reference", true);
    assert.ok(different(middle, reference) < 500, "中间过渡应与独立参考姿势一致");
    assert.deepEqual(await fs.readFile(controllerFile), saved, "播放与暂停不能写回控制器");
    const output = artifactPath("outputs/transition.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    assert.equal(JSON.parse(await fs.readFile(output)).animation_controllers[id].states.a.blend_transition, 2);
    await select("控制器状态", "a · 初始");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await duration().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("transition-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await close(); await launch(); assert.equal(await duration().inputValue(), "2");
    await duration().fill(""); await button("保存过渡时长").click();
    await page.getByText("已保存状态过渡时长", { exact: true }).waitFor();
    assert.equal(JSON.parse(await fs.readFile(controllerFile)).animation_controllers[id].states.a.blend_transition, undefined);
    await button("播放控制器").click(); await status().filter({ hasText: "b · animation.b" }).waitFor(); await button("暂停控制器").click();
    assert.equal(await progress().count(), 0, "默认零时长立即切换，不能使用目标状态的 9 秒");
    const beforeUnsupported = await fs.readFile(controllerFile);
    await select("控制器", "controller.animation.curve");
    await page.getByRole("note").filter({ hasText: "保留原数据" }).waitFor();
    assert.equal(await button("保存过渡时长").count(), 0);
    await button("播放控制器").click(); await page.getByRole("alert").filter({ hasText: "权重" }).waitFor();
    assert.deepEqual(await fs.readFile(controllerFile), beforeUnsupported);
    assert.deepEqual(errors, []);
    console.log("PASS 状态过渡时长编辑/失败重试/备份、来源时长、过渡中间姿势像素对照、暂停续播/完成/零时长、导出重启、自定义曲线保护和窄窗主题");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
