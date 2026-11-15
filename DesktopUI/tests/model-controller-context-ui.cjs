const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "context");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.geo.json"), controllerFile = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(file, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.context_ui", texture_width: 16, texture_height: 16 },
    bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] }] }] }));
  const clip = (rotation, position = 0, scale = 1) => ({ loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, rotation], position: [0, position, 0], scale: [scale, 1, 1] } } });
  const animations = {
    "animation.idle": clip(0),
    "animation.move": clip("q.ground_speed * 20 + q.is_sneaking * 10", "query.vertical_speed", "q.is_in_water ? 1.4 : 1"),
    "animation.air": clip(-30, "q.vertical_speed"),
    "animation.ref_walk": clip(30, 1),
    "animation.ref_sprint": clip(60, 2),
    "animation.ref_water": clip(70, 2, 1.4),
    "animation.ref_air": clip(-30, 2),
  };
  await fs.writeFile(animFile, JSON.stringify({ animations }));
  const id = "controller.animation.context";
  const doc = { animation_controllers: {
    [id]: { initial_state: "idle", states: {
      idle: { animations: ["animation.idle"], transitions: [{ move: "q.is_moving && query.is_on_ground" }] },
      move: { animations: [{ "animation.move": "q.is_sprinting ? 1 : 0.5" }], transitions: [{ air: "!q.is_on_ground" }, { idle: "!q.is_moving" }] },
      air: { animations: ["animation.air"], transitions: [{ idle: "q.is_on_ground" }] },
      walk_ref: { animations: ["animation.ref_walk"] }, sprint_ref: { animations: ["animation.ref_sprint"] }, water_ref: { animations: ["animation.ref_water"] }, air_ref: { animations: ["animation.ref_air"] },
    } },
    "controller.animation.unknown": { initial_state: "default", states: { default: { animations: [], transitions: [{ end: "query.unknown_preview" }] }, end: { animations: [] } } },
  } };
  await fs.writeFile(controllerFile, JSON.stringify(doc));
  const originals = await Promise.all([file, controllerFile, animFile].map(p => fs.readFile(p)));
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const queryPanel = () => page.getByRole("region", { name: "模拟查询" });
  const enable = () => page.getByRole("checkbox", { name: "启用模拟查询", exact: true });
  const query = name => page.getByRole("checkbox", { name: "模拟" + name, exact: true });
  const speed = () => page.getByLabel("模拟水平速度（米/秒）", { exact: true });
  const vertical = () => page.getByLabel("模拟垂直速度（米/秒）", { exact: true });
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.context_ui" }).click(); await button("动画").click(); await enable().waitFor();
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
  const compare = (a, b) => {
    assert.equal(a.pixels.length, b.pixels.length); let changed = 0;
    for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) changed++;
    assert.ok(changed < 150, "模拟查询产生的姿势必须与数字参考动画一致：" + changed);
  };
  try {
    await launch();
    const refs = {};
    for (const name of ["walk", "sprint", "water", "air"]) {
      await select("控制器状态", name + "_ref"); await button("播放控制器").click(); await button("暂停控制器").click();
      refs[name] = await capture("ref-" + name, true);
    }
    await select("控制器状态", "idle · 初始");
    assert.equal(await enable().isChecked(), false);
    await button("播放控制器").click(); await page.getByRole("alert").filter({ hasText: "未提供模拟查询值" }).waitFor();
    await enable().check(); await speed().fill("3"); await vertical().fill("2");
    await button("播放控制器").click(); await status().filter({ hasText: "idle · animation.idle" }).waitFor();
    await query("移动").check(); await status().filter({ hasText: "move · animation.move × 0.5" }).waitFor();
    await button("暂停控制器").click(); compare(await capture("query-walk", true), refs.walk);
    const time = (await status().innerText()).split(" · ").at(-1);
    await query("疾跑").check(); await status().filter({ hasText: "move · animation.move ·" }).waitFor();
    compare(await capture("query-sprint", true), refs.sprint);
    assert.equal((await status().innerText()).split(" · ").at(-1), time);
    await query("潜行").check(); await query("在水中").check(); compare(await capture("query-water", true), refs.water);
    await query("着地").uncheck();
    assert.ok((await status().innerText()).startsWith("move ·"), "暂停修改条件不能推进状态");
    await button("播放控制器").click(); await status().filter({ hasText: "air · animation.air" }).waitFor(); await button("暂停控制器").click();
    compare(await capture("query-air", true), refs.air);
    await query("着地").check(); await query("移动").uncheck(); await button("播放控制器").click();
    await status().filter({ hasText: "idle · animation.idle" }).waitFor(); await button("暂停控制器").click();
    await speed().fill("101"); await queryPanel().getByRole("alert").waitFor();
    const stopped = await status().innerText(); await button("播放控制器").click();
    assert.equal(await button("暂停控制器").count(), 0); assert.equal(await status().innerText(), stopped);
    await speed().fill("3"); await queryPanel().getByRole("alert").waitFor({ state: "detached" });
    await query("移动").check(); await query("潜行").uncheck(); await query("在水中").uncheck(); await query("疾跑").uncheck();
    await button("播放控制器").click(); await status().filter({ hasText: "move ·" }).waitFor(); await button("暂停控制器").click();
    compare(await capture("query-recovered", true), refs.walk);
    await enable().uncheck(); await page.getByRole("alert").filter({ hasText: "未提供模拟查询值" }).waitFor();
    await enable().check(); compare(await capture("query-reenabled", true), refs.walk);
    await capture("context-dark");
    await button("重置模拟值").click();
    assert.equal(await speed().inputValue(), "0"); assert.equal(await vertical().inputValue(), "0");
    assert.equal(await query("移动").isChecked(), false); assert.equal(await query("着地").isChecked(), true);
    assert.ok((await status().innerText()).startsWith("move ·"), "重置模拟值仅改变上下文");
    await button("播放控制器").click(); await status().filter({ hasText: "idle ·" }).waitFor(); await button("暂停控制器").click();
    const output = artifactPath("outputs/context.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output));
    assert.deepEqual(project.animation_controllers, doc.animation_controllers);
    await select("控制器", "controller.animation.unknown");
    assert.equal(await enable().isChecked(), false);
    await enable().check(); await button("播放控制器").click(); await page.getByRole("alert").filter({ hasText: "query.unknown_preview" }).waitFor();
    await select("控制器", id); assert.equal(await enable().isChecked(), false); await enable().check();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await speed().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("context-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await close(); await launch(); assert.equal(await enable().isChecked(), false); await enable().check(); assert.equal(await speed().inputValue(), "0");
    const after = await Promise.all([file, controllerFile, animFile].map(p => fs.readFile(p)));
    after.forEach((bytes, i) => assert.deepEqual(bytes, originals[i]));
    assert.deepEqual(errors, []);
    console.log("PASS 模拟查询驱动转移/权重/骨骼、暂停姿势与续播、速度边界及恢复、未启用/未知查询拒绝、三维像素参考、清空/跨控制器隔离/重启、源文件不变和深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
