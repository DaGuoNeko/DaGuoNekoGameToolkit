const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "finished");
  await fs.mkdir(folder, { recursive: true });
  const geometryFile = path.join(folder, "model.geo.json"), animFile = path.join(folder, "model.animation.json"), file = path.join(folder, "model.animation_controllers.json");
  await fs.writeFile(geometryFile, JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.finished_ui", texture_width: 16, texture_height: 16 }, bones: [
    { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-2, 0, -1], size: [4, 12, 2], uv: [0, 0] }] },
  ] }] }));
  const clip = (rotation, length, loop = false) => ({ animation_length: length, loop, bones: { body: { rotation: [0, 0, rotation] } } });
  const animations = { "animation.short": clip(0, 0.5, true), "animation.long": clip(50, 2, "hold_on_last_frame"), "animation.done": clip(75, 1.4),
    "animation.expression": clip("q.all_animations_finished ? 80 : 0", 0.5, true), "animation.reference": clip(40, 1),
    "animation.inferred": { loop: false, bones: { body: { rotation: { "0": [0, 0, 0], "0.75": [0, 0, 60] } } } } };
  await fs.writeFile(animFile, JSON.stringify({ animations })); const originalAnimations = await fs.readFile(animFile);
  const id = "controller.animation.finished";
  const doc = { keep: true, animation_controllers: { [id]: { initial_state: "start", states: {
    start: { animations: ["animation.short", { "animation.long": 0 }], blend_transition: 0.5, keep: "unknown" },
    done: { animations: ["animation.done"] }, end: { animations: [] },
    expression: { animations: [{ "animation.expression": "q.any_animation_finished ? 0.5 : 1" }] },
    reference: { animations: ["animation.reference"] }, inferred: { animations: ["animation.inferred"] },
  } } } };
  await fs.writeFile(file, JSON.stringify(doc)); const original = await fs.readFile(file);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const status = () => page.getByRole("status", { name: "控制器播放状态" });
  const finished = () => page.getByRole("status", { name: "动画完成状态" });
  const select = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await button("模组与资源").click(); await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.finished_ui" }).click(); await button("动画").click(); await button("播放控制器").waitFor();
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
  try {
    await launch();
    assert.equal(await page.getByRole("checkbox", { name: "启用模拟查询", exact: true }).isChecked(), false);
    await button("播放控制器").click(); await finished().filter({ hasText: "0/2 · 任一：否 · 全部：否" }).waitFor();
    await finished().filter({ hasText: "1/2 · 任一：是 · 全部：否" }).waitFor(); await button("暂停控制器").click();
    const frozen = await finished().innerText(), frozenTime = await status().innerText();
    await page.waitForTimeout(400); assert.equal(await finished().innerText(), frozen); assert.equal(await status().innerText(), frozenTime);
    await capture("finished-partial-dark");
    await button("播放控制器").click(); await finished().filter({ hasText: "2/2 · 任一：是 · 全部：是" }).waitFor(); await button("暂停控制器").click();
    assert.deepEqual(await fs.readFile(file), original);
    await button("重置控制器").click(); await finished().waitFor({ state: "detached" });
    await select("控制器状态", "inferred"); await button("播放控制器").click();
    await finished().filter({ hasText: "0/1 · 任一：否" }).waitFor();
    await finished().filter({ hasText: "1/1 · 任一：是 · 全部：是" }).waitFor(); await button("暂停控制器").click();
    assert.ok(Number((await status().innerText()).split(" · ").at(-1).split(" ")[0]) >= 0.75);
    await select("控制器状态", "reference"); await button("播放控制器").click(); await button("暂停控制器").click();
    const reference = await capture("finished-reference", true);
    await select("控制器状态", "expression"); await button("播放控制器").click();
    await finished().filter({ hasText: "1/1 · 任一：是 · 全部：是" }).waitFor(); await button("暂停控制器").click();
    assert.ok(difference(await capture("finished-expression", true), reference) < 150, "完成条件须同步驱动权重与骨骼表达式");
    await select("控制器状态", "start · 初始"); await select("转移目标", "done");
    await select("转移条件预设", "全部动画播完一轮");
    assert.equal(await page.getByLabel("转移条件", { exact: true }).inputValue(), "query.all_animations_finished");
    await button("添加转移").click(); await page.getByText("已添加转移", { exact: true }).waitFor();
    await select("控制器状态", "done"); await select("转移目标", "end"); await select("转移条件预设", "任一动画播完一轮");
    assert.equal(await page.getByLabel("转移条件", { exact: true }).inputValue(), "query.any_animation_finished");
    await button("添加转移").click();
    await page.waitForFunction(() => document.body.textContent.includes("end：query.any_animation_finished"));
    const saved = await fs.readFile(file);
    await select("控制器状态", "start · 初始"); await button("播放控制器").click();
    await status().filter({ hasText: "done · animation.done" }).waitFor(); await button("暂停控制器").click();
    await finished().filter({ hasText: "0/1 · 任一：否 · 全部：否" }).waitFor();
    await page.getByRole("status", { name: "状态过渡进度" }).waitFor();
    await button("播放控制器").click(); await status().filter({ hasText: "end · 静止姿势" }).waitFor(); await button("暂停控制器").click();
    assert.equal(await finished().innerText(), "已播过一轮：0/0 · 任一：否 · 全部：是");
    assert.deepEqual(await fs.readFile(file), saved);
    const output = artifactPath("outputs/finished.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const p = JSON.parse(await fs.readFile(output)); assert.deepEqual(importProject(p).controllers, JSON.parse(saved).animation_controllers);
    await close(); await launch();
    await button("播放控制器").click(); await status().filter({ hasText: "done · animation.done" }).waitFor(); await button("暂停控制器").click();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await finished().scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await capture("finished-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await fs.readFile(animFile), originalAnimations);
    assert.equal(JSON.parse(await fs.readFile(file)).animation_controllers[id].states.start.keep, "unknown");
    assert.deepEqual(errors, []);
    console.log("PASS 完成计数/循环首轮/零权重/推导时长、暂停续播与重置、权重和骨骼完成表达式像素参考、完成条件预设与连续转移、过渡状态隔离、工程往返/重启/深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
