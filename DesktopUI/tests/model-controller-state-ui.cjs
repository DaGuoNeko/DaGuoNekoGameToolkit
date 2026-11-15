const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "state-edit");
  await fs.mkdir(folder, { recursive: true });
  const geometryFile = path.join(folder, "model.geo.json"), animFile = path.join(folder, "model.animation.json"), file = path.join(folder, "model.animation_controllers.json");
  await fs.writeFile(geometryFile, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.state_edit", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const animations = Object.fromEntries([["idle", 0], ["fast", 50], ["slow", -50], ["other", 20]].map(([name, rotation]) => [
    "animation." + name, { loop: true, animation_length: 1, bones: { body: { rotation: [0, 0, rotation] } } },
  ]));
  await fs.writeFile(animFile, JSON.stringify({ animations })); const originalAnimations = await fs.readFile(animFile);
  const id = "controller.animation.edit", source = { keep: true, animation_controllers: {
    [id]: { initial_state: "default", states: {
      default: { animations: ["animation.idle"], transitions: [{ fast: "q.anim_time > 0.15" }, { slow: "q.anim_time > 0.15" }], unknown: "keep-default" },
      fast: { animations: ["animation.fast"] }, slow: { animations: ["animation.slow"], unknown: { keep: true } },
      other: { animations: ["animation.other"] }, back: { animations: [], transitions: [{ default: 1 }] },
    } },
    "controller.animation.unrelated": { states: { default: { animations: [], keep: "default" } } },
  } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const stateCombo = () => page.getByRole("combobox", { name: "控制器状态", exact: true });
  const nameInput = () => page.getByLabel("当前状态名称", { exact: true });
  const row = index => page.getByRole("region", { name: "转移 " + index, exact: true });
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const alert = () => page.locator(".model-controller-editor > [role=alert]");
  const read = async () => JSON.parse(await fs.readFile(file));
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.state_edit" }).click(); await button("动画").click(); await nameInput().waitFor();
  };
  const close = async () => { if (!app) return; const current = app; app = null; const timer = setTimeout(() => current.process().kill(), 5000); try { await current.close(); } finally { clearTimeout(timer); } };
  const capture = async (name, crop = false) => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const box = crop ? await page.locator(".model-view-cell:not([hidden]) canvas").boundingBox() : null;
    const png = await app.evaluate(async ({ BrowserWindow }, box) => {
      const rect = box && Object.fromEntries(Object.entries(box).map(([key, n]) => [key, Math.floor(n)]));
      return (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect || undefined)).toPNG().toString("base64");
    }, box);
    const bytes = Buffer.from(png, "base64"); await fs.writeFile(artifactPath("outputs/" + name + ".png"), bytes); return decodePng(bytes);
  };
  const difference = (a, b) => {
    assert.equal(a.pixels.length, b.pixels.length); let count = 0;
    for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) count++;
    return count;
  };
  const playTo = async state => { await button("播放控制器").click(); await status().filter({ hasText: state + " · animation." }).waitFor(); await button("暂停控制器").click(); };
  const saved = notice => page.getByText(notice, { exact: true }).waitFor();
  const historyStep = async (direction, shortcut) => {
    if (shortcut) { await page.getByRole("region", { name: "动画控制器", exact: true }).focus(); await page.keyboard.press(shortcut); }
    else await button(direction < 0 ? "撤销控制器" : "重做控制器").click();
    await saved(direction < 0 ? "已撤销控制器编辑" : "已重做控制器编辑");
    await page.locator(".model-controller-editor .model-panel-head button:enabled").waitFor();
    assert.equal(await status().innerText(), "从所选状态开始");
  };
  try {
    await launch();
    assert.equal(await button("撤销控制器").isDisabled(), true);
    assert.equal(await button("重做控制器").isDisabled(), true);
    await playTo("fast"); const fast = await capture("priority-fast", true);
    await button("上移转移 2").click(); await saved("已调整转移优先级");
    assert.deepEqual((await read()).animation_controllers[id].states.default.transitions, [{ slow: "q.anim_time > 0.15" }, { fast: "q.anim_time > 0.15" }]);
    await playTo("slow"); const slow = await capture("priority-slow", true); assert.ok(difference(fast, slow) > 500);
    await historyStep(-1, "Control+z"); assert.deepEqual(await read(), source);
    await playTo("fast"); assert.ok(difference(fast, await capture("history-priority-restored", true)) < 150);
    await historyStep(1, "Control+Shift+z");
    assert.deepEqual((await read()).animation_controllers[id].states.default.transitions, [{ slow: "q.anim_time > 0.15" }, { fast: "q.anim_time > 0.15" }]);
    const beforeRename = await fs.readFile(file);
    await nameInput().fill("idle"); await fs.rename(file + ".bak", artifactPath("outputs/previous.bak")); await fs.mkdir(file + ".bak");
    await button("重命名状态").click(); await alert().filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.match(await stateCombo().innerText(), /default/); assert.equal(await nameInput().inputValue(), "idle");
    assert.deepEqual(await fs.readFile(file), beforeRename);
    await fs.rmdir(file + ".bak"); await button("重命名状态").click(); await saved("已重命名状态并更新转移引用");
    assert.match(await stateCombo().innerText(), /idle · 初始/);
    const renamed = await read();
    assert.equal(renamed.animation_controllers[id].initial_state, "idle");
    assert.deepEqual(renamed.animation_controllers[id].states.back.transitions, [{ idle: 1 }]);
    assert.equal(renamed.animation_controllers[id].states.idle.unknown, "keep-default");
    assert.deepEqual(await fs.readFile(file + ".bak"), beforeRename);
    await historyStep(-1); assert.match(await stateCombo().innerText(), /default · 初始/);
    assert.deepEqual(await read(), JSON.parse(beforeRename));
    await historyStep(1, "Control+y"); assert.match(await stateCombo().innerText(), /idle · 初始/);
    assert.deepEqual(await read(), renamed);
    await nameInput().fill("unsaved"); await nameInput().press("Control+z");
    assert.deepEqual(await read(), renamed); await nameInput().press("Escape");
    const weight = page.getByLabel("动画权重 animation.idle", { exact: true });
    await weight.fill("0.5"); await button("保存权重 animation.idle").click(); await saved("已保存动画权重");
    const weighted = await read(); assert.deepEqual(weighted.animation_controllers[id].states.idle.animations, [{ "animation.idle": 0.5 }]);
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("unsaved condition");
    await fs.rename(file + ".bak", artifactPath("outputs/history-previous.bak")); await fs.mkdir(file + ".bak");
    await button("撤销控制器").click(); await alert().filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.deepEqual(await read(), weighted); assert.equal(await button("重做控制器").isDisabled(), true);
    assert.equal(await page.getByLabel("转移 1条件", { exact: true }).inputValue(), "unsaved condition");
    await fs.rmdir(file + ".bak"); await historyStep(-1);
    assert.deepEqual(await read(), renamed); assert.equal(await weight.inputValue(), "");
    assert.equal(await page.getByLabel("转移 1条件", { exact: true }).count(), 0);
    assert.equal(await button("编辑转移 2").isDisabled(), false);
    assert.deepEqual(JSON.parse(await fs.readFile(file + ".bak")), weighted);
    await historyStep(1); assert.deepEqual(await read(), weighted); assert.equal(await weight.inputValue(), "0.5");
    await button("编辑过渡曲线").click(); await select("曲线预设", "缓入");
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Control+z"); assert.deepEqual(await read(), weighted);
    await button("应用过渡曲线").click(); await saved("已保存状态过渡曲线");
    const curved = await read(); assert.equal(typeof curved.animation_controllers[id].states.idle.blend_transition, "object");
    await historyStep(-1); assert.deepEqual(await read(), weighted);
    await historyStep(1); assert.deepEqual(await read(), curved);
    await historyStep(-1); await historyStep(-1); assert.deepEqual(await read(), renamed);
    await button("重做控制器").scrollIntoViewIfNeeded(); await capture("controller-history-dark");
    await nameInput().fill("fast"); await button("重命名状态").click(); await alert().filter({ hasText: "同名" }).waitFor();
    assert.deepEqual(await read(), renamed); await nameInput().press("Escape"); assert.equal(await nameInput().inputValue(), "idle");
    await select("控制器状态", "slow"); await nameInput().fill("relaxed"); await button("重命名状态").click();
    await stateCombo().filter({ hasText: "relaxed" }).waitFor();
    assert.equal(await button("重做控制器").isDisabled(), true);
    assert.deepEqual((await read()).animation_controllers[id].states.idle.transitions[0], { relaxed: "q.anim_time > 0.15" });
    await select("控制器状态", "idle · 初始");
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("0");
    assert.equal(await button("上移转移 2").isDisabled(), true);
    await button("取消转移编辑").click(); assert.deepEqual((await read()).animation_controllers[id].states.idle.transitions[0], { relaxed: "q.anim_time > 0.15" });
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("0");
    await row(1).getByRole("button", { name: "保存转移", exact: true }).click(); await saved("已更新转移");
    await playTo("fast"); assert.ok(difference(fast, await capture("edited-condition", true)) < 150);
    await button("编辑转移 2").click(); await select("转移 2目标", "relaxed");
    await row(2).getByRole("button", { name: "保存转移", exact: true }).click(); await alert().filter({ hasText: "已经有" }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "转移 2目标", exact: true }).innerText(), "relaxed");
    await select("转移 2目标", "other"); await row(2).getByRole("button", { name: "保存转移", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="转移 2条件"]'));
    assert.deepEqual((await read()).animation_controllers[id].states.idle.transitions, [{ relaxed: "0" }, { other: "q.anim_time > 0.15" }]);
    await playTo("other"); await capture("state-edit-dark");
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("1");
    await row(1).scrollIntoViewIfNeeded(); await capture("state-transition-editor-dark");
    const external = await read(); external.external = "keep"; await fs.writeFile(file, JSON.stringify(external));
    await row(1).getByRole("button", { name: "保存转移", exact: true }).click(); await alert().filter({ hasText: "已变化" }).waitFor();
    assert.equal(await page.getByLabel("转移 1条件", { exact: true }).inputValue(), "1");
    assert.deepEqual(await read(), external);
    await button("重新读取").click(); await stateCombo().filter({ hasText: "idle · 初始" }).waitFor();
    assert.equal(await button("撤销控制器").isDisabled(), true);
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("2");
    await row(1).getByRole("button", { name: "保存转移", exact: true }).click(); await saved("已更新转移");
    assert.equal((await read()).animation_controllers[id].states.idle.transitions[0].relaxed, "2");
    await button("撤销控制器").click(); await saved("已撤销控制器编辑");
    assert.equal((await read()).animation_controllers[id].states.idle.transitions[0].relaxed, "0");
    await button("重做控制器").click(); await saved("已重做控制器编辑");
    assert.equal((await read()).animation_controllers[id].states.idle.transitions[0].relaxed, "2");
    await button("撤销控制器").click(); await saved("已撤销控制器编辑");
    const undone = await read(); undone.externalAgain = true; await fs.writeFile(file, JSON.stringify(undone));
    await button("重做控制器").click(); await alert().filter({ hasText: "已变化" }).waitFor();
    assert.deepEqual(await read(), undone); assert.equal(await button("撤销控制器").isDisabled(), true);
    assert.equal(await button("重做控制器").isDisabled(), false);
    await fs.writeFile(file, JSON.stringify(external)); await button("重新读取").click();
    await stateCombo().filter({ hasText: "idle · 初始" }).waitFor();
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("3");
    await row(1).getByRole("button", { name: "保存转移", exact: true }).click(); await saved("已更新转移");
    assert.equal(await button("重做控制器").isDisabled(), true);
    assert.equal((await read()).animation_controllers[id].states.idle.transitions[0].relaxed, "3");
    assert.equal(await button("编辑转移 2").isDisabled(), false);
    await button("编辑转移 1").click(); await page.getByLabel("转移 1条件", { exact: true }).fill("1"); await row(1).getByRole("button", { name: "保存转移", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="转移 1条件"]'));
    await playTo("relaxed");
    await button("删除转移 2").click(); await saved("已删除转移");
    assert.deepEqual((await read()).animation_controllers[id].states.idle.transitions, [{ relaxed: "1" }]);
    await historyStep(-1); assert.equal((await read()).animation_controllers[id].states.idle.transitions.length, 2);
    await historyStep(1); assert.equal((await read()).animation_controllers[id].states.idle.transitions.length, 1);
    await select("控制器状态", "other"); await button("删除状态").click(); await saved("已删除状态");
    assert.equal((await read()).animation_controllers[id].states.other, undefined);
    await historyStep(-1); assert.equal(await nameInput().inputValue(), "other");
    await select("控制器状态", "idle · 初始");
    await select("控制器", "controller.animation.unrelated"); await stateCombo().filter({ hasText: "default" }).waitFor();
    assert.equal(await button("撤销控制器").isDisabled(), true); assert.equal(await button("重做控制器").isDisabled(), true);
    await select("控制器", id); await stateCombo().filter({ hasText: "idle · 初始" }).waitFor();
    assert.equal(await button("撤销控制器").isDisabled(), true);
    const output = artifactPath("outputs/state-edit.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    assert.deepEqual(importProject(JSON.parse(await fs.readFile(output))).controllers, (await read()).animation_controllers);
    await close(); await launch(); assert.match(await stateCombo().innerText(), /idle · 初始/);
    assert.equal(await button("撤销控制器").isDisabled(), true);
    assert.match(await row(1).innerText(), /relaxed：1/); await playTo("relaxed");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await button("编辑转移 1").click(); await row(1).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("state-edit-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await button("取消转移编辑").click();
    assert.deepEqual(await fs.readFile(animFile), originalAnimations);
    assert.deepEqual((await read()).animation_controllers["controller.animation.unrelated"], source.animation_controllers["controller.animation.unrelated"]);
    assert.deepEqual(errors, []);
    console.log("PASS 状态改名/引用、转移编辑/排序/删除、权重/曲线/删除状态的撤销重做、快捷键与输入/弹窗隔离、播放重置及姿势对照、失败保留草稿/游标、备份/外部冲突、历史分支与切换/重读/重启清空、工程往返和深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
