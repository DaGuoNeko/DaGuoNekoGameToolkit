const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { readLayerPng } = require("../electron/domains/profiles/texture-layers.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

function png(pixels) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13), raw = Buffer.alloc(16 * 65);
  header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 16; y++) pixels.copy(raw, y * 65 + 1, y * 64, (y + 1) * 64);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const put = (data, x, y, color) => data.set(color, (y * 16 + x) * 4);
const pixel = (data, x, y) => data.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4);
function expected(base, points, rect, operation, target = rect) {
  const data = Buffer.from(base), moved = [];
  if (operation !== "copy") for (const [x, y] of points) put(data, x, y, [0, 0, 0, 0]);
  for (const [x, y] of points) {
    let dx = x - rect.x, dy = y - rect.y;
    if (operation === "half" && (dx % 2 || dy % 2)) continue;
    if (operation === "flipX") dx = rect.w - 1 - dx;
    if (operation === "flipY") dy = rect.h - 1 - dy;
    if (operation === "rotate") [dx, dy] = [rect.h - 1 - dy, dx];
    if (operation === "half") { dx /= 2; dy /= 2; }
    const scale = operation === "grow" ? 2 : 1;
    for (let oy = 0; oy < scale; oy++) for (let ox = 0; ox < scale; ox++) {
      const tx = target.x + dx * scale + ox, ty = target.y + dy * scale + oy;
      put(data, tx, ty, pixel(base, x, y)); moved.push([tx, ty]);
    }
  }
  return { data, points: moved };
}

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "irregular"), texture = path.join(folder, "textures/ink.png");
  await fs.mkdir(path.dirname(texture), { recursive: true });
  const source = Buffer.alloc(16 * 16 * 4), red = [255, 0, 0, 255];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(source, x, y, [0, 255, 255, 255]);
  const points = [[2, 3], [3, 3], [4, 3], [5, 3], [2, 4]], rect = { x: 2, y: 3, w: 4, h: 2 };
  points.forEach(([x, y]) => put(source, x, y, red));
  const lassoPoints = [];
  for (let y = 3; y < 7; y++) for (let x = 8; x < 12; x++) if (y < 5 || x >= 10) { lassoPoints.push([x, y]); put(source, x, y, [0, 0, 255, 128]); }
  put(source, 8, 3, [0, 0, 0, 0]);
  await fs.writeFile(texture, png(source));
  const geometryFile = path.join(folder, "model.geo.json");
  const geometry = JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.irregular", texture_width: 16, texture_height: 16 }, bones: [{ name: "body", cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: Object.fromEntries(["east", "west", "north", "south", "up", "down"].map(name => [name, { uv: [0, 0], uv_size: [16, 16] }])) }] }] }] });
  await fs.writeFile(geometryFile, geometry, "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.irregular" }).click();
    await page.getByRole("button", { name: "ink.png", exact: true }).waitFor(); await page.getByRole("button", { name: "绘制", exact: true }).click();
    await page.getByRole("button", { name: "保存贴图", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const button = name => page.locator(".model-brush").getByRole("button", { name, exact: true });
  const canvas = () => page.getByLabel("贴图绘制画布", { exact: true });
  const at = async (x, y) => { const box = await canvas().boundingBox(), scale = Math.min(box.width, box.height) / 16; return { x: box.x + (box.width - 16 * scale) / 2 + (x + 0.5) * scale, y: box.y + (box.height - 16 * scale) / 2 + (y + 0.5) * scale }; };
  const click = async (x, y) => { const p = await at(x, y); await page.mouse.click(p.x, p.y); };
  const stroke = async (coords, cancel) => {
    const start = await at(...coords[0]); await page.mouse.move(start.x, start.y); await page.mouse.down();
    for (const xy of coords.slice(1)) { const p = await at(...xy); await page.mouse.move(p.x, p.y, { steps: 1 }); }
    if (cancel) await page.keyboard.press("Escape"); await page.mouse.up();
  };
  const region = async value => assert.equal(await page.getByRole("status", { name: "选区范围" }).innerText(), value);
  const save = async () => {
    await button("保存贴图").click();
    await page.waitForFunction(() => { const nodes = [...document.querySelectorAll(".model-brush button")]; return nodes.some(n => n.textContent.trim() === "保存贴图" && !n.disabled) && nodes.some(n => n.textContent.trim() === "放弃" && n.disabled); });
    return decodePng(await fs.readFile(texture)).pixels;
  };
  const undo = async target => { await button("撤销").click(); assert.deepEqual(await save(), target); };
  const capture = async name => {
    await page.waitForTimeout(350);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  const clearSelection = async () => { const cancel = button("取消选区"); if (await cancel.count() && await cancel.isEnabled()) await cancel.click(); };
  const wand = async () => { await clearSelection(); await button("魔棒").click(); await click(2, 3); await region("2, 3 · 4 × 2 像素"); };
  const outline = [[8, 3], [12, 3], [12, 7], [10, 7], [10, 5], [8, 5], [8, 3]];
  const lasso = async () => { await clearSelection(); await button("套索").click(); await stroke(outline); await region("8, 3 · 5 × 5 像素"); };
  try {
    await launch(); await wand();
    for (const [label, operation, range] of [["水平翻转", "flipX", "4 × 2"], ["垂直翻转", "flipY", "4 × 2"], ["旋转 90°", "rotate", "2 × 4"], ["放大两倍", "grow", "8 × 4"], ["缩小一半", "half", "2 × 1"]]) {
      await button(label).click(); const result = expected(source, points, rect, operation);
      assert.deepEqual(await save(), result.data, label + "逐像素结果"); await region("2, 3 · " + range + " 像素");
      await undo(source); await region("2, 3 · 4 × 2 像素");
      await button("重做").click(); assert.deepEqual(await save(), result.data); await undo(source);
    }
    await button("放大两倍").click(); const grown = expected(source, points, rect, "grow"); assert.deepEqual(await save(), grown.data);
    await capture("wand-grown-dark");
    await button("缩小一半").click(); assert.deepEqual(await save(), expected(grown.data, grown.points, { ...rect, w: 8, h: 4 }, "half").data);
    await undo(grown.data); await undo(source);
    console.log("PASS 魔棒非矩形翻转、90度旋转、放大/缩小、孔洞背景、像素与选区撤销重做");

    await button("水平翻转").click(); const flipped = expected(source, points, rect, "flipX"); assert.deepEqual(await save(), flipped.data);
    await button("选区").click();
    await stroke([[5, 3], [7, 5]], true); assert.deepEqual(await save(), flipped.data); await region("2, 3 · 4 × 2 像素");
    await canvas().focus(); await page.keyboard.press("ArrowRight");
    const shifted = expected(flipped.data, flipped.points, rect, "move", { ...rect, x: 3 });
    assert.deepEqual(await save(), shifted.data); await undo(flipped.data);
    await button("复制选区").click(); await button("取消选区").click(); await stroke([[9, 9], [9, 9]]);
    await button("粘贴选区").click(); assert.deepEqual(await save(), expected(flipped.data, flipped.points, rect, "copy", { x: 9, y: 9 }).data);
    await undo(flipped.data); await undo(source); await wand();
    const lockedBefore = await fs.readFile(texture);
    await page.getByRole("button", { name: "锁定图层 背景", exact: true }).click();
    await wand();
    await button("旋转 90°").click(); await page.getByText("当前图层已锁定或隐藏，请先解锁或显示", { exact: true }).waitFor();
    assert.deepEqual(decodePng(await fs.readFile(texture)).pixels, decodePng(lockedBefore).pixels);
    await page.getByRole("button", { name: "解锁图层 背景", exact: true }).click(); assert.deepEqual(await save(), source); await wand();
    console.log("PASS 变换后移动、Esc取消、复制粘贴保留孔洞和锁定图层保护");

    await button("水平翻转").click(); assert.deepEqual(await save(), flipped.data);
    await page.getByLabel("画笔颜色").fill("#ff00ff"); await page.getByLabel("画笔大小").fill("8");
    for (const tool of ["矩形", "椭圆", "直线", "画笔"]) {
      await button(tool).click(); await stroke([[2, 3], [6, 5]]);
      const painted = await save(), selected = new Set(flipped.points.map(([x, y]) => x + "," + y));
      let changes = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        if (!selected.has(x + "," + y)) assert.deepEqual(pixel(painted, x, y), pixel(flipped.data, x, y), tool + "不得画进孔洞");
        else if (!pixel(painted, x, y).equals(pixel(flipped.data, x, y))) changes++;
      }
      assert.ok(changes > 0); await undo(flipped.data);
    }
    await button("选区").click(); await undo(source);
    await lasso(); await button("旋转 90°").click();
    const lassoRect = { x: 8, y: 3, w: 5, h: 5 }, rotated = expected(source, lassoPoints, lassoRect, "rotate");
    assert.deepEqual(await save(), rotated.data); assert.deepEqual([...pixel(rotated.data, 12, 3)], [0, 0, 0, 0]);
    await capture("lasso-rotated-dark"); await undo(source);
    await button("自定义旋转").click(); const rotation = page.locator("dialog[open]");
    await rotation.getByLabel("选区旋转角度").fill("45");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const previewRotated = await rotation.getByLabel("选区旋转预览").evaluate(node => node.toDataURL("image/png"));
    await rotation.getByRole("button", { name: "应用旋转", exact: true }).click();
    assert.deepEqual(await save(), decodePng(Buffer.from(previewRotated.split(",")[1], "base64")).pixels);
    await region("8, 3 · 8 × 8 像素"); await undo(source);
    await button("自定义缩放").click(); const scaleDialog = page.locator("dialog[open]");
    await scaleDialog.getByLabel("锁定原比例").uncheck();
    await scaleDialog.getByLabel("选区宽度", { exact: true }).fill("7");
    await scaleDialog.getByLabel("选区高度", { exact: true }).fill("4");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const previewScaled = await scaleDialog.getByLabel("选区缩放预览").evaluate(node => node.toDataURL("image/png"));
    await capture("lasso-scale-preview");
    await scaleDialog.getByRole("button", { name: "应用缩放", exact: true }).click();
    assert.deepEqual(await save(), decodePng(Buffer.from(previewScaled.split(",")[1], "base64")).pixels);
    await region("8, 3 · 7 × 4 像素"); await undo(source);
    await button("缩小一半").click(); await page.getByText("缩小需要偶数宽高", { exact: true }).waitFor(); assert.deepEqual(await save(), source);
    await button("放大两倍").click(); await page.getByText("选区超出贴图范围", { exact: true }).waitFor(); assert.deepEqual(await save(), source);
    await button("立体").click(); await button("水平翻转").click();
    const mirrored = expected(source, lassoPoints, lassoRect, "flipX"); assert.deepEqual(await save(), mirrored.data);
    await capture("lasso-solid-preview"); await undo(source); await button("立体").click();
    console.log("PASS 变换后形状绘制不越过孔洞、套索透明/半透明像素、奇数/越界拒绝和立体预览");

    // 全透明选区仅改变形状，也应留下可撤销的选区记录。
    await button("取消选区").click(); await button("选区").click(); await stroke([[1, 10], [4, 13]]); await button("删除选区").click();
    const cleared = await save(); await button("套索").click(); await stroke([[1, 10], [4, 10], [1, 13], [1, 10]]);
    await button("水平翻转").click(); assert.deepEqual(await save(), cleared, "全透明区域翻转只改变选区形状");
    await undo(cleared); await button("重做").click(); assert.deepEqual(await save(), cleared); await undo(cleared);
    await button("矩形").click(); await stroke([[1, 10], [4, 13]]);
    const repainted = await save(), triangle = new Set(["1,10", "2,10", "1,11"]);
    for (let y = 10; y <= 13; y++) for (let x = 1; x <= 4; x++) {
      assert.deepEqual([...pixel(repainted, x, y)], triangle.has(x + "," + y) ? [255, 0, 255, 255] : [0, 0, 0, 0], "撤销应恢复透明区域的选区形状");
    }
    await undo(cleared); await undo(source); await button("套索").click();

    await lasso(); await button("旋转 90°").click();
    const output = artifactPath("outputs/irregular.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await page.getByRole("button", { name: "导出 .bbmodel", exact: true }).click(); await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(output, "utf8"));
    assert.deepEqual(decodePng(Buffer.from(project.textures[0].source.split(",")[1], "base64")).pixels, rotated.data);
    assert.deepEqual(decodePng(await fs.readFile(texture)).pixels, source);
    await fs.unlink(texture + ".bak"); await fs.mkdir(texture + ".bak");
    await button("保存贴图").click(); await page.getByText("所选路径是链接或类型发生变化，请重新选择", { exact: true }).waitFor();
    assert.deepEqual(decodePng(await fs.readFile(texture)).pixels, source); await fs.rmdir(texture + ".bak");
    assert.deepEqual(await save(), rotated.data);
    assert.deepEqual(decodePng(await fs.readFile(texture + ".bak")).pixels, source);
    assert.equal(readLayerPng(await fs.readFile(texture)).layers.layers.length, 1);
    await close(); await launch(); assert.deepEqual(await save(), rotated.data); assert.equal(await fs.readFile(geometryFile, "utf8"), geometry);
    await wand();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await button("旋转 90°").scrollIntoViewIfNeeded(); await capture("irregular-small-light");
    assert.equal(await page.locator(".model-selection-actions button").evaluateAll(nodes => nodes.every(node => { const a = node.getBoundingClientRect(), b = node.closest(".model-brush").getBoundingClientRect(); return a.width >= 60 && a.left >= b.left && a.right <= b.right; })), true);
    assert.deepEqual(errors, []);
    await fs.writeFile(artifactPath("outputs/result.json"), JSON.stringify({ passed: true, errors }, null, 2), "utf8");
    console.log("PASS 未保存导出、写入失败重试、备份、重启、模型不变和深浅窄窗布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
