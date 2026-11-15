const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "shortest");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.shortest_ui", texture_width: 16, texture_height: 16 }, bones: [
    { name: "parent", pivot: [0, 0, 0], rotation: [20, 0, 0], cubes: [] },
    { name: "body", parent: "parent", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }, { origin: [2, 8, -1], size: [3, 2, 2], uv: [0, 0] }] },
  ] }] }));
  const clip = (rotation, position, scale) => ({ loop: true, animation_length: 0.1, bones: { body: { rotation: [0, 0, rotation], position: [position, 0, 0], scale: [scale, 1, 1] } } });
  const animations = { "animation.a": clip(160, 0, 1.1), "animation.extra": clip(20, 0, 1), "animation.b": clip(-170, 2, 1.3), "animation.reference": clip(0, 0, 1) };
  const animFile = path.join(folder, "model.animation.json"), file = path.join(folder, "model.animation_controllers.json"), id = "controller.animation.shortest";
  await fs.writeFile(animFile, JSON.stringify({ animations }));
  const source = { format_version: "1.10.0", keep: true, animation_controllers: { [id]: { initial_state: "a", states: {
    a: { animations: ["animation.a", { "animation.extra": 0.5 }], blend_transition: { "0": 1, "1": 0.8, "2": 0 }, transitions: [{ b: "q.anim_time >= 0.2" }], keep: "metadata" },
    b: { animations: ["animation.b"] }, reference: { animations: ["animation.reference"] },
  } } } };
  await fs.writeFile(file, JSON.stringify(source)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const toggle = () => page.getByRole("checkbox", { name: "最短旋转路径", exact: true });
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const progress = () => page.getByRole("status", { name: "状态过渡进度" });
  const select = async value => { await page.getByRole("combobox", { name: "控制器状态", exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const read = async () => JSON.parse(await fs.readFile(file));
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.shortest_ui" }).click(); await button("动画").click(); await toggle().waitFor();
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
    assert.equal(a.pixels.length, b.pixels.length);
    let count = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].some(k => Math.abs(a.pixels[i + k] - b.pixels[i + k]) > 12)) count++;
    return count;
  };
  const comparePose = async shortest => {
    const bytes = await fs.readFile(file);
    await button("播放控制器").click(); await progress().waitFor();
    await page.waitForFunction(() => {
      const text = document.querySelector('[aria-label="控制器播放状态"]')?.textContent || "";
      return text.startsWith("b ·") && Number(text.split(" · ").at(-1).split(" ")[0]) >= 0.8;
    });
    await button("暂停控制器").click();
    const paused = await status().innerText(), stopped = await progress().innerText(), time = Number(paused.split(" · ").at(-1).split(" ")[0]);
    const alpha = time <= 1 ? time * 0.2 : 0.2 + (time - 1) * 0.8;
    assert.ok(alpha > 0 && alpha < 1);
    const actual = await capture(shortest ? "shortest-middle" : "numeric-middle", true);
    if (shortest) await capture("shortest-dark");
    await page.waitForTimeout(200); assert.equal(await status().innerText(), paused); assert.equal(await progress().innerText(), stopped);
    await button("播放控制器").click(); await progress().waitFor({ state: "detached" }); await button("暂停控制器").click();
    animations["animation.reference"] = clip(shortest ? 170 + 20 * alpha : 170 - 340 * alpha, 2 * alpha, (1 + 0.3 * alpha) * (1 + 0.1 * (1 - alpha)));
    await fs.writeFile(animFile, JSON.stringify({ animations }));
    await select("reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    assert.ok(difference(actual, await capture(shortest ? "shortest-reference" : "numeric-reference", true)) < 600, "三维路径应与独立参考姿势一致");
    assert.deepEqual(await fs.readFile(file), bytes);
    await select("a · 初始"); return actual;
  };
  try {
    await launch(); assert.equal(await toggle().isChecked(), false);
    const longPath = await comparePose(false);
    await fs.mkdir(file + ".bak"); await toggle().click();
    await page.locator(".model-controller-editor > [role=alert]").filter({ hasText: "只能修改普通文件" }).waitFor();
    assert.equal(await toggle().isChecked(), false); assert.deepEqual(await fs.readFile(file), original);
    await fs.rmdir(file + ".bak"); await toggle().click();
    await page.getByText("已保存最短旋转路径设置", { exact: true }).waitFor();
    assert.equal(await toggle().isChecked(), true);
    assert.deepEqual(await fs.readFile(file + ".bak"), original);
    assert.equal((await read()).animation_controllers[id].states.a.blend_via_shortest_path, true);
    const shortPath = await comparePose(true); assert.ok(difference(longPath, shortPath) > 1000);
    const output = artifactPath("outputs/shortest.bbmodel");
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output)); assert.deepEqual(importProject(project).controllers, (await read()).animation_controllers);
    await close(); await launch(); assert.equal(await toggle().isChecked(), true);
    await page.getByLabel("状态过渡时长", { exact: true }).fill("4"); await button("保存过渡时长").click();
    await page.getByText("已保存状态过渡时长", { exact: true }).waitFor();
    assert.deepEqual((await read()).animation_controllers[id].states.a.blend_transition, { "0": 1, "2": 0.8, "4": 0 });
    assert.equal((await read()).animation_controllers[id].states.a.blend_via_shortest_path, true);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await toggle().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("shortest-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await toggle().click();
    await page.waitForFunction(() => { const t = document.querySelector('[aria-label="最短旋转路径"]'); return t && !t.checked && !t.disabled; });
    const cleared = (await read()).animation_controllers[id].states.a;
    assert.equal(cleared.blend_via_shortest_path, undefined); assert.equal(cleared.keep, "metadata");
    assert.deepEqual(cleared.blend_transition, { "0": 1, "2": 0.8, "4": 0 });
    assert.deepEqual(errors, []);
    console.log("PASS 最短路径开关/失败重试/备份、默认长路径与多动画曲线短路径三维像素参考、暂停续播/完成、工程往返/重启、时长缩放和深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
