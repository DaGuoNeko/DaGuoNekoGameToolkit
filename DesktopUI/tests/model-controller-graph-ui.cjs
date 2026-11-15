const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-graph");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_graph", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: { "animation.idle": { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, 20] } } } } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.graph";
  const source = { keep: true, animation_controllers: { [id]: { states: {
    default: { animations: ["animation.idle"], transitions: [{ walk: "q.anim_time > 100" }, { jump: "0" }, { default: "0" }, { walk: "0" }], unknown: { keep: true } },
    walk: { transitions: [{ jump: "0" }] }, jump: { transitions: [{ default: "0" }] },
    isolated_state_with_a_long_name: {}, last: {},
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const node = name => button("状态节点 " + name);
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const graphRow = index => dialog().getByRole("region", { name: "转移 " + index, exact: true });
  const graphSaved = async message => {
    await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: message }).waitFor();
    await graphButton("关闭").and(page.locator(":enabled")).waitFor();
  };
  const read = async () => JSON.parse(await fs.readFile(file));
  const selected = async name => assert.equal(await node(name).getAttribute("aria-pressed"), "true");
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  const close = async () => { if (!app) return; const current = app; app = null; const timer = setTimeout(() => current.process().kill(), 5000); try { await current.close(); } finally { clearTimeout(timer); } };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_graph" }).click(); await button("动画").click(); await page.getByLabel("当前状态名称", { exact: true }).waitFor();
  };
  try {
    await launch(); await button("播放控制器").click();
    await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "default · animation.idle" }).waitFor();
    await graph(); await selected("default");
    assert.equal(await page.locator(".model-controller-graph-node").count(), 5);
    assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 4);
    assert.match(await node("default").innerText(), /初始/);
    assert.equal(await page.getByRole("region", { name: "所选状态的出站转移" }).locator("li").count(), 4);
    assert.equal(await page.getByRole("region", { name: "所选状态的入站转移" }).locator("li").count(), 2);
    await button("适应宽度").click(); await capture("graph-dark");
    await button("转移 1目标 walk").click(); await selected("walk");
    assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 1);
    assert.equal(await page.getByRole("region", { name: "所选状态的入站转移" }).locator("li").count(), 2);
    await button("来自 default 的转移 4").click(); await selected("default");
    await node("default").press("ArrowRight"); await selected("walk");
    await button("放大关系图").click(); await button("缩小关系图").click();
    await select("定位状态", "isolated_state_with_a_long_name"); await selected("isolated_state_with_a_long_name");
    assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 0);
    assert.match(await dialog().innerText(), /没有出站转移/); assert.match(await dialog().innerText(), /没有入站转移/);
    await select("定位状态", "walk"); await button("编辑所选状态").click();
    await dialog().waitFor({ state: "hidden" }); assert.equal(await page.getByLabel("当前状态名称", { exact: true }).inputValue(), "walk");
    assert.equal(await page.getByRole("status", { name: "控制器播放状态" }).innerText(), "从所选状态开始");
    assert.deepEqual(await fs.readFile(file), original); assert.equal(await button("撤销控制器").isDisabled(), true);
    await page.getByLabel("当前状态名称", { exact: true }).fill("run"); await button("重命名状态").click(); await page.getByText("已重命名状态并更新转移引用", { exact: true }).waitFor();
    const renamed = await read(); await graph(); await selected("run");
    await node("default").click(); assert.equal(await button("转移 1目标 run").count(), 1); assert.equal(await button("转移 4目标 run").count(), 1);
    await node("default").press("Control+z"); assert.deepEqual(await read(), renamed);
    await page.keyboard.press("Escape"); await dialog().waitFor({ state: "hidden" });
    await button("撤销控制器").click(); await page.getByText("已撤销控制器编辑", { exact: true }).waitFor();
    await graph(); await selected("walk"); assert.equal(await node("run").count(), 0);
    assert.deepEqual(await read(), source);
    await node("default").dblclick(); await dialog().waitFor({ state: "hidden" });
    assert.equal(await page.getByLabel("当前状态名称", { exact: true }).inputValue(), "default");
    await button("上移转移 2").click(); await page.getByText("已调整转移优先级", { exact: true }).waitFor();
    await graph(); assert.equal(await button("转移 1目标 jump").count(), 1); assert.equal(await button("转移 2目标 walk").count(), 1);
    await button("关闭").click();
    await button("删除转移 3").click(); await page.getByText("已删除转移", { exact: true }).waitFor();
    await graph(); assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 3); await button("关闭").click();

    await graph(); await node("last").click();
    const beforeAdd = await fs.readFile(file);
    await graphButton("新增转移").click(); assert.equal(await node("last").isDisabled(), true);
    await node("walk").click(); await selected("last");
    assert.equal(await node("walk").getAttribute("data-target"), "true");
    assert.equal(await node("walk").getAttribute("aria-pressed"), "true");
    assert.equal(await dialog().getByRole("combobox", { name: "新转移目标", exact: true }).innerText(), "walk");
    assert.equal(await graphButton("关闭弹窗").isDisabled(), true);
    await dialog().getByLabel("新转移条件", { exact: true }).press("Escape");
    assert.equal(await dialog().getByRole("region", { name: "新增转移草稿" }).count(), 0);
    assert.deepEqual(await fs.readFile(file), beforeAdd);
    await graphButton("新增转移").click(); await select("新转移目标", "walk");
    await dialog().getByLabel("新转移条件", { exact: true }).fill("q.anim_time > 0.15");
    await graphButton("保存新转移").click(); await graphSaved("已添加转移");
    assert.deepEqual((await read()).animation_controllers[id].states.last.transitions, [{ walk: "q.anim_time > 0.15" }]);
    assert.deepEqual(await fs.readFile(file + ".bak"), beforeAdd);
    assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 1);
    await graphButton("撤销控制器").click(); await graphSaved("已撤销控制器编辑");
    assert.equal((await read()).animation_controllers[id].states.last.transitions, undefined);
    assert.equal(await page.locator(".model-controller-graph-board .connection").count(), 0);
    await graphButton("重做控制器").click(); await graphSaved("已重做控制器编辑");
    await graphButton("关闭").click(); await button("播放控制器").click();
    await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "walk · 静止姿势" }).waitFor(); await button("暂停控制器").click();

    await graph(); await graphButton("新增转移").click(); assert.equal(await node("walk").isDisabled(), true);
    await node("jump").click(); await dialog().getByLabel("新转移条件", { exact: true }).fill("1");
    await capture("graph-add-draft-dark");
    const beforeFailure = await fs.readFile(file);
    await fs.rename(file + ".bak", artifactPath("outputs/previous-backup.json")); await fs.mkdir(file + ".bak");
    await graphButton("保存新转移").click(); await dialog().getByRole("alert").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.deepEqual(await fs.readFile(file), beforeFailure);
    assert.equal(await dialog().getByLabel("新转移条件", { exact: true }).inputValue(), "1");
    assert.equal(await graphButton("撤销控制器").isDisabled(), true); assert.equal(await node("default").isEnabled(), true);
    await fs.rmdir(file + ".bak"); await graphButton("保存新转移").click(); await graphSaved("已添加转移");
    assert.deepEqual(await fs.readFile(file + ".bak"), beforeFailure);
    await graphButton("上移转移 2").click(); await graphSaved("已调整转移优先级");
    assert.deepEqual((await read()).animation_controllers[id].states.last.transitions, [{ jump: "1" }, { walk: "q.anim_time > 0.15" }]);
    await graphButton("编辑转移 2").click(); await select("转移 2目标", "jump");
    assert.equal(await node("default").isDisabled(), true); assert.equal(await graphButton("关闭").isDisabled(), true);
    await graphRow(2).getByRole("button", { name: "保存转移", exact: true }).click();
    await dialog().getByRole("alert").filter({ hasText: "已经有" }).waitFor();
    assert.equal(await dialog().getByRole("combobox", { name: "转移 2目标", exact: true }).innerText(), "jump");
    await select("转移 2目标", "default"); await dialog().getByLabel("转移 2条件", { exact: true }).fill("0");
    await graphRow(2).getByRole("button", { name: "保存转移", exact: true }).click(); await graphSaved("已更新转移");
    assert.deepEqual((await read()).animation_controllers[id].states.last.transitions, [{ jump: "1" }, { default: "0" }]);
    await graphButton("编辑转移 2").click(); await dialog().getByLabel("转移 2条件", { exact: true }).fill("1");
    await dialog().getByLabel("转移 2条件", { exact: true }).press("Escape");
    assert.equal((await read()).animation_controllers[id].states.last.transitions[1].default, "0");
    await graphRow(2).scrollIntoViewIfNeeded(); await capture("graph-edit-dark");
    await graphButton("删除转移 2").click(); await graphSaved("已删除转移");
    assert.equal((await read()).animation_controllers[id].states.last.transitions.length, 1);
    await graphButton("撤销控制器").click(); await graphSaved("已撤销控制器编辑");
    assert.equal((await read()).animation_controllers[id].states.last.transitions.length, 2);
    await graphButton("重做控制器").click(); await graphSaved("已重做控制器编辑");
    await graphButton("关闭").click(); await button("播放控制器").click();
    await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "jump · 静止姿势" }).waitFor(); await button("暂停控制器").click();
    await graph(); await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("0");
    const external = await read(); external.external = "keep"; await fs.writeFile(file, JSON.stringify(external));
    await graphRow(1).getByRole("button", { name: "保存转移", exact: true }).click(); await dialog().getByRole("alert").filter({ hasText: "已变化" }).waitFor();
    assert.deepEqual(await read(), external); assert.equal(await dialog().getByLabel("转移 1条件", { exact: true }).inputValue(), "0");
    await graphButton("取消转移编辑").click(); await graphButton("关闭").click();
    await button("重新读取").click(); await page.getByRole("combobox", { name: "控制器状态", exact: true }).filter({ hasText: "default" }).waitFor();
    assert.equal(await button("撤销控制器").isDisabled(), true);
    assert.equal((await read()).animation_controllers[id].states.default.unknown.keep, true);

    const names = Array.from({ length: 32 }, (_, i) => "state_" + i);
    const large = { keep: true, animation_controllers: { [id]: { initial_state: names[0], states: Object.fromEntries(names.map((name, i) => [name, {
      transitions: Array.from({ length: 8 }, (_, j) => ({ [names[(i + j * 5) % 32]]: "q.anim_time > " + j })),
    }])) } } };
    await fs.writeFile(file, JSON.stringify(large)); await button("重新读取").click(); await page.getByRole("combobox", { name: "控制器状态", exact: true }).filter({ hasText: "state_0" }).waitFor();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await graph(); assert.equal(await page.locator(".model-controller-graph-node").count(), 32);
    assert.equal(await graphButton("新增转移").isDisabled(), true);
    await select("定位状态", "state_31"); await selected("state_31");
    assert.ok(await page.locator(".model-controller-graph-scroll").evaluate(element => element.scrollTop) > 0);
    await button("适应宽度").click(); await button("定位所选").click(); await page.waitForTimeout(300); await capture("graph-max-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await node("state_31").boundingBox(), scroll = await page.locator(".model-controller-graph-scroll").boundingBox();
    assert.ok(bounds.x >= scroll.x && bounds.x + bounds.width <= scroll.x + scroll.width);
    assert.ok(bounds.y >= scroll.y && bounds.y + bounds.height <= scroll.y + scroll.height);
    await graphButton("编辑转移 1").click(); await graphRow(1).scrollIntoViewIfNeeded(); await capture("graph-edit-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("取消转移编辑").click();
    await button("关闭").click(); assert.deepEqual(await read(), large);
    await close(); await launch(); await graph(); await selected("state_0"); assert.equal(await page.locator(".model-controller-graph-node").count(), 32);
    await button("关闭").click(); assert.deepEqual(await read(), large); assert.deepEqual(await fs.readFile(animFile), animBytes);
    assert.deepEqual(errors, []);
    console.log("PASS 关系图导航及新增/修改/排序/删除转移、图内撤销重做、草稿取消/状态锁定、备份失败重试与外部冲突、侧栏/实际播放同步、32状态/256转移、深浅窄窗及重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
