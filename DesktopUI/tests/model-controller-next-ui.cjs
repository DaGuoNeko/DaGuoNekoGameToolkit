const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-next");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_next", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: Object.fromEntries([["start", 0], ["middle", 40], ["end", 80]].map(([name, rotation]) => [
    "animation." + name, { animation_length: 0.15, loop: true, bones: { body: { rotation: [0, 0, rotation] } } },
  ])) }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.next";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "start", states: {
    start: { animations: ["animation.start"], transitions: [{ end: 0 }, { middle: "q.all_animations_finished" }] },
    middle: { animations: ["animation.middle"], blend_transition: 0.4, transitions: [{ end: 1 }] }, end: { animations: ["animation.end"] },
    reference: { animations: ["animation.middle"] }, self: { transitions: [{ self: 1 }] },
    gate: { animations: ["animation.start"], transitions: [{ middle: "q.is_moving" }] },
    blocked: { transitions: [{ end: 0 }] }, bad: { transitions: [{ end: "query.unsupported" }] },
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const notice = (scope = dialog()) => scope.getByRole("status", { name: "运行到转移状态", exact: true });
  const traces = () => dialog().locator(".model-controller-trace li");
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const stopped = async text => { await notice().filter({ hasText: text }).waitFor(); await graphButton("播放图中预览").waitFor(); };
  const showPoints = async () => { const details = dialog().locator(".model-controller-breakpoints"); if (await details.getAttribute("open") === null) await details.locator("summary").click(); };
  const showSimulation = async () => { const details = dialog().locator(".model-controller-simulation"); if (await details.getAttribute("open") === null) await details.locator("summary").click(); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_next" }).click(); await button("动画").click(); await button("播放控制器").waitFor();
  };
  try {
    await launch(); await select("控制器状态", "reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    const reference = await capture("reference-middle", true); await select("控制器状态", "start · 初始"); await graph();
    await graphButton("运行到下一次转移").click(); await stopped("start → middle 的第 2 条转移后暂停");
    assert.match(await status().innerText(), /middle · 已暂停 · 状态时间 0.000/); assert.equal(await traces().count(), 1);
    assert.equal(await node("start").getAttribute("aria-pressed"), "true");
    await page.waitForTimeout(180); assert.equal(await traces().count(), 1); assert.match(await status().innerText(), /middle · 已暂停/);
    await graphButton("检查图中条件").click(); await dialog().getByRole("region", { name: "转移条件检查" }).waitFor(); await stopped("start → middle");
    await graphButton("适应宽度").click(); await graphButton("定位运行状态").click(); await capture("run-next-dark");
    await graphButton("关闭").click(); const frame = await capture("run-next-middle", true); assert.equal(frame.pixels.length, reference.pixels.length); let changed = 0;
    for (let i = 0; i < frame.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(frame.pixels[i + k] - reference.pixels[i + k]) > 12)) changed++;
    assert.ok(changed < 150, "首次转移后的姿势须匹配独立数字参考：" + changed);
    await notice(page).filter({ hasText: "start → middle" }).waitFor();
    await button("运行到下一次转移").click(); await notice(page).filter({ hasText: "middle → end 的第 1 条转移后暂停" }).waitFor();
    await graph(); assert.equal(await traces().count(), 2); const endTime = await status().innerText();
    await graphButton("运行到下一次转移").click(); await stopped("当前状态 end 没有出站转移");
    assert.equal(await status().innerText(), endTime); assert.equal(await traces().count(), 2);
    await graphButton("重置图中预览").click(); await notice().waitFor({ state: "hidden" });

    await showPoints(); await dialog().getByRole("checkbox", { name: "进入状态时暂停 start", exact: true }).check();
    await dialog().getByRole("checkbox", { name: "进入状态时暂停 middle", exact: true }).check();
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "断点暂停位置" }).filter({ hasText: "start" }).waitFor();
    assert.equal(await notice().count(), 0); assert.equal(await traces().count(), 0);
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "断点暂停位置" }).filter({ hasText: "middle" }).waitFor();
    assert.equal(await notice().count(), 0); assert.equal(await traces().count(), 1); await graphButton("清除状态断点").click();
    await graphButton("运行到下一次转移").click(); await stopped("middle → end");

    await node("self").click(); await graphButton("运行到下一次转移").click(); await stopped("self → self 的第 1 条转移后暂停"); assert.equal(await traces().count(), 1);
    await graphButton("运行到下一次转移").click(); await stopped("self → self"); assert.equal(await traces().count(), 2);
    await page.waitForTimeout(150); assert.equal(await traces().count(), 2);
    await graphButton("播放图中预览").click(); await page.waitForFunction(() => document.querySelectorAll('dialog .model-controller-trace li').length === 50);
    await graphButton("暂停图中预览").click(); await graphButton("运行到下一次转移").click(); await stopped("self → self"); assert.equal(await traces().count(), 50);

    await node("blocked").click(); await graphButton("运行到下一次转移").click(); await notice().filter({ hasText: "正在等待下一次转移" }).waitFor();
    await page.waitForTimeout(160); assert.match(await status().innerText(), /blocked · 播放中/); assert.equal(await traces().count(), 0);
    assert.equal(await graphButton("运行到下一次转移").isDisabled(), true);
    await graphButton("关闭").click(); await notice(page).filter({ hasText: "正在等待下一次转移" }).waitFor(); await button("暂停控制器").click(); await notice(page).waitFor({ state: "hidden" });
    await graph(); await graphButton("播放图中预览").click(); await status().filter({ hasText: "blocked · 播放中" }).waitFor(); assert.equal(await notice().count(), 0);
    await graphButton("暂停图中预览").click();
    await node("gate").click(); await showSimulation(); await dialog().getByRole("checkbox", { name: "启用模拟查询", exact: true }).check();
    await graphButton("运行到下一次转移").click(); await notice().filter({ hasText: "正在等待下一次转移" }).waitFor();
    await dialog().getByRole("checkbox", { name: "模拟移动", exact: true }).check(); await stopped("gate → middle"); assert.equal(await traces().count(), 1);
    await graphButton("重置图中预览").click(); await dialog().getByRole("checkbox", { name: "模拟移动", exact: true }).uncheck();
    await graphButton("运行到下一次转移").click(); await notice().filter({ hasText: "正在等待下一次转移" }).waitFor();
    await dialog().getByLabel("模拟水平速度（米/秒）", { exact: true }).fill("");
    await status().filter({ hasText: "已停止" }).waitFor(); await notice().waitFor({ state: "hidden" });
    assert.equal(await traces().count(), 0); await dialog().getByLabel("模拟水平速度（米/秒）", { exact: true }).fill("0");
    await graphButton("运行到下一次转移").click(); await notice().filter({ hasText: "正在等待下一次转移" }).waitFor();
    await node("bad").click(); await notice().waitFor({ state: "hidden" });
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("alert").filter({ hasText: "不支持" }).waitFor(); assert.equal(await notice().count(), 0);
    assert.equal(await traces().count(), 0); await graphButton("重置图中预览").click();
    assert.deepEqual(await fs.readFile(file), original); assert.deepEqual(await fs.readFile(animFile), animBytes);

    await node("blocked").click(); await graphButton("运行到下一次转移").click(); await notice().filter({ hasText: "正在等待下一次转移" }).waitFor();
    await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("1"); await graphButton("保存转移").click();
    await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已更新转移" }).waitFor(); await notice().waitFor({ state: "hidden" });
    await graphButton("运行到下一次转移").click(); await stopped("blocked → end");
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    await notice().waitFor({ state: "hidden" }); assert.deepEqual(JSON.parse(await fs.readFile(file)), source);
    await node("start").click(); await graphButton("运行到下一次转移").click(); await stopped("start → middle");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await notice().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("run-next-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("关闭").click(); await close(); await launch(); assert.equal(await notice(page).count(), 0);
    assert.deepEqual(JSON.parse(await fs.readFile(file)), source); assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 首次实际转移/完成条件/瞬时目标/自转移自动暂停、侧栏图同步与姿势参考、无出站/条件等待/手动取消、断点优先、模拟值与错误、满额记录、编辑撤销清空及主题/重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
