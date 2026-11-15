const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-connect");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_connect", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: { "animation.idle": { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, 20] } } } } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.connect";
  const source = { keep: true, animation_controllers: { [id]: { initial_state: "idle", states: {
    idle: { animations: ["animation.idle"], transitions: [{ walk: "0" }], keep: true }, walk: {}, jump: {},
    spare: {}, far: {}, last: {},
  } }, "controller.animation.other": { states: { default: {} } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const port = name => graphButton("从 " + name + " 连接转移");
  const board = () => dialog().getByRole("region", { name: "状态连线画布" });
  const draft = () => dialog().getByRole("region", { name: "新增转移草稿" });
  const read = async () => JSON.parse(await fs.readFile(file));
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const saved = async text => { await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: text }).waitFor(); await graphButton("关闭").and(page.locator(":enabled")).waitFor(); };
  const line = () => dialog().locator(".model-controller-connect-line");
  const center = async locator => { const box = await locator.boundingBox(); assert.ok(box); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const begin = async (from, to) => {
    await port(from).scrollIntoViewIfNeeded();
    const a = await center(port(from)), b = await center(node(to));
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
    await line().waitFor(); return b;
  };
  const connect = async (from, to) => { await begin(from, to); await page.mouse.up(); await draft().waitFor(); assert.match(await draft().innerText(), new RegExp("从 " + from + " 转移到")); assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), to); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_connect" }).click(); await button("动画").click(); await button("状态关系图").waitFor();
  };
  try {
    await launch(); await graph();
    await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click();
    for (const target of ["idle", "walk"]) {
      await begin("idle", target); assert.equal(await dialog().locator(".model-controller-connect-target").count(), 0);
      await page.mouse.up(); assert.equal(await draft().count(), 0); assert.equal(await node("idle").getAttribute("aria-pressed"), "true");
    }
    await begin("walk", "jump"); assert.equal(await dialog().locator(".model-controller-connect-target").count(), 1);
    assert.equal(await graphButton("关闭").isDisabled(), true); assert.equal(await graphButton("放大关系图").isDisabled(), true);
    assert.equal(await node("idle").getAttribute("aria-pressed"), "true"); await capture("connect-drag-dark");
    await page.keyboard.press("Escape"); await page.mouse.up(); assert.equal(await draft().count(), 0); assert.equal(await line().count(), 0);
    assert.equal(await graphButton("关闭").isEnabled(), true);
    await begin("walk", "jump"); await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); assert.equal(await draft().count(), 0);
    await begin("walk", "jump"); await port("walk").dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up(); assert.equal(await draft().count(), 0);
    await begin("walk", "jump"); await port("walk").evaluate(element => { if (element.hasPointerCapture(1)) element.releasePointerCapture(1); }); await page.mouse.move(20, 20); await page.mouse.up(); assert.equal(await draft().count(), 0);
    await begin("walk", "jump"); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900)); await line().waitFor({ state: "hidden" }); await page.mouse.up(); assert.equal(await draft().count(), 0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await begin("walk", "jump"); await page.mouse.move(10, 10); await page.mouse.up(); assert.equal(await draft().count(), 0);
    assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" });

    await connect("walk", "jump"); assert.equal(await node("walk").getAttribute("aria-pressed"), "true");
    assert.equal(await port("idle").isDisabled(), true); assert.deepEqual(await fs.readFile(file), original);
    await draft().getByLabel("新转移条件", { exact: true }).fill("0"); await graphButton("保存新转移").click(); await saved("已添加转移");
    assert.deepEqual((await read()).animation_controllers[id].states.walk.transitions, [{ jump: "0" }]); assert.deepEqual(await fs.readFile(file + ".bak"), original);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.deepEqual(await read(), source);
    await graphButton("重做控制器").click(); await saved("已重做控制器编辑");
    await graphButton("放大关系图").click(); await graphButton("放大关系图").click();
    await connect("spare", "far"); await graphButton("取消添加转移").click();
    await graphButton("放大关系图").click(); await graphButton("放大关系图").click();
    await connect("spare", "far"); await draft().getByLabel("新转移条件", { exact: true }).fill("1");
    const beforeFailure = await fs.readFile(file); await fs.rename(file + ".bak", artifactPath("outputs/previous-backup.json")); await fs.mkdir(file + ".bak");
    await graphButton("保存新转移").click(); await dialog().getByRole("alert").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.deepEqual(await fs.readFile(file), beforeFailure); assert.equal(await draft().getByLabel("新转移条件", { exact: true }).inputValue(), "1");
    await fs.rmdir(file + ".bak"); await graphButton("保存新转移").click(); await saved("已添加转移");
    assert.deepEqual(await fs.readFile(file + ".bak"), beforeFailure);
    await graphButton("适应宽度").click(); await port("far").focus(); await page.keyboard.press("Enter"); await draft().waitFor();
    assert.match(await draft().innerText(), /从 far 转移到/); await select("新转移目标", "last"); await draft().getByLabel("新转移条件", { exact: true }).fill("1");
    const external = await read(); external.external = true; await fs.writeFile(file, JSON.stringify(external));
    await graphButton("保存新转移").click(); await dialog().getByRole("alert").filter({ hasText: "已变化" }).waitFor(); assert.deepEqual(await read(), external);
    await graphButton("取消添加转移").click(); await graphButton("关闭").click(); await button("重新读取").click();
    await page.getByRole("combobox", { name: "控制器状态", exact: true }).filter({ hasText: "idle" }).waitFor(); await graph();
    await port("far").focus(); await page.keyboard.press("Space"); await draft().waitFor(); await select("新转移目标", "last");
    await draft().getByLabel("新转移条件", { exact: true }).fill("1"); await graphButton("保存新转移").click(); await saved("已添加转移");
    await graphButton("编辑转移 1").click(); assert.equal(await port("idle").isDisabled(), true); await graphButton("取消转移编辑").click();
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "运行到转移状态", exact: true }).filter({ hasText: "far → last" }).waitFor();
    assert.equal(await node("far").getAttribute("aria-pressed"), "true"); assert.equal(await node("last").getAttribute("data-running"), "true");
    const finished = await read(); assert.equal(finished.external, true); assert.equal(finished.animation_controllers[id].states.idle.keep, true);
    await graphButton("关闭").click();
    const output = artifactPath("outputs/connect.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor(); assert.deepEqual(importProject(JSON.parse(await fs.readFile(output))).controllers, finished.animation_controllers);
    await close(); await launch(); assert.deepEqual(await read(), finished); await graph(); await graphButton("关闭").click();

    const names = Array.from({ length: 10 }, (_, i) => "s" + i);
    const large = { animation_controllers: { [id]: { states: Object.fromEntries(names.map((name, i) => [name, i === 0 ? { transitions: names.slice(1, 9).map(to => ({ [to]: 0 })) } : {}])) } } };
    await fs.writeFile(file, JSON.stringify(large)); await button("重新读取").click(); await page.getByRole("combobox", { name: "控制器状态", exact: true }).filter({ hasText: "s0" }).waitFor(); await graph();
    assert.equal(await port("s0").isDisabled(), true);
    await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click();
    await port("s1").scrollIntoViewIfNeeded(); const a = await center(port("s1")); await page.mouse.move(a.x, a.y); await page.mouse.down();
    await board().evaluate(element => { element.scrollTop = element.scrollHeight; });
    const b = await center(node("s9")); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await draft().waitFor();
    assert.match(await draft().innerText(), /从 s1 转移到/); assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), "s9");
    await graphButton("取消添加转移").click(); assert.deepEqual(await read(), large);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await graphButton("适应宽度").click();
    await connect("s7", "s8"); await draft().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("connect-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("取消添加转移").click(); await graphButton("关闭").click();
    const full = { animation_controllers: { [id]: { states: { a: { transitions: [{ b: 0 }] }, b: {} } } } };
    await fs.writeFile(file, JSON.stringify(full)); await button("重新读取").click(); await page.getByRole("combobox", { name: "控制器状态", exact: true }).filter({ hasText: "a" }).waitFor(); await graph(); assert.equal(await port("a").isDisabled(), true);
    assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 实际拖线/虚线目标反馈/任意源状态、缩放与滚动坐标、取消/失焦/指针取消、键盘替代、重复/自转移/上限拒绝、草稿保存/备份失败/外部冲突、撤销重做/工程往返/重启及深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
