const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

function png(pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13), raw = Buffer.alloc(16 * 65); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 16; y++) pixels.copy(raw, y * 65 + 1, y * 64, (y + 1) * 64);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "selection"), pngFile = path.join(folder, "textures/ink.png");
  await fs.mkdir(path.dirname(pngFile), { recursive: true });
  const source = Buffer.alloc(16 * 16 * 4, 255), rect = { x: 2, y: 3, w: 3, h: 2 };
  const swatches = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 0, 0], [0, 0, 255, 255], [255, 255, 0, 255], [255, 0, 255, 255]];
  for (let i = 0; i < 6; i++) source.set(swatches[i], ((3 + Math.floor(i / 3)) * 16 + 2 + i % 3) * 4);
  await fs.writeFile(pngFile, png(source));
  const geometryFile = path.join(folder, "model.geo.json"), geometry = JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.selection", texture_width: 16, texture_height: 16 }, bones: [{ name: "body", cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: Object.fromEntries(["east", "west", "north", "south", "up", "down"].map(name => [name, { uv: [0, 0], uv_size: [16, 16] }])) }] }] }] });
  await fs.writeFile(geometryFile, geometry, "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  let page; const errors = [];
  const capture = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(data, "base64"));
  };
  const expected = (operation, target = rect) => {
    const out = Buffer.from(source);
    if (operation !== "copy") for (let y = rect.y; y < rect.y + rect.h; y++) out.fill(0, (y * 16 + rect.x) * 4, (y * 16 + rect.x + rect.w) * 4);
    if (operation !== "delete") for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const nx = operation === "flipX" ? rect.w - 1 - x : operation === "rotate" ? rect.h - 1 - y : x;
      const ny = operation === "flipY" ? rect.h - 1 - y : operation === "rotate" ? x : y;
      out.set(swatches[y * rect.w + x], ((target.y + ny) * 16 + target.x + nx) * 4);
    }
    return out;
  };
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", e => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    const open = async () => { await page.locator(".model-library-open").filter({ hasText: "geometry.selection" }).click(); await page.getByRole("button", { name: "ink.png", exact: true }).waitFor(); await page.getByRole("button", { name: "绘制", exact: true }).click(); };
    await open();
    const brush = page.locator(".model-brush"), button = name => brush.getByRole("button", { name, exact: true }), canvas = page.getByLabel("贴图绘制画布", { exact: true });
    const point = async (x, y) => { const r = await canvas.boundingBox(), scale = Math.min(r.width, r.height) / 16; return { x: r.x + (r.width - 16 * scale) / 2 + (x + 0.5) * scale, y: r.y + (r.height - 16 * scale) / 2 + (y + 0.5) * scale }; };
    const drag = async (a, b, cancel) => {
      const p = await point(...a), q = await point(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 });
      if (cancel === "escape") await page.keyboard.press("Escape"); if (cancel === "pointer") await canvas.dispatchEvent("pointercancel");
      if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up();
    };
    const select = async (r = rect) => { await button("选区").click(); await page.keyboard.down("Shift"); await drag([r.x, r.y], [r.x + r.w - 1, r.y + r.h - 1]); await page.keyboard.up("Shift"); };
    const region = async r => assert.equal(await page.getByRole("status", { name: "选区范围" }).innerText(), `${r.x}, ${r.y} · ${r.w} × ${r.h} 像素`);
    const save = async () => {
      await button("保存贴图").click();
      await page.waitForFunction(() => { const buttons = [...document.querySelectorAll('.model-brush button')]; return buttons.some(n => n.textContent.trim() === "放弃" && n.disabled) && buttons.some(n => n.textContent.trim() === "保存贴图" && !n.disabled); });
      return decodePng(await fs.readFile(pngFile)).pixels;
    };
    const undo = async () => { await button("撤销").click(); assert.deepEqual(await save(), source); await region(rect); };
    await select(); await region(rect); assert.deepEqual(await save(), source);
    for (const [name, operation] of [["水平翻转", "flipX"], ["垂直翻转", "flipY"], ["旋转 90°", "rotate"], ["删除选区", "delete"]]) {
      await button(name).click(); assert.deepEqual(await save(), expected(operation), name + " 像素");
      await undo(); await button("重做").click(); assert.deepEqual(await save(), expected(operation)); await undo();
    }
    console.log("PASS 翻转/非方形旋转/删除透明像素、一次撤销重做与选区恢复");
    await drag([2, 3], [3, 3]); assert.deepEqual(await save(), expected("move", { ...rect, x: 3 })); await region({ ...rect, x: 3 }); await undo();
    for (const cancel of ["escape", "pointer", "blur"]) { await drag([2, 3], [8, 9], cancel); assert.deepEqual(await save(), source); await region(rect); }
    await drag([2, 3], [20, 4]); assert.deepEqual(await save(), expected("move", { ...rect, x: 13, y: 4 })); await undo();
    await canvas.focus(); await page.keyboard.press("Shift+ArrowRight"); assert.deepEqual(await save(), expected("move", { ...rect, x: 10 })); await undo();
    await canvas.focus(); await page.keyboard.press("Control+x"); assert.deepEqual(await save(), expected("delete")); await undo();
    await select({ x: 8, y: 8, w: 1, h: 1 }); await canvas.focus(); await page.keyboard.press("Control+v");
    assert.deepEqual(await save(), expected("copy", { ...rect, x: 8, y: 8 })); await region({ ...rect, x: 8, y: 8 });
    await button("撤销").click(); assert.deepEqual(await save(), source); await select();
    await button("复制选区").click(); await select({ x: 15, y: 15, w: 1, h: 1 }); await button("粘贴选区").click();
    await page.getByText("选区超出贴图范围", { exact: true }).waitFor(); assert.deepEqual(await save(), source);
    console.log("PASS 重叠移动、Esc/指针取消、键盘移动剪切粘贴与越界拒绝");
    await select({ x: 10, y: 10, w: 2, h: 3 }); await button("旋转 90°").click(); await region({ x: 10, y: 10, w: 3, h: 2 });
    await button("撤销").click(); assert.deepEqual(await save(), source); await region({ x: 10, y: 10, w: 2, h: 3 });
    await select(); await button("缩小一半").click(); await page.getByText("缩小需要偶数宽高", { exact: true }).waitFor(); assert.deepEqual(await save(), source);
    await select({ x: 2, y: 3, w: 2, h: 2 }); await button("放大两倍").click(); await region({ x: 2, y: 3, w: 4, h: 4 });
    const grown = await save(); assert.deepEqual([...grown.subarray((3 * 16 + 3) * 4, (3 * 16 + 3) * 4 + 4)], [255, 0, 0, 255]);
    await page.screenshot({ path: artifactPath("outputs/selection-scale-1440.png") });
    await button("缩小一半").click(); await region({ x: 2, y: 3, w: 2, h: 2 });
    await button("撤销").click(); await button("撤销").click(); assert.deepEqual(await save(), source);
    await select({ x: 14, y: 14, w: 2, h: 2 }); await button("放大两倍").click(); await page.getByText("选区超出贴图范围", { exact: true }).waitFor();
    assert.deepEqual(await save(), source);
    await select({ x: 10, y: 10, w: 3, h: 2 });
    await page.getByLabel("画笔颜色").fill("#ff0000");
    for (const tool of ["填充", "画笔", "橡皮", "矩形", "椭圆", "直线"]) {
      await button(tool).click(); await page.getByLabel("画笔大小").fill("16");
      await drag([10, 10], [14, 13]); const actual = await save();
      let changed = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        if (x >= 10 && x < 13 && y >= 10 && y < 12) { if (!actual.subarray(i, i + 4).equals(source.subarray(i, i + 4))) changed++; }
        else assert.deepEqual(actual.subarray(i, i + 4), source.subarray(i, i + 4), tool + " 不得越过选区");
      }
      assert.ok(changed > 0, tool + " 应在选区内绘制"); await button("撤销").click(); assert.deepEqual(await save(), source);
    }
    await button("选区").click(); await button("取消选区").click(); await button("立体").click();
    const stage = page.locator('.model-stage canvas');
    const solidDrag = async cancel => {
      const r = await stage.boundingBox();
      await page.mouse.move(r.x + r.width * 0.46, r.y + r.height * 0.46); await page.mouse.down();
      await page.mouse.move(r.x + r.width * 0.52, r.y + r.height * 0.52, { steps: 5 });
      if (cancel) await page.keyboard.press("Escape"); await page.mouse.up();
    };
    await solidDrag(false);
    const selected3d = await page.getByRole("status", { name: "选区范围" }).innerText(); assert.match(selected3d, /像素/);
    await solidDrag(true); assert.equal(await page.getByRole("status", { name: "选区范围" }).innerText(), selected3d);
    assert.deepEqual(await save(), source, "三维选区移动取消要恢复像素与选区");
    await button("立体").click(); await select(); await button("旋转 90°").click();
    const output = artifactPath("outputs/selection.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await page.getByRole("button", { name: "导出 .bbmodel", exact: true }).click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output, "utf8"));
    assert.deepEqual(decodePng(Buffer.from(project.textures[0].source.split(",")[1], "base64")).pixels, expected("rotate"));
    assert.deepEqual(decodePng(await fs.readFile(pngFile)).pixels, source, "未保存选区变换只进入工程导出");
    await capture("selection-dark"); assert.deepEqual(await save(), expected("rotate"));
    await page.getByRole("button", { name: "退出编辑", exact: true }).click(); await open(); assert.deepEqual(await save(), expected("rotate"));
    assert.equal(await fs.readFile(geometryFile, "utf8"), geometry);
    await select(); await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300);
    await button("旋转 90°").scrollIntoViewIfNeeded(); await capture("selection-small-light");
    assert.deepEqual(errors, []); console.log("PASS 绘制工具遵守选区、未保存变换导出、保存重开、模型不变和深浅/窄窗布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { const timer = setTimeout(() => app.process().kill(), 5000); try { await app.close(); } finally { clearTimeout(timer); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
