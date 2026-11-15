const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const { readLayerPng, writeLayerPng } = require("../electron/domains/profiles/texture-layers.cjs");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

function png(pixels) {
  const chunk = (name, data) => { const size = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name), data]), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([size, body, crc]); };
  const header = Buffer.alloc(13), raw = Buffer.alloc(16 * 65); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 16; y++) pixels.copy(raw, y * 65 + 1, y * 64, (y + 1) * 64);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const url = bytes => "data:image/png;base64," + bytes.toString("base64");
const modes = [["normal", "正常"], ["multiply", "正片叠底"], ["screen", "滤色"], ["overlay", "叠加"], ["darken", "变暗"], ["lighten", "变亮"], ["difference", "差值"], ["exclusion", "排除"]];
// 独立按 W3C source-over 混合公式计算期望值，容许 Canvas 8 位预乘量化误差。
function expected(base, top, mode, opacity) {
  const out = Buffer.alloc(base.length);
  for (let i = 0; i < out.length; i += 4) {
    const ab = base[i + 3] / 255, as = top[i + 3] / 255 * opacity, alpha = as + ab * (1 - as);
    out[i + 3] = Math.round(alpha * 255);
    for (let c = 0; c < 3; c++) {
      const b = base[i + c] / 255, s = top[i + c] / 255;
      const blend = { normal: () => s, multiply: () => b * s, screen: () => b + s - b * s, overlay: () => b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s), darken: () => Math.min(b, s), lighten: () => Math.max(b, s), difference: () => Math.abs(b - s), exclusion: () => b + s - 2 * b * s }[mode]();
      out[i + c] = alpha ? Math.round(((1 - as) * ab * b + as * (1 - ab) * s + as * ab * blend) / alpha * 255) : 0;
    }
  }
  return out;
}

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "blend"), file = path.join(folder, "model.geo.json"), texture = path.join(folder, "textures/ink.png");
  await fs.mkdir(path.dirname(texture), { recursive: true });
  const base = Buffer.alloc(16 * 16 * 4), top = Buffer.alloc(base.length);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    base.set([64 + x * 8, 192 - y * 8, 128, [0, 128, 255, 255][Math.floor(x / 4)]], i);
    top.set([192 - y * 8, 64 + x * 8, 64, [0, 128, 255, 255][Math.floor(y / 4)]], i);
  }
  const layer = (name, pixels) => ({ name, visible: true, locked: false, opacity: 100, source: url(png(pixels)) });
  const initial = { version: 1, active: 1, layers: [layer("底色", base), layer("混合层", top)] };
  await fs.writeFile(texture, writeLayerPng(url(png(expected(base, top, "normal", 1))), initial));
  const geo = JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.blend", texture_width: 16, texture_height: 16 }, bones: [{ name: "body", cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: Object.fromEntries(["east", "west", "north", "south", "up", "down"].map(name => [name, { uv: [0, 0], uv_size: [16, 16] }])) }] }] }] }); await fs.writeFile(file, geo);
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click(); await page.locator(".model-library-open").filter({ hasText: "geometry.blend" }).click(); await page.getByRole("button", { name: "ink.png", exact: true }).waitFor(); await page.getByRole("button", { name: "绘制", exact: true }).click(); await page.getByRole("combobox", { name: "图层混合模式", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(data, "base64")); };
  const near = (actual, wanted, label) => { assert.equal(actual.length, wanted.length); for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - wanted[i]) <= 3, label + " channel " + i + ": " + actual[i] + " vs " + wanted[i]); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), brush = () => page.locator(".model-brush");
    const save = async () => { await brush().getByRole("button", { name: "保存贴图", exact: true }).click(); await page.waitForFunction(() => { const buttons = [...document.querySelectorAll('.model-brush button')]; return buttons.some(b => b.textContent.trim() === "保存贴图" && !b.disabled) && buttons.some(b => b.textContent.trim() === "放弃" && b.disabled); }); return fs.readFile(texture); };
    const setMode = async name => { await page.getByRole("combobox", { name: "图层混合模式", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); };
    const opacity = async value => { await page.getByLabel("图层不透明度").fill(String(value)); await page.getByLabel("图层不透明度").press("Enter"); };
    assert.equal((await page.getByRole("combobox", { name: "图层混合模式", exact: true }).innerText()).trim(), "正常");
    for (const [mode, name] of modes) {
      await setMode(name);
      for (const alpha of [100, 50]) { await opacity(alpha); const bytes = await save(); near(decodePng(bytes).pixels, expected(base, top, mode, alpha / 100), name + " " + alpha); const document = readLayerPng(bytes).layers; assert.equal(document.layers[1].blendMode || "normal", mode); if (mode !== "normal") assert.equal(document.version, 2); }
    }
    console.log("PASS 八种模式与全/半透明逐像素公式核对、旧格式默认正常、新格式持久化");
    await setMode("正片叠底"); const multiplied = await save(); await setMode("滤色"); const screened = await save();
    await brush().getByRole("button", { name: "撤销", exact: true }).click(); assert.deepEqual(decodePng(await save()).pixels, decodePng(multiplied).pixels);
    await brush().getByRole("button", { name: "重做", exact: true }).click(); assert.deepEqual(decodePng(await save()).pixels, decodePng(screened).pixels);
    await button("隐藏图层 混合层").click(); near(decodePng(await save()).pixels, expected(base, top, "normal", 0), "隐藏"); await button("显示图层 混合层").click();
    await button("复制图层").click(); assert.equal((await page.getByRole("combobox", { name: "图层混合模式", exact: true }).innerText()).trim(), "滤色");
    const beforeReject = await save(); await button("向下合并").click(); await page.getByText(/混合依赖更下方图层/).waitFor(); assert.equal(await page.locator('.model-layer-row').count(), 3); assert.deepEqual(await fs.readFile(texture), beforeReject);
    await button("删除图层").click(); const beforeMerge = await save(); await button("向下合并").click(); assert.equal(await page.locator('.model-layer-row').count(), 1); near(decodePng(await save()).pixels, decodePng(beforeMerge).pixels, "底部合并");
    await brush().getByRole("button", { name: "撤销", exact: true }).click(); await save(); assert.equal(await page.locator('.model-layer-row').count(), 2);
    await button("立体").click(); await capture("blend-dark");
    const output = artifactPath("outputs/blend.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await setMode("差值"); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor(); const project = JSON.parse(await fs.readFile(output, "utf8")); near(decodePng(Buffer.from(project.textures[0].source.slice(22), "base64")).pixels, expected(base, top, "difference", 0.5), "未保存导出");
    await save(); await close(); await launch(); assert.equal((await page.getByRole("combobox", { name: "图层混合模式", exact: true }).innerText()).trim(), "差值"); near(decodePng(await save()).pixels, expected(base, top, "difference", 0.5), "重启");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await page.getByRole("combobox", { name: "图层混合模式", exact: true }).scrollIntoViewIfNeeded(); await capture("blend-small-light");
    assert.equal(await fs.readFile(file, "utf8"), geo); assert.deepEqual(errors, []); console.log("PASS 撤销/重做、隐藏/复制、合并变色保护、三维预览、未保存导出和重启恢复"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
