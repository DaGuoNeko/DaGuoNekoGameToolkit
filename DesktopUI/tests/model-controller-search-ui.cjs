const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-search");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_search", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: Object.fromEntries([["idle", 0], ["walk", 40], ["jump", 80]].map(([name, rotation]) => [
    "animation." + name, { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, rotation] } } },
  ])) }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.search";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "start", states: {
    start: { animations: ["animation.idle"], transitions: [{ walk: "q.anim_time >= 0.1" }, { jump: 0 }] },
    walk: { animations: ["animation.walk"] }, jump: { animations: ["animation.jump"] }, holder: { animations: [{ "animation.walk": 0.5 }] },
    ...Object.fromEntries(Array.from({ length: 28 }, (_, i) => ["extra_" + i, {}])),
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const input = () => dialog().getByRole("searchbox", { name: "搜索关系图", exact: true });
  const count = () => dialog().getByRole("status", { name: "关系图搜索结果数量" });
  const results = () => dialog().getByRole("list", { name: "关系图搜索结果" });
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const graph = async () => { await button("状态关系图").click(); await input().waitFor(); };
  const find = async (query, total) => { await input().fill(query); await count().filter({ hasText: "匹配 " + total + "/32" }).waitFor(); };
  const saved = async text => { await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: text }).waitFor(); await graphButton("关闭").and(page.locator(":enabled")).waitFor(); };
  const center = async locator => { const r = await locator.boundingBox(); assert.ok(r); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  try {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_search" }).click(); await button("动画").click(); await graph();
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "运行到转移状态" }).filter({ hasText: "start → walk" }).waitFor();
    const paused = await status().innerText(), positions = await dialog().locator(".model-controller-graph-node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style")));
    await find(" WALK ", 3); assert.equal(await input().inputValue(), " WALK ");
    assert.match(await graphButton("定位匹配状态 start").innerText(), /转移目标/); assert.match(await graphButton("定位匹配状态 walk").innerText(), /名称、动画引用/);
    assert.match(await graphButton("定位匹配状态 holder").innerText(), /动画引用/);
    assert.equal(await node("holder").getAttribute("data-search-match"), "true"); assert.equal(await node("jump").getAttribute("data-search-match"), "false");
    assert.equal(await node("jump").evaluate(e => getComputedStyle(e).opacity), "0.55");
    await find("animation.walk", 2); assert.equal(await node("start").evaluate(e => getComputedStyle(e).opacity), "1");
    await find("q.anim_time >=", 1); assert.match(await graphButton("定位匹配状态 start").innerText(), /转移条件/);
    await find("extra_27", 1); await graphButton("定位匹配状态 extra_27").click();
    assert.ok(await dialog().getByRole("region", { name: "状态连线画布" }).evaluate(e => e.scrollTop) > 0);
    assert.equal(await node("start").getAttribute("aria-pressed"), "true"); assert.equal(await node("walk").getAttribute("data-running"), "true"); assert.equal(await status().innerText(), paused);
    await find("walk", 3); await input().press("Enter"); assert.equal(await node("start").evaluate(e => e === document.activeElement), true);
    await input().focus(); await input().dispatchEvent("keydown", { key: "Enter", isComposing: true }); assert.equal(await input().evaluate(e => e === document.activeElement), true);
    await input().press("Escape"); assert.equal(await input().inputValue(), ""); assert.equal(await count().count(), 0); await dialog().waitFor();
    assert.equal(await dialog().locator("[data-search-match]").count(), 0);
    await find("^missing$", 0); assert.equal(await results().count(), 0); assert.equal(await dialog().locator(".model-controller-graph-node").count(), 32);
    assert.deepEqual(await dialog().locator(".model-controller-graph-node").evaluateAll(nodes => nodes.map(n => n.getAttribute("style"))), positions);
    await find("extra_", 28); assert.equal(await results().locator("li").count(), 28); await capture("graph-search-dark");
    await graphButton("播放图中预览").click(); await status().filter({ hasText: "walk · 播放中" }).waitFor();
    await find("extra_27", 1); await graphButton("定位匹配状态 extra_27").click(); await page.waitForTimeout(160);
    assert.match(await status().innerText(), /walk · 播放中/); assert.equal(await node("start").getAttribute("aria-pressed"), "true"); assert.equal(await dialog().locator(".model-controller-trace li").count(), 1);
    await graphButton("暂停图中预览").click(); assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" });
    await node("extra_27").press("Space"); assert.equal(await node("extra_27").getAttribute("aria-pressed"), "true");
    await graphButton("重命名状态").click(); assert.equal(await input().isDisabled(), true); assert.equal(await graphButton("定位匹配状态 extra_27").isDisabled(), true);
    await dialog().getByLabel("图中状态名称", { exact: true }).fill("renamed"); await graphButton("保存状态").click(); await saved("已重命名状态并更新转移引用");
    await count().filter({ hasText: "匹配 0/32" }).waitFor(); await find("renamed", 1);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); await count().filter({ hasText: "匹配 0/32" }).waitFor();
    await node("start").click(); await find("q.is_moving", 0); await graphButton("编辑转移 1").click();
    await dialog().getByLabel("转移 1条件", { exact: true }).fill("q.is_moving"); await graphButton("保存转移").click(); await saved("已更新转移");
    await count().filter({ hasText: "匹配 1/32" }).waitFor(); assert.match(await graphButton("定位匹配状态 start").innerText(), /转移条件/);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); await count().filter({ hasText: "匹配 0/32" }).waitFor();
    await find("walk", 3); await graphButton("适应宽度").click(); await node("start").scrollIntoViewIfNeeded();
    const a = await center(node("start").locator(".model-controller-graph-node-head")), b = await center(node("walk"));
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await dialog().locator(".model-controller-arrange-ghost").waitFor();
    assert.equal(await input().isDisabled(), true); assert.equal(await graphButton("定位匹配状态 walk").isDisabled(), true); await page.keyboard.press("Escape"); await page.mouse.up();
    assert.equal(await input().isEnabled(), true);
    await graphButton("从 holder 连接转移").scrollIntoViewIfNeeded(); const p = await center(graphButton("从 holder 连接转移")), t = await center(node("jump"));
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(t.x, t.y, { steps: 8 }); await dialog().locator(".model-controller-connect-line").waitFor();
    assert.equal(await input().isDisabled(), true); await page.mouse.up(); await dialog().getByRole("region", { name: "新增转移草稿" }).waitFor();
    assert.equal(await dialog().getByRole("combobox", { name: "新转移目标" }).innerText(), "jump"); await graphButton("取消添加转移").click();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await find("animation.walk", 2); await input().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("graph-search-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("清除搜索").click(); assert.equal(await dialog().locator("[data-search-match]").count(), 0);
    await find("walk", 3); await graphButton("关闭").click(); await graph(); assert.equal(await input().inputValue(), "");
    assert.deepEqual(JSON.parse(await fs.readFile(file)), source); assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 状态/动画/目标/条件搜索、大小写/字面匹配/空结果、定位与播放选择隔离、键盘/输入法、改名/编辑/撤销刷新、手势锁定及未匹配目标可连接、深浅窄窗/重开和源文件保护");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { if (app) { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } } }
})().catch(error => { console.error(error); process.exitCode = 1; });
