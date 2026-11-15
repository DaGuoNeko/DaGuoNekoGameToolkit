const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "controller-pan");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.animation_controllers.json");
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.controller_pan", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const id = "controller.animation.pan", names = Array.from({ length: 32 }, (_, i) => "state_" + i);
  const source = { keep: true, animation_controllers: { [id]: { states: Object.fromEntries(names.map((name, i) => [name, i === 0 ? { transitions: [{ state_1: 1 }] } : {}])) } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog");
  const graphButton = name => dialog().getByRole("button", { name, exact: true });
  const board = () => dialog().getByRole("region", { name: "状态连线画布" });
  const node = name => graphButton("状态节点 " + name);
  const port = name => graphButton("从 " + name + " 连接转移");
  const status = () => dialog().getByRole("status", { name: "关系图运行状态" });
  const position = () => board().evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop, outer: element.closest(".modal-body").scrollTop }));
  const center = async locator => { const r = await locator.boundingBox(); assert.ok(r); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const blank = (dx, dy) => board().evaluate((element, delta) => {
    const r = element.getBoundingClientRect(), c = element.closest(".modal-body").getBoundingClientRect();
    const left = Math.max(r.left + element.clientLeft, c.left), top = Math.max(r.top + element.clientTop, c.top);
    const right = Math.min(r.left + element.clientLeft + element.clientWidth, c.right), bottom = Math.min(r.top + element.clientTop + element.clientHeight, c.bottom);
    for (let y = Math.max(top + 12, top + 12 - delta.dy); y < Math.min(bottom - 12, bottom - 12 - delta.dy); y += 10) {
      for (let x = Math.max(left + 12, left + 12 - delta.dx); x < Math.min(right - 12, right - 12 - delta.dx); x += 10) {
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && !hit.closest("button,input,select,textarea,a")) return { x, y };
      }
    }
    throw Error("No visible blank drag origin");
  }, { dx, dy });
  const begin = async (dx, dy) => {
    const start = await blank(dx, dy); await page.mouse.move(start.x, start.y); await page.mouse.down();
    assert.equal(await board().getAttribute("data-panning"), "true");
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 }); return start;
  };
  const pan = async (dx, dy) => {
    const before = await position(), max = await board().evaluate(e => ({ x: e.scrollWidth - e.clientWidth, y: e.scrollHeight - e.clientHeight }));
    await begin(dx, dy); assert.equal(await graphButton("关闭").isDisabled(), true, JSON.stringify({ dx, dy, events: await page.evaluate(() => window.panEvents) })); await page.mouse.up();
    const after = await position(); assert.ok(Math.abs(after.x - Math.max(0, Math.min(max.x, before.x - dx))) < 2, JSON.stringify({ before, after, max, dx, dy }));
    assert.ok(Math.abs(after.y - Math.max(0, Math.min(max.y, before.y - dy))) < 2, JSON.stringify({ before, after, max, dx, dy })); assert.equal(after.outer, before.outer);
    assert.equal(await board().getAttribute("data-panning"), "false");
  };
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
    await page.locator(".model-library-open").filter({ hasText: "geometry.controller_pan" }).click(); await button("动画").click(); await button("状态关系图").click();
    await graphButton("运行到下一次转移").click(); await dialog().getByRole("status", { name: "运行到转移状态" }).filter({ hasText: "state_0 → state_1" }).waitFor();
    const playback = await status().innerText(), layout = await dialog().locator(".model-controller-graph-node").evaluateAll(nodes => nodes.map(node => node.getAttribute("style")));
    for (const [dx, dy] of [[-100, -80], [50, 40], [-50, 70]]) await pan(dx, dy);
    assert.equal(await status().innerText(), playback); assert.equal(await node("state_0").getAttribute("aria-pressed"), "true"); assert.equal(await dialog().locator(".model-controller-trace li").count(), 1);
    await graphButton("放大关系图").click(); await graphButton("放大关系图").click();
    await pan(-150, -90); await pan(100, 60);
    await begin(-30, -20); await node("state_0").dispatchEvent("lostpointercapture", { pointerId: 99 });
    assert.equal(await board().getAttribute("data-panning"), "true", "其他元素的捕获丢失不能取消当前平移");
    await board().dispatchEvent("lostpointercapture", { pointerId: 1 }); assert.equal(await board().getAttribute("data-panning"), "true", "仍持有捕获时忽略过期通知"); await page.mouse.up();
    for (const cancel of ["Escape", "blur", "pointercancel", "capture"]) {
      const before = await position(); await begin(-60, -50);
      if (cancel === "Escape") await page.keyboard.press("Escape");
      else if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      else if (cancel === "pointercancel") await board().dispatchEvent("pointercancel", { pointerId: 1 });
      else { await board().evaluate(element => element.releasePointerCapture(1)); await page.mouse.move(20, 20); }
      await page.mouse.up(); assert.deepEqual(await position(), before); assert.equal(await board().getAttribute("data-panning"), "false");
    }
    await board().evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
    const start = await begin(90, 70); assert.equal((await position()).x, 0); assert.equal((await position()).y, 0);
    await page.mouse.move(start.x + 70, start.y + 50, { steps: 2 }); await page.mouse.up();
    assert.ok(Math.abs((await position()).x - 20) < 2 && Math.abs((await position()).y - 20) < 2);
    await board().focus(); const keyboard = await position(); await page.keyboard.press("ArrowDown");
    await page.waitForFunction(y => document.querySelector(".model-controller-graph-scroll").scrollTop > y, keyboard.y);
    await page.waitForTimeout(180); const horizontal = await position(); await page.keyboard.press("ArrowRight");
    await page.waitForFunction(x => document.querySelector(".model-controller-graph-scroll").scrollLeft > x, horizontal.x);
    await page.waitForTimeout(180); assert.equal((await position()).outer, keyboard.outer);
    const right = await blank(0, 0); await page.mouse.move(right.x, right.y); await page.mouse.down({ button: "right" }); assert.equal(await board().getAttribute("data-panning"), "false"); await page.mouse.up({ button: "right" });
    const rect = await board().boundingBox(); await page.mouse.move(rect.x + rect.width - 3, rect.y + rect.height / 2); await page.mouse.down(); assert.equal(await board().getAttribute("data-panning"), "false"); await page.mouse.up();
    await graphButton("定位所选").click(); await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click(); await graphButton("缩小关系图").click();
    await page.evaluate(() => {
      window.panEvents = [];
      for (const type of ["pointerdown", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "blur", "resize"]) window.addEventListener(type, event => window.panEvents.push({ type, target: event.target.className, panning: document.querySelector(".model-controller-graph-scroll")?.dataset.panning }), true);
    });
    await pan(0, -100); await pan(0, 60);
    await graphButton("定位所选").click(); const header = node("state_0").locator(".model-controller-graph-node-head"); await header.scrollIntoViewIfNeeded();
    const head = await center(header), target = await center(node("state_1")); await page.mouse.move(head.x, head.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    await dialog().locator(".model-controller-arrange-ghost").waitFor(); assert.equal(await board().getAttribute("data-panning"), "false"); await page.keyboard.press("Escape"); await page.mouse.up();
    await port("state_0").scrollIntoViewIfNeeded(); const connector = await center(port("state_0")); await page.mouse.move(connector.x, connector.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    await dialog().locator(".model-controller-connect-line").waitFor(); assert.equal(await board().getAttribute("data-panning"), "false"); await page.keyboard.press("Escape"); await page.mouse.up();
    assert.deepEqual(await dialog().locator(".model-controller-graph-node").evaluateAll(nodes => nodes.map(node => node.getAttribute("style"))), layout);
    await graphButton("新增转移").click(); const blocked = await blank(0, -40), beforeDraftPan = await position();
    await page.mouse.move(blocked.x, blocked.y); await page.mouse.down(); await page.mouse.move(blocked.x, blocked.y - 40); await page.mouse.up(); assert.equal(await board().getAttribute("data-panning"), "false"); assert.deepEqual(await position(), beforeDraftPan);
    await graphButton("取消添加转移").click();
    await begin(0, -80); await capture("canvas-pan-dark"); await page.mouse.up();
    const beforeResize = await position(); await begin(0, -60);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.mouse.up();
    const resized = await position(); assert.equal(resized.x, beforeResize.x); assert.equal(resized.y, beforeResize.y);
    await graphButton("适应宽度").click(); await pan(0, -80); await board().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("canvas-pan-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await fs.readFile(file), original); await assert.rejects(fs.stat(file + ".bak"), { code: "ENOENT" });
    assert.equal(await status().innerText(), playback); assert.equal(await node("state_0").getAttribute("aria-pressed"), "true"); assert.equal(await errors.length, 0);
    await graphButton("关闭").click(); await button("状态关系图").click(); await board().waitFor(); assert.equal((await position()).x, 0);
    assert.equal(await graphButton("撤销控制器").isDisabled(), true);
    console.log("PASS 空白拖动平移/四向与缩放/边界反向、取消恢复/失焦/指针取消/丢失捕获/尺寸变化、键盘滚动/滚动条保留、换位与拖线互斥、播放/选择/文件不变及深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { if (app) { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } } }
})().catch(error => { console.error(error); process.exitCode = 1; });
