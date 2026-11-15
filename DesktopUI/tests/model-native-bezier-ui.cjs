const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), input = artifactPath("fixtures/native.bbmodel"), output = artifactPath("outputs/native.bbmodel");
  const frame = (time, value) => ({ channel: "rotation", time, interpolation: "bezier", bezier_linked: false,
    bezier_left_time: [-1 / 3, -1 / 3, -1 / 3], bezier_right_time: [1 / 3, 1 / 3, 1 / 3],
    bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0], data_points: [{ x: value, y: 0, z: 0 }] });
  const first = frame(0, 0), last = frame(1, -80); last.bezier_left_value[0] = 80;
  const source = { meta: { format_version: "5.0", model_format: "bedrock", box_uv: true }, name: "native_curve", model_identifier: "native_curve", resolution: { width: 64, height: 64 },
    elements: [{ uuid: "cube", type: "cube", name: "body", from: [-4, 0, -2], to: [4, 12, 2], origin: [0, 6, 0], box_uv: true, uv_offset: [0, 0] }],
    groups: [{ uuid: "body", name: "body", origin: [0, 6, 0] }], outliner: [{ uuid: "body", children: ["cube"] }], textures: [],
    animations: [{ name: "animation.native", length: 1, loop: "once", animators: { body: { name: "body", type: "bone", keyframes: [first, last] } } }] };
  await fs.writeFile(input, JSON.stringify(source), "utf8");
  const broken = structuredClone(source); broken.animations[0].animators.body.keyframes[0].bezier_right_time = [0.1];
  const bad = artifactPath("fixtures/invalid.bbmodel"); await fs.writeFile(bad, JSON.stringify(broken), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.webContents.setBackgroundThrottling(false); w.show(); w.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await button("模组与资源").click(); await button("模型制作").click();
  };
  const close = async () => {
    if (!app) return; const current = app; app = null;
    const timer = setTimeout(() => current.process().kill(), 5000);
    try { await current.close(); } finally { clearTimeout(timer); }
  };
  const choose = (kind, file) => app.evaluate(({ dialog }, { kind, file }) => {
    if (kind === "open") dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    else dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, { kind, file });
  const openAnimation = async () => {
    await button("动画").click(); await button("animation.native").click();
    await page.locator(".model-bone-list").getByRole("button", { name: "body", exact: true }).click();
    await page.getByRole("tab", { name: "曲线", exact: true }).click();
  };
  const scrub = async at => {
    await page.getByRole("slider", { name: "时间", exact: true }).fill(String(at));
    await page.waitForFunction(expected => Math.abs(Number(document.querySelector('[aria-label="旋转X"]').value) - expected) < 0.001, Math.round(80 * at ** 3 * 1000) / 1000);
  };
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(image, "base64"));
  };
  const waitExport = () => page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "导出 .bbmodel" && !button.disabled));
  try {
    await launch(); await choose("open", bad); await button("导入 .bbmodel").click();
    await page.getByText(/贝塞尔.*控制柄/).waitFor();
    assert.equal(await page.locator(".model-library-open").count(), 0);
    await choose("open", input); await button("导入 .bbmodel").click();
    await page.getByRole("heading", { name: "大纲", exact: true }).waitFor(); await openAnimation();
    for (const at of [0.25, 0.5, 0.75, 1]) await scrub(at);
    await scrub(0.5); await capture("native-dark");
    await choose("save", output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const nativeFrames = project => Object.values(project.animations[0].animators)[0].keyframes;
    let saved = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(nativeFrames(saved).length, 2);
    for (let i = 0; i < 2; i++) for (const field of ["data_points", "bezier_left_time", "bezier_right_time", "bezier_left_value", "bezier_right_value", "bezier_linked"]) assert.deepEqual(nativeFrames(saved)[i][field], [first, last][i][field]);
    const folders = await fs.readdir(path.join(data, "model-studio"));
    const importedFolder = path.join(data, "model-studio", folders[0]), animationFile = path.join(importedFolder, "model.animation.json");
    const disk = JSON.parse(await fs.readFile(animationFile));
    assert.equal(disk.animations["animation.native"].dgn_native_bezier.length, 1);
    assert.equal(Object.keys(disk.animations["animation.native"].bones.body.rotation).length, 21);
    await close(); await launch();
    await page.locator(".model-library-open").filter({ hasText: "geometry.native_curve" }).click(); await openAnimation(); await scrub(0.5);
    await page.getByLabel("旋转X", { exact: true }).fill("25"); await button("记下旋转").click();
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转X"]').value) === 25);
    await choose("save", output); await button("导出 .bbmodel").click();
    await waitExport();
    saved = JSON.parse(await fs.readFile(output));
    assert.ok(nativeFrames(saved).every(frame => frame.interpolation === "linear"), "改过样本后不能用旧柄覆盖用户修改");
    assert.equal(nativeFrames(saved).find(frame => frame.time === 0.5).data_points[0].x, -25);
    await button("原生控制柄").click();
    await page.getByRole("dialog").getByRole("alert").filter({ hasText: "采样帧已修改" }).waitFor();
    assert.equal(await button("应用控制柄").isDisabled(), true);
    await button("取消").click();
    await page.locator(".model-timeline").getByRole("button", { name: "撤销", exact: true }).click(); await page.getByText("已撤销", { exact: true }).waitFor();
    await scrub(0.5); await button("导出 .bbmodel").click(); await waitExport();
    assert.equal(nativeFrames(JSON.parse(await fs.readFile(output))).length, 2);
    const beforeHandles = await fs.readFile(animationFile);
    const modal = () => page.getByRole("dialog");
    await button("原生控制柄").click();
    await modal().getByRole("heading", { name: "原生控制柄", exact: true }).waitFor();
    const handle = modal().getByRole("slider", { name: "原生出柄", exact: true });
    const originalControl = await handle.getAttribute("aria-valuetext");
    for (const cancel of ["escape", "pointer", "blur"]) {
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + 30, box.y - 20, { steps: 5 });
      if (cancel === "escape") await page.keyboard.press("Escape");
      if (cancel === "pointer") await handle.dispatchEvent("pointercancel");
      if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up();
      assert.equal(await handle.getAttribute("aria-valuetext"), originalControl);
      assert.deepEqual(await fs.readFile(animationFile), beforeHandles);
    }
    const dragBox = await handle.boundingBox();
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2); await page.mouse.down();
    await page.mouse.move(dragBox.x + 25, dragBox.y - 15, { steps: 5 }); await page.mouse.up();
    assert.notEqual(await handle.getAttribute("aria-valuetext"), originalControl);
    assert.deepEqual(await fs.readFile(animationFile), beforeHandles);
    await handle.focus(); await handle.press("ArrowUp");
    assert.notEqual(await handle.getAttribute("aria-valuetext"), originalControl);
    await button("取消").click(); assert.deepEqual(await fs.readFile(animationFile), beforeHandles);
    await button("原生控制柄").click();
    await modal().getByLabel("出柄时间偏移", { exact: true }).fill("-1");
    await modal().getByRole("alert").waitFor(); assert.equal(await button("应用控制柄").isDisabled(), true);
    await modal().getByLabel("出柄时间偏移", { exact: true }).fill(String(1 / 3));
    await modal().getByLabel("出柄数值偏移", { exact: true }).fill("20");
    await modal().getByLabel("出柄左右联动", { exact: true }).check();
    await modal().getByRole("combobox", { name: "控制柄轴", exact: true }).click();
    await page.getByRole("option", { name: "Y", exact: true }).click();
    await modal().getByLabel("出柄数值偏移", { exact: true }).fill("4");
    await capture("native-handles-dark");
    await fs.rename(animationFile + ".bak", artifactPath("outputs/previous-animation.bak"));
    await fs.mkdir(animationFile + ".bak");
    await button("应用控制柄").click(); await modal().getByRole("alert").waitFor();
    assert.deepEqual(await fs.readFile(animationFile), beforeHandles);
    assert.equal(await button("应用控制柄").isDisabled(), false);
    await fs.rmdir(animationFile + ".bak"); await button("应用控制柄").click();
    await page.getByText("已更新原生控制柄，可一次撤销", { exact: true }).waitFor();
    const edited = JSON.parse(await fs.readFile(animationFile)).animations["animation.native"];
    assert.deepEqual(edited.bones.body.rotation["0.50"], [17.5, 1.5, 0]);
    const linked = edited.dgn_native_bezier[0].frames[0];
    assert.equal(linked.bezier_linked, true);
    assert.deepEqual(linked.bezier_right_value, [-20, -4, 0]);
    assert.deepEqual(linked.bezier_left_value, [20, 4, 0]);
    assert.deepEqual(await fs.readFile(animationFile + ".bak"), beforeHandles);
    await page.getByRole("slider", { name: "时间", exact: true }).fill("0.5");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转X"]').value) === 17.5);
    await page.locator(".model-timeline").getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByText("已撤销", { exact: true }).waitFor(); await scrub(0.5);
    await page.locator(".model-timeline").getByRole("button", { name: "重做", exact: true }).click();
    await page.getByText("已重做", { exact: true }).waitFor();
    await button("导出 .bbmodel").click(); await waitExport();
    assert.deepEqual(nativeFrames(JSON.parse(await fs.readFile(output)))[0].bezier_right_value, [-20, -4, 0]);
    await close(); await launch();
    await page.locator(".model-library-open").filter({ hasText: "geometry.native_curve" }).click(); await openAnimation();
    await page.getByRole("slider", { name: "时间", exact: true }).fill("0.5");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转X"]').value) === 17.5);
    await button("原生控制柄").click();
    assert.equal(await modal().getByLabel("出柄数值偏移", { exact: true }).inputValue(), "20");
    assert.equal(await modal().getByLabel("出柄左右联动", { exact: true }).isChecked(), true);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await capture("native-handles-small-light");
    const fits = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
    assert.equal(fits, true);
    await button("取消").click(); await capture("native-small-light");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(JSON.parse(await fs.readFile(input)), source);
    assert.deepEqual(errors, []);
    console.log("PASS 原生柄导入/播放/导出、直接编辑 XYZ/左右联动、拖动与取消、失败重试/备份/撤销重做、重启恢复、旧样本保护和深浅窄窗");
    console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
