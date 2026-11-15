const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-arrange");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), animFile = path.join(folder, "model.animation.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_arrange", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  await fs.writeFile(animFile, JSON.stringify({ animations: { "animation.idle": { animation_length: 1, loop: true, bones: { body: { rotation: [0, 0, 20] } } } } }));
  const animBytes = await fs.readFile(animFile), id = "controller.animation.arrange";
  const source = { keep: true, animation_controllers: { [id]: { states: {
    alpha: { animations: ["animation.idle"], transitions: [{ beta: "q.anim_time >= 0.1" }, { gamma: "q.anim_time >= 0.1" }] },
    beta: {}, gamma: {}, delta: {}, epsilon: {}, zeta: {},
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const node = name => graphButton("状态节点 " + name);
  const title = name => node(name).locator(".model-controller-graph-node-head");
  const port = name => graphButton("从 " + name + " 连接转移");
  const board = () => dialog().getByRole("region", { name: "状态连线画布" });
  const ghost = () => dialog().locator(".model-controller-arrange-ghost");
  const center = async locator => { const r = await locator.boundingBox(); assert.ok(r); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const position = name => node(name).evaluate(element => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
  const graph = async () => { await button("状态关系图").click(); await dialog().getByRole("heading", { name: "状态关系图", exact: true }).waitFor(); };
  const begin = async (from, to) => { await title(from).scrollIntoViewIfNeeded(); const a = await center(title(from)), b = await center(node(to)); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await ghost().waitFor(); };
  const swap = async (from, to) => {
    const a = await position(from), b = await position(to); await begin(from, to); await page.mouse.up(); await ghost().waitFor({ state: "hidden" });
    assert.deepEqual(await position(from), b); assert.deepEqual(await position(to), a);
  };
  const saved = async message => { await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: message }).waitFor(); await graphButton("关闭").and(page.locator(":enabled")).waitFor(); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_arrange" }).click(); await button("动画").click(); await graph();
    await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click();
    const originalAlpha = await position("alpha"), originalGamma = await position("gamma");
    await begin("alpha", "gamma"); assert.equal(await node("gamma").getAttribute("data-swap-target"), "true"); assert.equal(await graphButton("关闭").isDisabled(), true);
    assert.equal(await port("alpha").isDisabled(), true); await capture("arrange-drag-dark"); await page.keyboard.press("Escape"); await page.mouse.up();
    assert.deepEqual(await position("alpha"), originalAlpha); assert.deepEqual(await position("gamma"), originalGamma);
    await node("gamma").click(); assert.equal(await node("gamma").getAttribute("aria-pressed"), "true"); await node("alpha").click();
    await begin("alpha", "gamma"); await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); assert.deepEqual(await position("alpha"), originalAlpha);
    await begin("alpha", "gamma"); await title("alpha").dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up(); assert.deepEqual(await position("alpha"), originalAlpha);
    await begin("alpha", "gamma"); await title("alpha").evaluate(element => { if (element.hasPointerCapture(1)) element.releasePointerCapture(1); }); await page.mouse.move(10, 10); await page.mouse.up(); assert.deepEqual(await position("alpha"), originalAlpha);
    await begin("alpha", "gamma"); await page.mouse.move(10, 10); await page.mouse.up(); assert.deepEqual(await position("alpha"), originalAlpha);
    await swap("alpha", "gamma"); assert.equal(await node("alpha").getAttribute("aria-pressed"), "true"); assert.match(await node("alpha").innerText(), /初始/);
    assert.doesNotMatch(await node("gamma").innerText(), /初始/);
    const endpoints = await dialog().locator('[data-transition-index="0"] .connection').evaluate(element => {
      const m = element.getScreenCTM(), convert = p => ({ x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f });
      return { start: convert(element.getPointAtLength(0)), end: convert(element.getPointAtLength(element.getTotalLength())) };
    });
    const alpha = await node("alpha").boundingBox(), beta = await node("beta").boundingBox(), connector = await center(port("alpha"));
    assert.ok(Math.abs(endpoints.start.x - alpha.x - alpha.width) < 1 && Math.abs(connector.x - endpoints.start.x) < 1);
    assert.ok(Math.abs(endpoints.end.y - beta.y) < 1 && endpoints.end.x > beta.x && endpoints.end.x < beta.x + beta.width);
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "运行到转移状态" }).filter({ hasText: "alpha → beta 的第 1 条" }).waitFor();
    const playback = await dialog().getByRole("status", { name: "关系图运行状态" }).innerText();
    await swap("beta", "gamma"); assert.equal(await dialog().getByRole("status", { name: "关系图运行状态" }).innerText(), playback);
    assert.equal(await dialog().locator(".model-controller-trace li").count(), 1);
    const beforeKeyboard = await position("gamma"); await node("alpha").focus(); await page.keyboard.press("Alt+ArrowLeft"); assert.deepEqual(await position("alpha"), beforeKeyboard);
    assert.equal(await node("alpha").getAttribute("aria-pressed"), "true");
    await graphButton("恢复状态排列").click(); assert.deepEqual(await position("alpha"), originalAlpha);
    await title("beta").click(); assert.equal(await node("beta").getAttribute("aria-pressed"), "true"); await node("alpha").click();
    await graphButton("放大关系图").click(); await graphButton("放大关系图").click(); await swap("alpha", "beta");
    await graphButton("恢复状态排列").click(); await graphButton("放大关系图").click(); await graphButton("放大关系图").click(); await swap("alpha", "beta");
    assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" }); assert.equal(await graphButton("撤销控制器").isDisabled(), true);
    const rearranged = await position("alpha");
    await graphButton("适应宽度").click(); await port("delta").focus(); await page.keyboard.press("Enter");
    await dialog().getByRole("combobox", { name: "新转移目标" }).click(); await page.getByRole("option", { name: "epsilon", exact: true }).click(); await graphButton("保存新转移").click(); await saved("已添加转移");
    assert.deepEqual(await position("alpha"), rearranged);
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑"); assert.deepEqual(await position("alpha"), rearranged); assert.deepEqual(JSON.parse(await fs.readFile(file)), source);
    await graphButton("重命名状态").click(); await dialog().getByLabel("图中状态名称", { exact: true }).fill("delta_renamed"); await graphButton("保存状态").click(); await saved("已重命名状态并更新转移引用");
    await page.waitForFunction(() => document.querySelector('[aria-label="状态节点 alpha"]').style.left === "96px");
    await graphButton("撤销控制器").click(); await saved("已撤销控制器编辑");
    await swap("alpha", "beta"); await graphButton("关闭").click(); await graph(); assert.deepEqual(await position("alpha"), originalAlpha);
    await title("delta").dblclick(); await dialog().waitFor({ state: "hidden" }); assert.equal(await page.getByLabel("当前状态名称", { exact: true }).inputValue(), "delta");
    const names = Array.from({ length: 32 }, (_, i) => "state_" + i), large = { animation_controllers: { [id]: { states: Object.fromEntries(names.map(name => [name, {}])) } } };
    await fs.writeFile(file, JSON.stringify(large)); const largeBytes = await fs.readFile(file); await button("重新读取").click(); await page.getByLabel("当前状态名称", { exact: true }).waitFor(); await graph();
    await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click(); await title("state_0").scrollIntoViewIfNeeded(); const start = await center(title("state_0"));
    const extent = await board().evaluate(element => ({ width: element.scrollWidth, height: element.scrollHeight }));
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    const edge = await board().evaluate(element => { const r = element.getBoundingClientRect(), c = element.closest(".modal-body").getBoundingClientRect(); return { x: r.left + element.clientWidth / 2, y: Math.min(r.top + element.clientTop + element.clientHeight, c.bottom) - 3 }; });
    await page.mouse.move(edge.x, edge.y, { steps: 3 }); await page.waitForFunction(() => { const e = document.querySelector(".model-controller-graph-scroll"); return e.scrollHeight - e.clientHeight - e.scrollTop < 2; });
    assert.deepEqual(await board().evaluate(element => ({ width: element.scrollWidth, height: element.scrollHeight })), extent);
    const beforeFar = await position("state_31"), end = await center(node("state_31")); await page.mouse.move(end.x, end.y); await page.mouse.up(); await ghost().waitFor({ state: "hidden" });
    assert.deepEqual(await position("state_0"), beforeFar); assert.equal(await node("state_0").getAttribute("aria-pressed"), "true"); assert.deepEqual(await fs.readFile(file), largeBytes);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await graphButton("适应宽度").click(); await graphButton("定位所选").click(); await page.waitForTimeout(300); await capture("arrange-small-light"); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await graphButton("恢复状态排列").click(); assert.deepEqual(await position("state_0"), originalAlpha); assert.deepEqual(await fs.readFile(file), largeBytes);
    assert.deepEqual(await fs.readFile(animFile), animBytes); assert.deepEqual(errors, []);
    console.log("PASS 标题拖动/网格换位/键盘替代、连线与连接点同步、50%/100%/150%坐标、取消/失焦/捕获丢失、播放和选择不变、编辑/恢复/重开边界、32状态边缘滚动及文件不变/深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { if (app) { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } } }
})().catch(error => { console.error(error); process.exitCode = 1; });
