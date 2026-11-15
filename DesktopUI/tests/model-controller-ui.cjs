const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller");
  await fs.mkdir(folder, { recursive: true });
  const geometry = id => ({ "minecraft:geometry": [{ description: { identifier: id, texture_width: 16, texture_height: 16 },
    bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] }] }] });
  const file = path.join(folder, "model.geo.json"), controllerFile = path.join(folder, "model.animation_controllers.json");
  await fs.writeFile(file, JSON.stringify(geometry("geometry.controller_ui")), "utf8");
  for (const [name, angle] of [["idle", 0], ["walk", 60], ["done", -45]]) await fs.writeFile(path.join(folder, name + ".animation.json"), JSON.stringify({
    format_version: "1.8.0", animations: { ["animation." + name]: { loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, angle] } } } },
  }), "utf8");
  const doc = { format_version: "1.10.0", animation_controllers: {
    "controller.animation.mob": { initial_state: "default", states: {
      default: { animations: ["animation.idle"], transitions: [{ walk: "query.anim_time > 0.45" }], keep: "unknown-field" },
      walk: { animations: ["animation.walk"], transitions: [{ done: "query.anim_time > 1.3" }] },
      done: { animations: ["animation.done"] },
    } },
    "controller.animation.bad": { initial_state: "default", states: {
      default: { animations: ["animation.idle"], transitions: [{ stop: "query.is_moving" }] }, stop: { animations: [] },
    } },
    "controller.animation.missing": { initial_state: "default", states: { default: { animations: ["animation.absent"] } } },
  } };
  await fs.writeFile(controllerFile, JSON.stringify(doc), "utf8");
  const original = await fs.readFile(controllerFile);
  const blank = path.join(data, "model-studio", "blank");
  await fs.mkdir(blank);
  await fs.writeFile(path.join(blank, "model.geo.json"), JSON.stringify(geometry("geometry.controller_blank")));
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const combo = name => page.getByRole("combobox", { name, exact: true });
  const select = async (name, option) => { await combo(name).click(); await page.getByRole("option", { name: option, exact: true }).click(); };
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const capture = async (name, crop = false) => {
    await settle();
    const rect = crop ? await page.locator(".model-view-cell:not([hidden]) canvas").boundingBox() : null;
    const base64 = await app.evaluate(async ({ BrowserWindow }, rect) => {
      const area = rect && Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.floor(value)]));
      return (await BrowserWindow.getAllWindows()[0].webContents.capturePage(area || undefined)).toPNG().toString("base64");
    }, rect);
    const bytes = Buffer.from(base64, "base64"); await fs.writeFile(artifactPath("outputs/" + name + ".png"), bytes);
    return decodePng(bytes);
  };
  const changed = (a, b) => {
    assert.equal(a.pixels.length, b.pixels.length);
    let count = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) count++;
    return count;
  };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await button("模组与资源").click(); await button("模型制作").click();
  };
  const open = async id => { await page.locator(".model-library-open").filter({ hasText: id }).click(); await button("动画").click(); };
  const close = async () => {
    if (!app) return;
    const instance = app; app = null;
    const timer = setTimeout(() => instance.process().kill(), 5000);
    try { await instance.close(); } finally { clearTimeout(timer); }
  };
  try {
    await launch(); await open("geometry.controller_ui");
    await combo("控制器状态").waitFor();
    assert.match(await combo("控制器").innerText(), /controller.animation.mob/);
    await button("播放控制器").click();
    await status().filter({ hasText: "walk · animation.walk" }).waitFor();
    await button("暂停控制器").click();
    const paused = await status().innerText(), walk = await capture("walk", true);
    await page.waitForTimeout(350);
    assert.equal(await status().innerText(), paused);
    await button("播放控制器").click();
    await status().filter({ hasText: "done · animation.done" }).waitFor();
    await button("暂停控制器").click();
    const done = await capture("done", true);
    assert.ok(changed(walk, done) > 500, "三维视口必须显示不同状态的真实姿势");
    await capture("controller-dark");
    await button("重置控制器").click();
    await select("控制器状态", "walk"); await button("播放控制器").click(); await button("暂停控制器").click();
    const manuallySelected = await capture("manual-walk", true);
    assert.ok(changed(walk, manuallySelected) < 150, "手动状态与运行状态的三维姿势一致");
    await button("播放").click();
    await status().filter({ hasText: "从所选状态开始" }).waitFor();
    await button("暂停").click();
    await select("控制器", "controller.animation.bad"); await button("播放控制器").click();
    await page.getByRole("alert").filter({ hasText: "query.is_moving" }).waitFor();
    assert.equal(await button("暂停控制器").count(), 0);
    await select("控制器", "controller.animation.missing"); await button("播放控制器").click();
    await page.getByRole("alert").filter({ hasText: "animation.absent" }).waitFor();
    assert.deepEqual(await fs.readFile(controllerFile), original, "预览不写文件");
    await select("控制器", "controller.animation.mob");
    // 真实备份写入失败，界面不得先切换状态或报成功。
    await fs.mkdir(controllerFile + ".bak");
    await page.getByLabel("新状态名称", { exact: true }).fill("extra");
    await button("添加状态").click(); await page.locator(".model-controller-editor > [role=alert]").waitFor();
    assert.match(await combo("控制器状态").innerText(), /default/);
    assert.deepEqual(await fs.readFile(controllerFile), original);
    await fs.rmdir(controllerFile + ".bak");
    await button("添加状态").click(); await page.getByText("已添加状态", { exact: true }).waitFor();
    assert.equal((await combo("控制器状态").innerText()).trim(), "extra");
    assert.deepEqual(await fs.readFile(controllerFile + ".bak"), original);
    await select("加入的动画", "animation.walk"); await button("加入动画").click();
    await page.getByText("已加入动画", { exact: true }).waitFor();
    await select("转移目标", "done"); await page.getByLabel("转移条件", { exact: true }).fill("query.anim_time > 0.7");
    await button("添加转移").click(); await page.getByText("已添加转移", { exact: true }).waitFor();
    let saved = JSON.parse(await fs.readFile(controllerFile));
    assert.deepEqual(saved.animation_controllers["controller.animation.mob"].states.extra.animations, ["animation.walk"]);
    assert.equal(saved.animation_controllers["controller.animation.mob"].states.default.keep, "unknown-field");
    saved.external = true; await fs.writeFile(controllerFile, JSON.stringify(saved));
    await button("设为初始").click(); await page.getByRole("alert").filter({ hasText: "控制器已变化" }).waitFor();
    assert.equal(JSON.parse(await fs.readFile(controllerFile)).external, true);
    await button("重新读取").click(); await combo("控制器状态").waitFor();
    await select("控制器状态", "extra"); await button("设为初始").click(); await page.getByText("已设为初始状态", { exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await button("播放控制器").scrollIntoViewIfNeeded(); await capture("controller-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await close(); await launch(); await open("geometry.controller_ui");
    await combo("控制器状态").filter({ hasText: "extra · 初始" }).waitFor();
    await button("退出编辑").click(); await open("geometry.controller_blank");
    await button("新建控制器").click(); await combo("控制器状态").waitFor();
    assert.equal(JSON.parse(await fs.readFile(path.join(blank, "model.animation_controllers.json"))).animation_controllers["controller.animation.mob"].initial_state, "default");
    await button("播放控制器").click(); await status().filter({ hasText: "静止姿势" }).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS 真实 IPC、连续转移与暂停恢复、三维姿势像素对比、上下文切换、未知查询/缺失动画、保存失败重试/外部冲突、备份/重启和窄窗主题");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
