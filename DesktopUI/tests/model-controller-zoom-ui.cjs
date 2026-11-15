const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-zoom");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json"), names = Array.from({ length: 32 }, (_, i) => "state_" + i);
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_zoom", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const source = { keep: true, animation_controllers: { "controller.animation.zoom": { states: Object.fromEntries(names.map((name, i) => [name, i === 0 ? { transitions: [{ state_1: 1 }] } : {}])) } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const board = () => dialog().getByRole("region", { name: "状态连线画布" });
  const node = name => graphButton("状态节点 " + name);
  const zoomValue = () => dialog().getByLabel("关系图缩放", { exact: true });
  const zoom = () => board().locator(".model-controller-graph-board").evaluate(element => Number(element.style.transform.match(/[\d.]+/)[0]));
  const waitZoom = value => page.waitForFunction(value => Math.abs(Number(document.querySelector(".model-controller-graph-board").style.transform.match(/[\d.]+/)[0]) - value) < 1e-6, value);
  const anchor = () => board().evaluate(e => {
    const r = e.getBoundingClientRect(), c = e.closest(".modal-body").getBoundingClientRect();
    return { x: r.left + e.clientLeft + Math.min(300, e.clientWidth / 2), y: (Math.max(r.top + e.clientTop, c.top) + Math.min(r.top + e.clientTop + e.clientHeight, c.bottom)) / 2 };
  });
  const world = point => board().locator(".model-controller-graph-board").evaluate((e, p) => { const r = e.getBoundingClientRect(), scale = Number(e.style.transform.match(/[\d.]+/)[0]); return { x: (p.x - r.left) / scale, y: (p.y - r.top) / scale }; }, point);
  const near = (a, b) => { assert.ok(Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5, JSON.stringify({ before: a, after: b })); };
  const wheel = async (delta, point) => { await page.mouse.move(point.x, point.y); await page.keyboard.down("Control"); await page.mouse.wheel(0, delta); await page.keyboard.up("Control"); };
  const center = async locator => { const r = await locator.boundingBox(); assert.ok(r); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  const fitCheck = async () => {
    await graphButton("适应全图").click(); await page.waitForFunction(() => { const e = document.querySelector(".model-controller-graph-scroll"); return e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1; });
    const box = await board().boundingBox();
    const centered = await board().evaluate(e => { const a = e.getBoundingClientRect(), b = e.querySelector(".model-controller-graph-board").getBoundingClientRect(); return Math.abs(a.left + e.clientLeft + e.clientWidth / 2 - b.left - b.width / 2); });
    assert.ok(centered < 1);
    for (const name of ["state_0", "state_31"]) {
      const card = await node(name).boundingBox();
      assert.ok(card.x >= box.x && card.y >= box.y && card.x + card.width <= box.x + box.width && card.y + card.height <= box.y + box.height);
    }
  };
  try {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_zoom" }).click(); await button("动画").click(); await button("状态关系图").click();
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "运行到转移状态" }).filter({ hasText: "state_0 → state_1" }).waitFor();
    const playback = await dialog().getByRole("status", { name: "关系图运行状态" }).innerText();
    await board().scrollIntoViewIfNeeded(); await board().evaluate(e => { e.scrollTop = 600; e.scrollLeft = 100; });
    const point = await anchor(), before = await world(point), appZoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
    await wheel(-100, point); await waitZoom(1.1); near(before, await world(point));
    await wheel(100, point); await waitZoom(1); near(before, await world(point));
    await page.evaluate(point => {
      const e = document.querySelector(".model-controller-graph-scroll");
      for (const deltaY of [-100, -100, 100]) e.dispatchEvent(new WheelEvent("wheel", { clientX: point.x, clientY: point.y, ctrlKey: true, deltaY, bubbles: true, cancelable: true }));
    }, point);
    await waitZoom(1.1); near(before, await world(point));
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), appZoom);
    const beforeScroll = await board().evaluate(e => e.scrollTop); await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 160);
    await page.waitForFunction(top => document.querySelector(".model-controller-graph-scroll").scrollTop > top, beforeScroll); assert.equal(Math.round(await zoom() * 100), 110);
    await page.waitForTimeout(150);
    const centerPoint = await board().evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left + e.clientLeft + e.clientWidth / 2, y: r.top + e.clientTop + e.clientHeight / 2 }; });
    const centered = await world(centerPoint); await graphButton("放大关系图").click(); await waitZoom(1.35); near(centered, await world(centerPoint));
    assert.equal(await node("state_0").getAttribute("aria-pressed"), "true");
    await page.evaluate(point => {
      const e = document.querySelector(".model-controller-graph-scroll");
      for (let i = 0; i < 30; i++) e.dispatchEvent(new WheelEvent("wheel", { clientX: point.x, clientY: point.y, ctrlKey: true, deltaY: 100, bubbles: true, cancelable: true }));
    }, point);
    await waitZoom(0.05); assert.equal(await graphButton("缩小关系图").isDisabled(), true);
    await page.evaluate(point => {
      const e = document.querySelector(".model-controller-graph-scroll");
      for (let i = 0; i < 30; i++) e.dispatchEvent(new WheelEvent("wheel", { clientX: point.x, clientY: point.y, ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }));
    }, point);
    await waitZoom(1.5); assert.equal(await graphButton("放大关系图").isDisabled(), true);
    await fitCheck(); assert.ok(await zoom() < 0.5); await capture("fit-all-dark");
    await graphButton("适应宽度").click(); await page.waitForFunction(() => { const e = document.querySelector(".model-controller-graph-scroll"); return e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight > e.clientHeight; });
    await graphButton("定位所选").click(); const oldScale = await zoom();
    const header = node("state_0").locator(".model-controller-graph-node-head"); await header.scrollIntoViewIfNeeded(); const head = await center(header), target = await center(node("state_1"));
    await page.mouse.move(head.x, head.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 }); await dialog().locator(".model-controller-arrange-ghost").waitFor();
    await wheel(-100, target); await page.waitForTimeout(100); assert.equal(await zoom(), oldScale); await page.keyboard.press("Escape"); await page.mouse.up();
    const port = graphButton("从 state_0 连接转移"); await port.scrollIntoViewIfNeeded(); const p = await center(port);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(target.x, target.y); await dialog().locator(".model-controller-connect-line").waitFor();
    await wheel(-100, target); await page.waitForTimeout(100); assert.equal(await zoom(), oldScale); await page.keyboard.press("Escape"); await page.mouse.up();
    const blank = await board().evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 12 }; });
    await page.mouse.move(blank.x, blank.y); await page.mouse.down(); assert.equal(await board().getAttribute("data-panning"), "true");
    await wheel(-100, blank); await page.waitForTimeout(100); assert.equal(await zoom(), oldScale); await page.keyboard.press("Escape"); await page.mouse.up();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), appZoom);
    assert.equal(await dialog().getByRole("status", { name: "关系图运行状态" }).innerText(), playback); assert.equal(await dialog().locator(".model-controller-trace li").count(), 1);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await fitCheck(); await page.waitForTimeout(300); await capture("fit-all-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" }); assert.deepEqual(errors, []);
    await graphButton("关闭").click(); await button("状态关系图").click(); await zoomValue().waitFor(); assert.equal(await zoomValue().innerText(), "100%");
    assert.equal(await graphButton("撤销控制器").isDisabled(), true);
    console.log("PASS Ctrl滚轮定点/连续事件与限幅、按钮中心缩放、普通滚轮保留、32状态适应全图/宽度、拖动手势互斥、应用缩放/播放/选择/文件不变及深浅窄窗/重开");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { if (app) { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } } }
})().catch(error => { console.error(error); process.exitCode = 1; });
