const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { packUv, templateRects } = require("../shared/model-uv.cjs");
const { createTexture } = require("../electron/domains/profiles/content-files.cjs");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "uv");
  await fs.mkdir(folder, { recursive: true });
  const bones = [{ name: "body", pivot: [0, 6, 0], cubes: [
    { origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0], mirror: true },
    { origin: [4, 4, -2], size: [4, 4, 4], uv: [0, 0] },
    { origin: [-8, 4, -2], size: [4, 4, 4], uv: { north: { uv: [6, 0], uv_size: [-6, 4], uv_rotation: 90 }, south: { uv: [0, 0], uv_size: [4, 4] } } },
  ] }];
  const geometry = { "minecraft:geometry": [{ description: { identifier: "geometry.uv", texture_width: 64, texture_height: 64 }, bones }] };
  const file = path.join(folder, "model.geo.json"), original = JSON.stringify(geometry); await fs.writeFile(file, original, "utf8");
  const oldTexture = await createTexture({ list: async () => ({ mods: [] }) }, { modelPath: file, name: "old", width: 64, height: 64 }, null, path.join(data, "model-studio"));
  const oldBytes = await fs.readFile(oldTexture.path);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  let page; const errors = [];
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    const open = async () => { await page.locator(".model-library-open").filter({ hasText: "geometry.uv" }).click(); await page.getByRole("button", { name: "old.png", exact: true }).waitFor(); };
    await open();
    const button = name => page.getByRole("button", { name, exact: true });
    const modal = () => page.getByRole("dialog");
    await button("body 立方体 1").click();
    await button("自动排列").click(); await page.getByLabel("UV 排列预览", { exact: true }).waitFor();
    await capture("pack-preview-dark");
    await modal().getByLabel("间距（像素）", { exact: true }).fill("16");
    await modal().getByRole("alert").filter({ hasText: "放不下" }).waitFor(); assert.equal(await button("应用排列").isDisabled(), true);
    await page.keyboard.press("Escape"); assert.equal(await page.getByLabel("U", { exact: true }).inputValue(), "0");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await button("自动排列").click(); await button("应用排列").click();
    const packed = packUv(bones, 64, 64, 1).bones;
    assert.equal(Number(await page.getByLabel("U", { exact: true }).inputValue()), packed[0].cubes[0].uv[0]);
    assert.equal(await fs.readFile(file, "utf8"), original, "排列只改草稿");
    await button("撤销").click(); assert.equal(await page.getByLabel("U", { exact: true }).inputValue(), "0");
    await button("重做").click();
    await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8"))["minecraft:geometry"][0].bones, packed);
    assert.equal(await fs.readFile(file + ".bak", "utf8"), original);
    console.log("PASS 排列预览、尺寸不足、取消、一次撤销/重做与真实模型保存");
    await button("模板").click(); await modal().getByLabel("模板名称", { exact: true }).fill("old");
    await button("生成模板").click(); await modal().getByRole("alert").filter({ hasText: "同名" }).waitFor();
    assert.deepEqual(await fs.readFile(oldTexture.path), oldBytes);
    await modal().getByLabel("模板名称", { exact: true }).fill("uv_template");
    const preview = await page.getByLabel("贴图模板预览", { exact: true }).evaluate(node => Array.from(node.getContext("2d").getImageData(0, 0, node.width, node.height).data));
    await capture("template-preview"); await button("生成模板").click(); await button("uv_template.png").waitFor();
    const pngFile = path.join(folder, "textures/uv_template.png"), bytes = await fs.readFile(pngFile), decoded = decodePng(bytes);
    assert.deepEqual(Array.from(decoded.pixels), preview, "预览和落盘 PNG 像素一致");
    assert.deepEqual(await fs.readFile(oldTexture.path), oldBytes); assert.ok(templateRects(packed, 64, 64).length > 0);
    await page.waitForFunction(() => document.querySelector('.model-texture-list .active')?.textContent === "uv_template.png");
    const output = artifactPath("outputs/uv.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output, "utf8")), imported = importProject(project);
    assert.deepEqual(decodePng(Buffer.from(project.textures[0].source.split(",")[1], "base64")).pixels, decoded.pixels);
    assert.deepEqual(imported.bones[0].cubes.map(cube => cube.uv), packed[0].cubes.map(cube => cube.uv));
    await capture("packed-model"); console.log("PASS 模板同名保护、像素预览一致、PNG 与 UV 工程导出");
    await button("绘制").click(); await page.getByLabel("画笔颜色", { exact: true }).fill("#cc3333");
    const canvas = page.locator(".model-paint canvas"), box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await button("模板").click(); await page.getByText("先保存或放弃当前绘制，再处理 UV 或模板", { exact: true }).waitFor();
    assert.equal(await modal().count(), 0); assert.deepEqual(await fs.readFile(pngFile), bytes);
    await page.locator(".model-brush").getByRole("button", { name: "放弃", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.model-brush button')].some(node => node.textContent.trim() === "放弃" && node.disabled));
    await button("编辑").click(); await button("退出编辑").click(); await open();
    await button("body 立方体 1").click(); assert.equal(Number(await page.getByLabel("U", { exact: true }).inputValue()), packed[0].cubes[0].uv[0]);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300);
    await button("自动排列").click(); await capture("pack-small-light");
    const fits = await modal().evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }); assert.equal(fits, true);
    await button("取消").click(); await capture("workspace-small-light");
    assert.deepEqual(errors, []); console.log("PASS 未保存绘制保护、重开 UV、小窗口和浅色主题"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
