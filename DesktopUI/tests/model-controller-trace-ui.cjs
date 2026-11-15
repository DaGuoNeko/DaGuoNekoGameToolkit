const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-trace");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_trace", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: Object.fromEntries([["idle", 0], ["middle", 40], ["end", 70]].map(([name, rotation]) => [
    "animation." + name, { animation_length: 0.1, loop: true, bones: { body: { rotation: [0, 0, rotation] } } },
  ])) }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.trace";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "start", states: {
    start: { animations: ["animation.idle"], blend_transition: 0.2, transitions: [{ end: "0" }, { middle: "q.all_animations_finished" }] },
    middle: { animations: ["animation.middle"], blend_transition: 0.2, transitions: [{ end: "q.anim_time >= 0.1" }] }, end: { animations: ["animation.end"] },
    self: { animations: ["animation.idle"], blend_transition: 0.2, transitions: [{ self: "1" }] },
    bad: { animations: ["animation.idle"], transitions: [{ end: "query.unsupported" }] },
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const rows = () => dialog().getByRole("list", { name: "控制器转移记录" }).locator("li");
  const read = async () => JSON.parse(await fs.readFile(file));
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const showTrace = async () => { const details = dialog().locator(".model-controller-trace"); if (await details.getAttribute("open") === null) await details.locator("summary").click(); };
  const step = async text => { await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: text }).waitFor(); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_trace" }).click(); await button("动画").click(); await button("播放控制器").waitFor();
  };
  try {
    await launch(); await graph(); await step("start · 已暂停 · 状态时间 0.050 秒");
    assert.equal(await node("start").getAttribute("data-running"), "true");
    await graphButton("关闭").click(); const start = await capture("step-start", true); await graph();
    await step("middle · 已暂停 · 状态时间 0.000 秒"); await showTrace();
    assert.equal(await rows().count(), 1); assert.match(await rows().first().innerText(), /0.100 秒 · start → middle · 第 2 条/);
    assert.match(await rows().first().innerText(), /q.all_animations_finished/);
    assert.equal(await node("start").getAttribute("aria-pressed"), "true"); assert.equal(await node("middle").getAttribute("data-running"), "true");
    await step("middle · 已暂停 · 状态时间 0.050 秒"); await step("end · 已暂停 · 状态时间 0.000 秒");
    assert.equal(await rows().count(), 2); assert.match(await rows().first().innerText(), /0.200 秒 · middle → end · 第 1 条/);
    assert.equal(await dialog().locator('[data-triggered="true"]').count(), 1);
    await graphButton("定位运行状态").click(); assert.equal(await node("start").getAttribute("aria-pressed"), "true");
    const runningBox = await node("end").boundingBox(), viewportBox = await dialog().getByRole("region", { name: "状态连线画布" }).boundingBox();
    assert.ok(runningBox.x >= viewportBox.x && runningBox.x + runningBox.width <= viewportBox.x + viewportBox.width);
    assert.equal(await rows().count(), 2);
    const paused = await status().innerText(); await page.waitForTimeout(180); assert.equal(await status().innerText(), paused);
    for (const time of ["0.050", "0.100", "0.150", "0.200"]) await step("end · 已暂停 · 状态时间 " + time + " 秒");
    await graphButton("关闭").click(); const end = await capture("step-end", true);
    let changed = 0; assert.equal(start.pixels.length, end.pixels.length);
    for (let i = 0; i < start.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(start.pixels[i + k] - end.pixels[i + k]) > 12)) changed++;
    assert.ok(changed > 500); await graph(); await showTrace();
    await graphButton("播放图中预览").click(); await graphButton("暂停图中预览").waitFor();
    assert.equal(await graphButton("图中单步 0.05 秒").isDisabled(), true);
    await page.waitForTimeout(180); await graphButton("暂停图中预览").click(); await status().filter({ hasText: "已暂停" }).waitFor();
    assert.equal(await rows().count(), 2); await graphButton("适应宽度").click(); await graphButton("定位运行状态").click(); await capture("trace-dark");
    assert.deepEqual(await fs.readFile(file), original);
    await graphButton("重置图中预览").click(); await status().filter({ hasText: "从编辑所选状态开始" }).waitFor();
    assert.equal(await rows().count(), 0); assert.equal(await dialog().locator('[data-running="true"]').count(), 0);

    await node("bad").click(); await graphButton("图中单步 0.05 秒").click(); await dialog().getByRole("alert").filter({ hasText: "不支持" }).waitFor();
    assert.match(await status().innerText(), /bad · 已停止/); assert.equal(await rows().count(), 0);
    await graphButton("重置图中预览").click(); await dialog().getByRole("alert").waitFor({ state: "hidden" });
    await node("self").click(); await step("self · 已暂停 · 状态时间 0.000 秒");
    assert.equal(await rows().count(), 1); assert.match(await rows().first().innerText(), /self → self · 第 1 条/);
    await graphButton("关闭").click(); await page.getByRole("status", { name: "状态过渡进度" }).filter({ hasText: "self → self" }).waitFor(); await graph(); await showTrace();
    await graphButton("播放图中预览").click();
    await page.waitForFunction(() => document.querySelectorAll('dialog .model-controller-trace li').length === 50);
    await graphButton("暂停图中预览").click(); await status().filter({ hasText: "已暂停" }).waitFor();
    assert.equal(await rows().count(), 50); const stoppedRows = await rows().allInnerTexts(); await page.waitForTimeout(150); assert.deepEqual(await rows().allInnerTexts(), stoppedRows);
    assert.deepEqual(await fs.readFile(file), original);
    await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("0");
    await graphButton("保存转移").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已更新转移" }).waitFor();
    await status().filter({ hasText: "从编辑所选状态开始" }).waitFor(); assert.equal(await rows().count(), 0);
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    assert.deepEqual(await read(), source); assert.equal(await rows().count(), 0);
    await step("self · 已暂停 · 状态时间 0.000 秒");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await dialog().getByRole("region", { name: "关系图预览" }).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("trace-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("关闭").click(); await button("重置控制器").click();
    await button("单步 0.05 秒").click(); await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "self · animation.idle" }).waitFor();
    assert.equal(await page.locator(".model-controller-trace li").count(), 1);
    await close(); await launch(); await graph(); assert.match(await status().innerText(), /从编辑所选状态开始/); assert.equal(await rows().count(), 0);
    assert.equal(await node("start").getAttribute("aria-pressed"), "true"); assert.deepEqual(await read(), source); assert.deepEqual(await fs.readFile(animFile), animBytes);
    assert.deepEqual(errors, []);
    console.log("PASS 实际命中行/完成条件日志、图中运行状态与编辑选择隔离、单步及三维姿势、暂停/续播/重置、错误停止、自转移/50条上限、保存/撤销清空、侧栏同步及深浅窄窗/重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
