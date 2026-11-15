const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "connect-scroll");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.connect_scroll", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const id = "controller.animation.scroll", names = Array.from({ length: 32 }, (_, i) => "state_" + i);
  const source = { keep: true, animation_controllers: { [id]: { states: Object.fromEntries(names.map(name => [name, {}])) } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const board = () => dialog().getByRole("region", { name: "状态连线画布" });
  const node = name => graphButton("状态节点 " + name);
  const port = name => graphButton("从 " + name + " 连接转移");
  const draft = () => dialog().getByRole("region", { name: "新增转移草稿" });
  const line = () => dialog().locator(".model-controller-connect-line");
  const center = async locator => { const b = await locator.boundingBox(); assert.ok(b); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const bounds = () => board().evaluate(element => {
    const r = element.getBoundingClientRect(), c = element.closest(".modal-body").getBoundingClientRect();
    return { left: Math.max(r.left + element.clientLeft, c.left, 0), top: Math.max(r.top + element.clientTop, c.top, 0), right: Math.min(r.left + element.clientLeft + element.clientWidth, c.right, innerWidth), bottom: Math.min(r.top + element.clientTop + element.clientHeight, c.bottom, innerHeight) };
  });
  const scrollPosition = () => board().evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop, outer: element.closest(".modal-body").scrollTop }));
  const begin = async name => { await port(name).scrollIntoViewIfNeeded(); const p = await center(port(name)); await page.mouse.move(p.x, p.y); await page.mouse.down(); };
  const edge = async (horizontal, vertical) => {
    const b = await bounds(), x = horizontal < 0 ? b.left + 3 : horizontal > 0 ? b.right - 3 : (b.left + b.right) / 2, y = vertical < 0 ? b.top + 3 : vertical > 0 ? b.bottom - 3 : (b.top + b.bottom) / 2;
    await page.mouse.move(x, y, { steps: 3 }); return { x, y };
  };
  const atBoundary = axis => page.waitForFunction(axis => {
    const e = document.querySelector(".model-controller-graph-scroll");
    return axis === "bottom" ? e.scrollHeight - e.clientHeight - e.scrollTop < 2 : axis === "right" ? e.scrollWidth - e.clientWidth - e.scrollLeft < 2 : axis === "left" ? e.scrollLeft < 2 : e.scrollTop < 2;
  }, axis);
  const stable = async () => { const at = await scrollPosition(); await page.waitForTimeout(180); assert.deepEqual(await scrollPosition(), at); };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.connect_scroll" }).click(); await button("动画").click(); await button("状态关系图").click();
    await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click();
    await begin("state_0"); await stable(); const initial = await scrollPosition();
    await edge(0, 1); await page.waitForFunction(() => document.querySelector(".model-controller-graph-scroll").scrollTop > 300);
    const stationary = await edge(0, 0); await stable();
    const endpoint = await line().evaluate(element => {
      const p = element.getPointAtLength(element.getTotalLength()), m = element.getScreenCTM(); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    });
    assert.ok(Math.abs(endpoint.x - stationary.x) < 1 && Math.abs(endpoint.y - stationary.y) < 1);
    assert.equal((await scrollPosition()).outer, initial.outer);
    const visible = await bounds(); await page.mouse.move(visible.left - 12, (visible.top + visible.bottom) / 2); await stable();
    await edge(0, 1); await atBoundary("bottom"); await stable();
    const target = await center(node("state_31")); await page.mouse.move(target.x, target.y); await page.mouse.up(); await draft().waitFor();
    assert.match(await draft().innerText(), /从 state_0 转移到/); assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), "state_31");
    await stable(); assert.deepEqual(await fs.readFile(file), original);
    await graphButton("取消添加转移").click();
    await begin("state_31"); await edge(0, -1); await atBoundary("top");
    const back = await center(node("state_0")); await page.mouse.move(back.x, back.y); await page.mouse.up(); await draft().waitFor();
    assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), "state_0"); await graphButton("取消添加转移").click();
    await begin("state_0"); await edge(0, 1); await page.waitForFunction(() => document.querySelector(".model-controller-graph-scroll").scrollTop > 200);
    await page.keyboard.press("Escape"); await page.mouse.up(); await line().waitFor({ state: "hidden" }); await stable(); assert.equal(await draft().count(), 0);
    await begin("state_0"); await edge(0, 1); await page.waitForFunction(() => document.querySelector(".model-controller-graph-scroll").scrollTop > 200);
    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); await line().waitFor({ state: "hidden" }); await stable();

    for (let i = 0; i < 4; i++) await graphButton("放大关系图").click();
    await begin("state_0"); await edge(1, 0); await atBoundary("right"); await stable();
    const toRight = await center(node("state_2")); await page.mouse.move(toRight.x, toRight.y); await page.mouse.up(); await draft().waitFor();
    assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), "state_2"); await graphButton("取消添加转移").click();
    await begin("state_2"); await edge(-1, 0); await atBoundary("left");
    const toLeft = await center(node("state_0")); await page.mouse.move(toLeft.x, toLeft.y); await page.mouse.up(); await draft().waitFor();
    assert.equal(await draft().getByRole("combobox", { name: "新转移目标" }).innerText(), "state_0"); await graphButton("取消添加转移").click();
    await begin("state_0"); await edge(1, 1); await page.waitForFunction(() => { const e = document.querySelector(".model-controller-graph-scroll"); return e.scrollLeft > 100 && e.scrollTop > 100; });
    await edge(0, 0); await stable(); await capture("edge-scroll-dark");
    await port("state_0").dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up(); await line().waitFor({ state: "hidden" }); await stable();
    assert.deepEqual(await fs.readFile(file), original);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await graphButton("适应宽度").click();
    await begin("state_0"); await edge(0, 1); await atBoundary("bottom");
    const end = await center(node("state_31")); await page.mouse.move(end.x, end.y); await page.mouse.up(); await draft().waitFor();
    await draft().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("edge-scroll-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await draft().getByLabel("新转移条件", { exact: true }).fill("1"); await graphButton("保存新转移").click();
    await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已添加转移" }).waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(file)).animation_controllers[id].states.state_0.transitions, [{ state_31: "1" }]);
    assert.deepEqual(await fs.readFile(file + ".bak"), original);
    await graphButton("撤销控制器").click(); await dialog().getByRole("status", { name: "关系图保存状态" }).filter({ hasText: "已撤销控制器编辑" }).waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(file)), source); assert.deepEqual(errors, []);
    console.log("PASS 32状态跨屏拖线、四向/对角自动滚动、50%/150%缩放、静止指针连线坐标、中心/画布外/边界停止、释放/Esc/失焦/取消停止、外层不滚动、保存备份/撤销及深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { if (app) { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } } }
})().catch(error => { console.error(error); process.exitCode = 1; });
