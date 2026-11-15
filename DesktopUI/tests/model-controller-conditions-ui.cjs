const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-conditions");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_conditions", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: { "animation.idle": { animation_length: 0.1, loop: true, bones: { body: { rotation: [0, 0, 20] } } } } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.conditions";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "priority", states: {
    priority: { animations: ["animation.idle"], transitions: [{ done: 0 }, { done: 2 }, { other: "query.unsupported" }] },
    blocked: { transitions: [{ done: 0 }, { done: "query.unsupported" }, { other: 1 }] },
    query: { animations: ["animation.idle"], transitions: [{ done: "q.is_moving && q.all_animations_finished" }, { other: "q.anim_time > 100" }] },
    exact: { transitions: [{ done: "q.anim_time == 0" }] }, quiet: { transitions: [{ done: "q.anim_time > 100" }] },
    done: {}, other: {}, eight: { transitions: Array.from({ length: 8 }, (_, i) => ({ done: i === 7 ? 1 : 0 })) },
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const panel = (scope = page) => scope.getByRole("region", { name: "转移条件检查", exact: true });
  const row = (index, scope = page) => panel(scope).getByRole("listitem", { name: "条件 " + index, exact: true });
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const read = async () => JSON.parse(await fs.readFile(file));
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const inspect = async (scope, name, state) => {
    await scope.getByRole("button", { name, exact: true }).click();
    await panel(scope).getByRole("status", { name: "条件检查时刻" }).filter({ hasText: state + " · 状态时间" }).waitFor();
  };
  const states = async scope => panel(scope).locator("li").evaluateAll(items => items.map(item => item.dataset.result));
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_conditions" }).click(); await button("动画").click(); await button("检查转移条件").waitFor();
  };
  try {
    await launch(); await inspect(page, "检查转移条件", "priority");
    assert.deepEqual(await states(page), ["false", "match", "skipped"]); assert.match(await row(2).innerText(), /计算结果：2/);
    assert.match(await row(3).innerText(), /第 2 条已成立/); assert.equal(await page.getByRole("status", { name: "控制器播放状态" }).innerText(), "从所选状态开始");
    assert.equal(await page.locator(".model-controller-trace li").count(), 0);
    await graph(); assert.deepEqual(await states(dialog()), ["false", "match", "skipped"]);
    assert.equal(await status().innerText(), "从编辑所选状态开始");
    await inspect(dialog(), "检查图中条件", "priority"); assert.equal(await dialog().getByRole("alert").count(), 0);
    await panel(dialog()).scrollIntoViewIfNeeded(); await capture("conditions-priority-dark");
    assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" });
    await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: "done · 已暂停" }).waitFor(); await panel(dialog()).waitFor({ state: "hidden" });
    assert.equal(await dialog().locator(".model-controller-trace li").count(), 1); assert.equal(await node("priority").getAttribute("aria-pressed"), "true");
    const paused = await status().innerText(); await inspect(dialog(), "检查图中条件", "done"); assert.match(await panel(dialog()).innerText(), /没有出站转移/);
    assert.equal(await status().innerText(), paused); assert.equal(await dialog().locator(".model-controller-trace li").count(), 1);
    await graphButton("播放图中预览").click(); await graphButton("暂停图中预览").waitFor(); await panel(dialog()).waitFor({ state: "hidden" });
    assert.equal(await graphButton("检查图中条件").isDisabled(), true); await graphButton("暂停图中预览").click();
    await graphButton("重置图中预览").click(); await status().filter({ hasText: "从编辑所选状态开始" }).waitFor();

    await node("blocked").click(); await inspect(dialog(), "检查图中条件", "blocked");
    assert.deepEqual(await states(dialog()), ["false", "error", "skipped"]); assert.match(await row(2, dialog()).innerText(), /不支持/);
    assert.match(await row(3, dialog()).innerText(), /第 2 条报错/); assert.equal(await dialog().getByRole("alert").count(), 0);
    await graphButton("图中单步 0.05 秒").click(); await dialog().getByRole("alert").filter({ hasText: "不支持" }).waitFor();
    await panel(dialog()).waitFor({ state: "hidden" }); assert.equal(await dialog().locator(".model-controller-trace li").count(), 0);
    await graphButton("重置图中预览").click(); await node("exact").click(); await inspect(dialog(), "检查图中条件", "exact");
    assert.equal(await row(1, dialog()).getAttribute("data-result"), "match");
    await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: "exact · 已暂停 · 状态时间 0.050" }).waitFor();
    await inspect(dialog(), "检查图中条件", "exact"); assert.equal(await row(1, dialog()).getAttribute("data-result"), "false");
    assert.equal(await dialog().locator(".model-controller-trace li").count(), 0);

    await node("query").click(); await panel(dialog()).waitFor({ state: "hidden" }); await graphButton("关闭").click();
    await page.getByRole("checkbox", { name: "启用模拟查询", exact: true }).check();
    await button("单步 0.05 秒").click(); await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "0.05 秒" }).waitFor();
    await button("单步 0.05 秒").click(); await page.getByRole("status", { name: "控制器播放状态" }).filter({ hasText: "0.10 秒" }).waitFor();
    await inspect(page, "检查转移条件", "query"); assert.deepEqual(await states(page), ["false", "false"]);
    await page.getByLabel("模拟水平速度（米/秒）", { exact: true }).fill(""); await panel().waitFor({ state: "hidden" });
    await button("检查转移条件").click(); await page.locator(".model-controller-preview > [role=alert]").filter({ hasText: "不能为空" }).waitFor();
    assert.equal(await panel().count(), 0);
    await page.getByLabel("模拟水平速度（米/秒）", { exact: true }).fill("0"); await inspect(page, "检查转移条件", "query");
    assert.deepEqual(await states(page), ["false", "false"]);
    await page.getByRole("checkbox", { name: "模拟移动", exact: true }).check(); await panel().waitFor({ state: "hidden" });
    await inspect(page, "检查转移条件", "query"); assert.deepEqual(await states(page), ["match", "skipped"]);
    assert.match(await panel().innerText(), /0.100 秒/); assert.equal(await page.locator(".model-controller-trace li").count(), 0);
    await graph(); assert.deepEqual(await states(dialog()), ["match", "skipped"]);
    await graphButton("图中单步 0.05 秒").click(); await status().filter({ hasText: "done · 已暂停" }).waitFor(); await panel(dialog()).waitFor({ state: "hidden" });
    assert.equal(await dialog().locator(".model-controller-trace li").count(), 1); assert.deepEqual(await fs.readFile(file), original);

    await node("quiet").click(); await inspect(dialog(), "检查图中条件", "quiet");
    await graphButton("编辑转移 1").click(); await dialog().getByLabel("转移 1条件", { exact: true }).fill("1");
    await graphButton("保存转移").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已更新转移" }).waitFor();
    await panel(dialog()).waitFor({ state: "hidden" });
    await inspect(dialog(), "检查图中条件", "quiet"); assert.equal(await row(1, dialog()).getAttribute("data-result"), "match");
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    await panel(dialog()).waitFor({ state: "hidden" }); assert.deepEqual(await read(), source);
    await inspect(dialog(), "检查图中条件", "quiet"); assert.equal(await row(1, dialog()).getAttribute("data-result"), "false");
    await graphButton("重置图中预览").click(); await panel(dialog()).waitFor({ state: "hidden" });
    await node("eight").click(); await inspect(dialog(), "检查图中条件", "eight");
    assert.deepEqual(await states(dialog()), ["false", "false", "false", "false", "false", "false", "false", "match"]);
    await row(8, dialog()).scrollIntoViewIfNeeded();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await node("blocked").click(); await inspect(dialog(), "检查图中条件", "blocked"); await panel(dialog()).scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("conditions-error-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("关闭").click(); await close(); await launch(); assert.equal(await panel().count(), 0);
    await graph(); assert.equal(await panel(dialog()).count(), 0); assert.equal(await node("priority").getAttribute("aria-pressed"), "true");
    assert.deepEqual(await read(), source); assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 条件真假/数值/优先级短路/错误阻断、检查不推进或写盘、实际运行状态、完成/模拟查询、检查与下一步区别、结果失效/重置/编辑撤销、八条上限及深浅窄窗/重启");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
