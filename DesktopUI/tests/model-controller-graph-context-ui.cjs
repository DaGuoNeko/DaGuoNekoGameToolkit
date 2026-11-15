const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "graph-context");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.graph_context", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const clip = (angle, y = 0) => ({ animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, angle], position: [0, y, 0] } } });
  await fs.writeFile(animFile, JSON.stringify({ animations: {
    "animation.idle": clip(0), "animation.move": clip("q.ground_speed * 20", "q.vertical_speed"), "animation.air": clip(-40),
    "animation.half": clip(30, 1), "animation.full": clip(60, 2),
  } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.graph_context";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "idle", states: {
    idle: { animations: ["animation.idle"], transitions: [{ move: "q.is_moving" }] },
    move: { animations: [{ "animation.move": "q.is_sprinting ? 1 : 0.5" }], transitions: [{ air: "!q.is_on_ground" }, { idle: "!q.is_moving" }] },
    air: { animations: ["animation.air"], transitions: [{ idle: "q.is_on_ground && !q.is_moving" }] },
    half: { animations: ["animation.half"] }, full: { animations: ["animation.full"] },
  } }, "controller.animation.other": { states: { default: {} } } } };
  await fs.writeFile(file, JSON.stringify(source, null, 2)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const queryPanel = (scope = page) => scope.getByRole("region", { name: "模拟查询", exact: true });
  const enabled = (scope = page) => queryPanel(scope).getByRole("checkbox", { name: "启用模拟查询", exact: true });
  const flag = (name, scope = page) => queryPanel(scope).getByRole("checkbox", { name: "模拟" + name, exact: true });
  const speed = (scope = page) => queryPanel(scope).getByLabel("模拟水平速度（米/秒）", { exact: true });
  const vertical = (scope = page) => queryPanel(scope).getByLabel("模拟垂直速度（米/秒）", { exact: true });
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const graph = async () => {
    await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor();
    await dialog().locator(".model-controller-simulation > summary").click();
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
    assert.ok(changed < 150, "图中模拟姿势须匹配独立数字参考：" + changed);
  };
  const close = async () => { if (!app) return; const current = app; app = null; const timer = setTimeout(() => current.process().kill(), 5000); try { await current.close(); } finally { clearTimeout(timer); } };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.graph_context" }).click(); await button("动画").click(); await enabled().waitFor();
  };
  try {
    await launch(); const refs = {};
    for (const name of ["half", "full"]) {
      await select("控制器状态", name); await button("播放控制器").click(); await button("暂停控制器").click(); refs[name] = await capture("reference-" + name, true);
    }
    await select("控制器状态", "idle · 初始"); await enabled().check(); await speed().fill("3"); await vertical().fill("2");
    await graph(); assert.equal(await enabled(dialog()).isChecked(), true); assert.equal(await speed(dialog()).inputValue(), "3");
    await graphButton("检查图中条件").click(); await dialog().getByRole("region", { name: "转移条件检查" }).waitFor();
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "idle · 播放中" }).waitFor();
    await flag("移动", dialog()).check(); await status().filter({ hasText: "move · 播放中" }).waitFor(); await graphButton("暂停图中预览").click();
    await status().filter({ hasText: "已暂停" }).waitFor(); const paused = await status().innerText();
    await graphButton("关闭").click(); compare(await capture("graph-half", true), refs.half);
    assert.equal(await flag("移动").isChecked(), true); assert.equal(await speed().inputValue(), "3"); assert.equal(await vertical().inputValue(), "2");
    await graph(); assert.equal(await status().innerText(), paused);
    await graphButton("检查图中条件").click(); await dialog().getByRole("region", { name: "转移条件检查" }).waitFor();
    await flag("疾跑", dialog()).check(); await dialog().getByRole("region", { name: "转移条件检查" }).waitFor({ state: "hidden" });
    assert.equal(await status().innerText(), paused); await graphButton("关闭").click(); compare(await capture("graph-full", true), refs.full);
    assert.equal(await flag("疾跑").isChecked(), true); await graph();
    await speed(dialog()).fill("101"); await queryPanel(dialog()).getByRole("alert").waitFor();
    await speed(dialog()).fill(""); await graphButton("检查图中条件").click(); assert.equal(await dialog().getByRole("region", { name: "转移条件检查" }).count(), 0);
    await graphButton("关闭").click(); assert.equal(await speed().inputValue(), ""); await queryPanel().getByRole("alert").waitFor();
    await graph(); await enabled(dialog()).uncheck(); await graphButton("关闭").click(); assert.equal(await enabled().isChecked(), false);
    await graph(); await enabled(dialog()).check(); assert.equal(await speed(dialog()).inputValue(), ""); await queryPanel(dialog()).getByRole("alert").waitFor();
    await speed(dialog()).fill("3"); await queryPanel(dialog()).getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(await flag("移动", dialog()).isChecked(), true); assert.equal(await flag("疾跑", dialog()).isChecked(), true);
    assert.equal(await vertical(dialog()).inputValue(), "2");
    await graphButton("新增状态").click(); assert.equal(await enabled(dialog()).isDisabled(), true); await graphButton("取消状态编辑").click();
    await queryPanel(dialog()).scrollIntoViewIfNeeded(); await capture("graph-simulation-dark");
    await graphButton("重置模拟值").click(); assert.equal(await enabled(dialog()).isChecked(), true); assert.equal(await speed(dialog()).inputValue(), "0");
    assert.equal(await vertical(dialog()).inputValue(), "0"); assert.equal(await flag("移动", dialog()).isChecked(), false);
    assert.equal(await status().innerText(), paused);
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "idle · 播放中" }).waitFor();
    await flag("移动", dialog()).check(); await flag("着地", dialog()).uncheck(); await status().filter({ hasText: "air · 播放中" }).waitFor();
    assert.equal(await enabled(dialog()).isChecked(), true); assert.equal(await flag("移动", dialog()).isChecked(), true);
    await graphButton("暂停图中预览").click(); await flag("着地", dialog()).check(); await flag("移动", dialog()).uncheck();
    await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: "idle · 已暂停" }).waitFor();
    await speed(dialog()).fill("4"); await graphButton("重置图中预览").click(); assert.equal(await speed(dialog()).inputValue(), "4");
    assert.equal(await enabled(dialog()).isChecked(), true); await graphButton("关闭").click(); assert.equal(await speed().inputValue(), "4");
    assert.deepEqual(await fs.readFile(file), original); assert.deepEqual(await fs.readFile(animFile), animBytes);

    await graph(); await node("move").click(); assert.equal(await enabled(dialog()).isChecked(), false); await enabled(dialog()).check(); assert.equal(await speed(dialog()).inputValue(), "0");
    await node("idle").click(); assert.equal(await enabled(dialog()).isChecked(), false); await enabled(dialog()).check(); await speed(dialog()).fill("5");
    await node("idle").click(); assert.equal(await enabled(dialog()).isChecked(), true); assert.equal(await speed(dialog()).inputValue(), "5");
    await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("q.is_moving && q.is_on_ground");
    await graphButton("保存转移").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已更新转移" }).waitFor();
    assert.equal(await enabled(dialog()).isChecked(), true); assert.equal(await speed(dialog()).inputValue(), "5");
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    assert.equal(await enabled(dialog()).isChecked(), false); await enabled(dialog()).check(); assert.equal(await speed(dialog()).inputValue(), "0");
    await speed(dialog()).fill("5"); await graphButton("重做控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已重做控制器编辑" }).waitFor();
    assert.equal(await enabled(dialog()).isChecked(), false);
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    await graphButton("关闭").click();
    await select("控制器", "controller.animation.other"); assert.equal(await enabled().isChecked(), false); await enabled().check(); await speed().fill("6");
    await select("控制器", id); assert.equal(await enabled().isChecked(), false); await enabled().check(); await speed().fill("7");
    await button("重新读取").click(); await page.getByLabel("当前状态名称", { exact: true }).waitFor(); assert.equal(await enabled().isChecked(), false);
    await enabled().check(); assert.equal(await speed().inputValue(), "0"); await graph();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await speed(dialog()).fill("3"); await vertical(dialog()).fill("-2"); await flag("潜行", dialog()).check(); await flag("在水中", dialog()).check();
    await queryPanel(dialog()).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("graph-simulation-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("关闭").click(); assert.equal(await speed().inputValue(), "3"); assert.equal(await vertical().inputValue(), "-2");
    assert.equal(await flag("潜行").isChecked(), true); assert.equal(await flag("在水中").isChecked(), true);
    await close(); await launch(); assert.equal(await enabled().isChecked(), false); await enabled().check(); assert.equal(await speed().inputValue(), "0");
    assert.deepEqual(JSON.parse(await fs.readFile(file)), source); assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 图内/侧栏共享模拟值、图内实时转移、暂停姿势独立像素参考、检查失效、空值/越界/禁用保留及恢复、重置区别、状态/控制器/重读/历史隔离、深浅窄窗与重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
