const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-breakpoints");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_breakpoints", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: Object.fromEntries([["start", 0], ["middle", 40], ["end", 80]].map(([name, rotation]) => [
    "animation." + name, { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, rotation] } } },
  ])) }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.breakpoints";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "start", states: {
    start: { animations: ["animation.start"], transitions: [{ middle: "q.anim_time >= 0.15" }] },
    middle: { animations: ["animation.middle"], blend_transition: 0.4, transitions: [{ end: "q.anim_time >= 0.2" }] }, end: { animations: ["animation.end"] },
    reference: { animations: ["animation.middle"] }, self: { animations: ["animation.start"], blend_transition: 0.2, transitions: [{ self: "1" }] },
    live: { animations: ["animation.start"], transitions: [{ end: "q.is_moving" }] }, bad: { transitions: [{ end: "query.unsupported" }] },
  } }, "controller.animation.other": { initial_state: "start", states: { start: {}, end: {} } } } };
  await fs.writeFile(file, JSON.stringify(source, null, 2)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const point = (name, scope = dialog()) => scope.getByRole("checkbox", { name: "进入状态时暂停 " + name, exact: true });
  const hit = () => dialog().getByRole("status", { name: "断点暂停位置", exact: true });
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const traces = () => dialog().locator(".model-controller-trace li");
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const showPoints = async (scope = dialog()) => { const details = scope.locator(".model-controller-breakpoints"); if (await details.getAttribute("open") === null) await details.locator("summary").click(); };
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); await showPoints(); };
  const stopped = async name => { await hit().filter({ hasText: "已在 " + name + " 的进入断点暂停" }).waitFor(); await status().filter({ hasText: name + " · 已暂停 · 状态时间 0.000 秒" }).waitFor(); };
  const saved = async message => { await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: message }).waitFor(); await graphButton("关闭").and(page.locator(":enabled")).waitFor(); };
  const capture = async (name, crop = false) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = crop ? await page.locator(".model-view-cell:not([hidden]) canvas").boundingBox() : null;
    const png = await app.evaluate(async ({ BrowserWindow }, box) => {
      const rect = box && Object.fromEntries(Object.entries(box).map(([key, n]) => [key, Math.floor(n)]));
      return (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect || undefined)).toPNG().toString("base64");
    }, box);
    const bytes = Buffer.from(png, "base64"); await fs.writeFile(artifactPath("outputs/" + name + ".png"), bytes); return decodePng(bytes);
  };
  const close = async () => { if (!app) return; const current = app; app = null; const timer = setTimeout(() => current.process().kill(), 5000); try { await current.close(); } finally { clearTimeout(timer); } };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_breakpoints" }).click(); await button("动画").click(); await button("播放控制器").waitFor();
  };
  try {
    await launch(); await select("控制器状态", "reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    const reference = await capture("reference-middle", true); await select("控制器状态", "start · 初始");
    await graph(); await point("middle").check(); await point("end").check(); assert.equal(await node("start").getAttribute("aria-pressed"), "true");
    await graphButton("播放图中预览").click(); await stopped("middle");
    assert.equal(await traces().count(), 1); const frozen = await status().innerText(); await page.waitForTimeout(180); assert.equal(await status().innerText(), frozen);
    await graphButton("适应宽度").click(); await graphButton("定位运行状态").click(); await capture("breakpoint-dark");
    await graphButton("关闭").click(); await showPoints(page); assert.equal(await point("middle", page).isChecked(), true);
    await page.getByRole("status", { name: "断点暂停位置", exact: true }).filter({ hasText: "middle" }).waitFor();
    const frame = await capture("paused-middle", true); assert.equal(frame.pixels.length, reference.pixels.length); let changed = 0;
    for (let i = 0; i < frame.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(frame.pixels[i + k] - reference.pixels[i + k]) > 12)) changed++;
    assert.ok(changed < 150, "断点处姿势必须匹配独立数字参考：" + changed);
    await graph(); await stopped("middle"); await graphButton("播放图中预览").click(); await stopped("end"); assert.equal(await traces().count(), 2);
    await graphButton("检查图中条件").click(); await dialog().getByRole("region", { name: "转移条件检查" }).waitFor(); await stopped("end");
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "end · 播放中" }).waitFor(); await page.waitForTimeout(160);
    assert.equal(await hit().count(), 0); await graphButton("暂停图中预览").click(); assert.equal(await traces().count(), 2);
    await graphButton("重置图中预览").click(); assert.equal(await point("middle").isChecked(), true);
    await point("start").check(); await graphButton("检查图中条件").click(); assert.equal(await hit().count(), 0);
    await graphButton("图中单步 0.05 秒").click(); await stopped("start"); assert.equal(await traces().count(), 0);
    await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: "start · 已暂停 · 状态时间 0.050" }).waitFor(); assert.equal(await hit().count(), 0);
    await graphButton("播放图中预览").click(); await stopped("middle");
    await graphButton("重置图中预览").click(); await graphButton("清除状态断点").click();

    await node("self").click(); await point("self").check(); await graphButton("播放图中预览").click(); await stopped("self"); assert.equal(await traces().count(), 0);
    await graphButton("图中单步 0.05 秒").click(); await stopped("self"); assert.equal(await traces().count(), 1);
    await graphButton("播放图中预览").click(); await stopped("self"); assert.equal(await traces().count(), 2);
    await page.waitForTimeout(150); assert.equal(await traces().count(), 2);
    await point("self").uncheck(); await page.waitForTimeout(150); assert.equal(await traces().count(), 2);
    await graphButton("播放图中预览").click(); await page.waitForFunction(() => document.querySelectorAll('dialog .model-controller-trace li').length === 50);
    await graphButton("暂停图中预览").click(); await point("self").check(); await graphButton("播放图中预览").click(); await stopped("self"); assert.equal(await traces().count(), 50);
    await graphButton("清除状态断点").click(); await node("live").click();
    await dialog().locator(".model-controller-simulation > summary").click(); await dialog().getByRole("checkbox", { name: "启用模拟查询", exact: true }).check();
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "live · 播放中" }).waitFor();
    await point("live").check(); await page.waitForTimeout(150); assert.match(await status().innerText(), /live · 播放中/);
    await point("end").check(); await dialog().getByRole("checkbox", { name: "模拟移动", exact: true }).check(); await stopped("end");
    await graphButton("清除状态断点").click(); await page.waitForTimeout(150); await status().filter({ hasText: "end · 已暂停" }).waitFor();
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "end · 播放中" }).waitFor(); await graphButton("暂停图中预览").click();
    await node("bad").click(); await point("end").check(); await graphButton("播放图中预览").click(); await dialog().getByRole("alert").filter({ hasText: "不支持" }).waitFor();
    assert.equal(await hit().count(), 0); assert.equal(await traces().count(), 0);
    await graphButton("重置图中预览").click(); await graphButton("清除状态断点").click();
    assert.deepEqual(await fs.readFile(file), original); assert.deepEqual(await fs.readFile(animFile), animBytes);

    await node("self").click(); await point("self").check(); await graphButton("重命名状态").click(); await dialog().getByLabel("图中状态名称", { exact: true }).fill("self_new");
    await fs.mkdir(file + ".bak"); await graphButton("保存状态").click(); await dialog().getByRole("alert").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.equal(await point("self").isChecked(), true); assert.deepEqual(await fs.readFile(file), original);
    await fs.rmdir(file + ".bak"); await graphButton("保存状态").click(); await saved("已重命名状态并更新转移引用");
    assert.equal(await point("self_new").isChecked(), true); assert.equal(await point("self").count(), 0);
    await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("q.anim_time > 0.05");
    await graphButton("保存转移").click(); await saved("已更新转移"); assert.equal(await point("self_new").isChecked(), true);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.equal(await point("self_new").isChecked(), false);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.equal(await point("self").isChecked(), false);
    await point("self").check(); await point("end").check(); await graphButton("删除状态").click(); await graphButton("确认删除状态").click(); await saved("已删除状态");
    assert.equal(await point("self").count(), 0); assert.equal(await point("end").isChecked(), true);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.equal(await point("self").isChecked(), false); assert.equal(await point("end").isChecked(), false);
    await point("end").check(); await graphButton("关闭").click();
    const output = artifactPath("outputs/breakpoints.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor(); assert.deepEqual(importProject(JSON.parse(await fs.readFile(output))).controllers, source.animation_controllers);
    await select("控制器", "controller.animation.other"); await showPoints(page); assert.equal(await point("end", page).isChecked(), false); await point("end", page).check();
    await select("控制器", id); await showPoints(page); assert.equal(await point("end", page).isChecked(), false); await point("end", page).check();
    await button("重新读取").click(); await page.getByLabel("当前状态名称", { exact: true }).waitFor(); await showPoints(page); assert.equal(await point("end", page).isChecked(), false);
    await graph(); await point("middle").check(); await point("end").check(); await graphButton("播放图中预览").click(); await stopped("middle");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await dialog().getByRole("region", { name: "关系图预览" }).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("breakpoint-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("关闭").click(); await close(); await launch(); await showPoints(page); assert.equal(await point("middle", page).isChecked(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(file)), source); assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 状态进入/起始/单步/自转移断点、暂停姿势参考、继续与实时增删、记录满额/错误隔离、共享列表/改名删除/失败保护、历史/重读/控制器隔离、工程不含断点及深浅窄窗/重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
