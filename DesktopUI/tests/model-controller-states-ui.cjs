const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-states");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_states", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: { "animation.idle": { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, 20] } } } } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.states";
  const source = { keep: true, animation_controllers: { [id]: { states: {
    default: { animations: [{ "animation.idle": 0.5 }], transitions: [{ default: 0 }, { walk: "1" }, { default: "0" }], blend_transition: { "0": 1, "0.5": 0.8, "1": 0 }, blend_via_shortest_path: true, unknown: { names: ["default"] } },
    walk: { transitions: [{ default: "0" }] }, isolated: {},
  } }, "controller.animation.unrelated": { states: { default: { keep: true } } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const input = () => dialog().getByLabel("图中状态名称", { exact: true });
  const stateCombo = () => page.getByRole("combobox", { name: "控制器状态", exact: true });
  const read = async () => JSON.parse(await fs.readFile(file));
  const select = async (name, value) => { await dialog().getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const saved = async message => {
    await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: message }).waitFor();
    await graphButton("关闭").and(page.locator(":enabled")).waitFor();
  };
  const saveName = async (action, name, notice) => { await graphButton(action).click(); await input().fill(name); await graphButton("保存状态").click(); await saved(notice); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_states" }).click(); await button("动画").click(); await page.getByLabel("当前状态名称", { exact: true }).waitFor();
  };
  try {
    await launch(); await graph(); assert.match(await node("default").innerText(), /初始/);
    await graphButton("新增状态").click(); await input().fill("cancelled"); await input().press("Escape");
    assert.equal(await dialog().getByRole("region", { name: "状态编辑草稿" }).count(), 0); assert.deepEqual(await fs.readFile(file), original);
    await graphButton("新增状态").click(); await input().fill("bad name"); await graphButton("保存状态").click();
    await dialog().getByRole("alert").filter({ hasText: "状态名称无效" }).waitFor(); assert.equal(await input().inputValue(), "bad name");
    assert.equal(await node("walk").isDisabled(), true); assert.equal(await graphButton("关闭").isDisabled(), true);
    await input().fill("walk"); await graphButton("保存状态").click(); await dialog().getByRole("alert").filter({ hasText: "同名" }).waitFor();
    assert.deepEqual(await fs.readFile(file), original);
    await input().fill("empty"); await graphButton("保存状态").click(); await saved("已添加状态");
    assert.deepEqual((await read()).animation_controllers[id].states.empty, { animations: [] });
    assert.equal(await node("empty").getAttribute("aria-pressed"), "true"); assert.deepEqual(await fs.readFile(file + ".bak"), original);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.deepEqual(await read(), source);
    await graphButton("重做控制器").click(); await saved("已重做控制器编辑"); assert.equal(await node("empty").getAttribute("aria-pressed"), "true");
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑");

    await graphButton("复制状态").click(); await input().fill("default_copy");
    await fs.rename(file + ".bak", artifactPath("outputs/previous-backup.json")); await fs.mkdir(file + ".bak"); const beforeCopy = await fs.readFile(file);
    await graphButton("保存状态").click(); await dialog().getByRole("alert").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.deepEqual(await fs.readFile(file), beforeCopy); assert.equal(await input().inputValue(), "default_copy");
    assert.equal(await node("default").getAttribute("aria-pressed"), "true");
    await fs.rmdir(file + ".bak"); await graphButton("保存状态").click(); await saved("已复制状态");
    const copied = await read(), expectedCopy = { ...source.animation_controllers[id].states.default, transitions: [{ default_copy: 0 }, { walk: "1" }, { default_copy: "0" }] };
    assert.deepEqual(copied.animation_controllers[id].states.default_copy, expectedCopy);
    assert.deepEqual(copied.animation_controllers[id].states.default, source.animation_controllers[id].states.default);
    assert.deepEqual(copied.animation_controllers[id].states.walk, source.animation_controllers[id].states.walk);
    assert.equal(copied.animation_controllers[id].initial_state, "default"); assert.deepEqual(await fs.readFile(file + ".bak"), beforeCopy);
    await saveName("重命名状态", "rest", "已重命名状态并更新转移引用");
    assert.equal(await node("default_copy").count(), 0); assert.equal(await node("rest").getAttribute("aria-pressed"), "true");
    assert.deepEqual((await read()).animation_controllers[id].states.rest.transitions, [{ rest: 0 }, { walk: "1" }, { rest: "0" }]);
    await graphButton("设为初始").click(); await saved("已设为初始状态"); assert.match(await node("rest").innerText(), /初始/);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.match(await node("default").innerText(), /初始/);
    await graphButton("重做控制器").click(); await saved("已重做控制器编辑"); assert.equal((await read()).animation_controllers[id].initial_state, "rest");
    await node("walk").click(); await graphButton("新增转移").click(); await node("rest").click();
    await dialog().getByLabel("新转移条件", { exact: true }).fill("1"); await graphButton("保存新转移").click(); await saved("已添加转移");
    await node("rest").click(); await graphButton("删除状态").click();
    assert.match(await dialog().getByRole("region", { name: "状态编辑草稿" }).innerText(), /指向它的 1 条转移/);
    await capture("state-delete-dark"); await graphButton("取消状态编辑").click();
    const beforeDelete = await read(); await graphButton("删除状态").click(); await graphButton("确认删除状态").click(); await saved("已删除状态");
    const deleted = await read(); assert.equal(deleted.animation_controllers[id].initial_state, "default"); assert.equal(deleted.animation_controllers[id].states.rest, undefined);
    assert.deepEqual(deleted.animation_controllers[id].states.walk.transitions, [{ default: "0" }]);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.deepEqual(await read(), beforeDelete);
    await graphButton("重做控制器").click(); await saved("已重做控制器编辑"); assert.deepEqual(await read(), deleted);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); await graphButton("关闭").click();
    assert.match(await stateCombo().innerText(), /rest · 初始/); assert.equal(await page.getByLabel("动画权重 animation.idle", { exact: true }).inputValue(), "0.5");
    await page.getByLabel("新状态名称", { exact: true }).fill("sidebar_copy"); await button("复制状态").click(); await page.getByText("已复制状态", { exact: true }).waitFor();
    assert.match(await stateCombo().innerText(), /sidebar_copy/); assert.equal((await read()).animation_controllers[id].initial_state, "rest");
    await button("撤销控制器").click(); await page.getByText("已撤销控制器编辑", { exact: true }).waitFor(); assert.deepEqual(await read(), beforeDelete);

    await graph(); await graphButton("重命名状态").click(); await input().fill("renamed");
    const external = await read(); external.external = "keep"; await fs.writeFile(file, JSON.stringify(external));
    await graphButton("保存状态").click(); await dialog().getByRole("alert").filter({ hasText: "已变化" }).waitFor();
    assert.deepEqual(await read(), external); assert.equal(await input().inputValue(), "renamed");
    await graphButton("取消状态编辑").click(); await graphButton("关闭").click(); await button("重新读取").click();
    await stateCombo().filter({ hasText: "rest · 初始" }).waitFor(); await graph(); await saveName("重命名状态", "renamed", "已重命名状态并更新转移引用");
    const final = await read(); assert.equal(final.external, "keep"); assert.equal(final.keep, true);
    assert.deepEqual(final.animation_controllers["controller.animation.unrelated"], source.animation_controllers["controller.animation.unrelated"]);
    await graphButton("关闭").click();
    const output = artifactPath("outputs/controller-states.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    assert.deepEqual(importProject(JSON.parse(await fs.readFile(output))).controllers, final.animation_controllers);
    await close(); await launch(); await graph(); assert.match(await node("renamed").innerText(), /初始/); await graphButton("关闭").click();

    const alone = { animation_controllers: { [id]: { states: { alone: { unknown: true } } } } };
    await fs.writeFile(file, JSON.stringify(alone)); await button("重新读取").click(); await stateCombo().filter({ hasText: "alone" }).waitFor(); await graph();
    assert.equal(await graphButton("删除状态").isDisabled(), true); assert.equal(await graphButton("设为初始").isDisabled(), true);
    await saveName("新增状态", "default", "已添加状态"); assert.match(await node("alone").innerText(), /初始/);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); await saveName("复制状态", "0", "已复制状态");
    assert.match(await node("alone").innerText(), /初始/); assert.deepEqual((await read()).animation_controllers[id].states["0"], { unknown: true });
    await graphButton("关闭").click();
    const large = { animation_controllers: { [id]: { states: Object.fromEntries(Array.from({ length: 32 }, (_, i) => ["state_" + i, {}])) } } };
    await fs.writeFile(file, JSON.stringify(large)); await button("重新读取").click(); await stateCombo().filter({ hasText: "state_0" }).waitFor(); await graph();
    assert.equal(await graphButton("新增状态").isDisabled(), true); assert.equal(await graphButton("复制状态").isDisabled(), true);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await graphButton("重命名状态").click(); await input().fill("state_renamed"); await input().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("state-name-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("取消状态编辑").click(); await graphButton("关闭").click(); assert.deepEqual(await read(), large);
    assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 图内状态新增/复制/改名/初始与删除、全字段及自转移/入边保护、隐式启动状态、侧栏复制与撤销重做、草稿/备份失败/冲突、32状态边界、导出/重启及深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
