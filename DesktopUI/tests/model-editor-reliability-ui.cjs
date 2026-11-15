const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

function png(pattern) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), crc = Buffer.alloc(4);
    header.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([header, body, crc]);
  };
  const raw = Buffer.alloc(64 * 257), header = Buffer.alloc(13);
  header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const color = pattern && x < 16 && y < 16 ? [[204, 51, 51], [51, 170, 102], [51, 102, 204], [220, 180, 40]][(x >= 8 ? 1 : 0) + (y >= 8 ? 2 : 0)] : [255, 255, 255];
    raw.set([...color, 255], y * 257 + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const data = artifactPath("data"), models = path.join(data, "model-studio");
  const faceUV = Object.fromEntries(["south", "east", "north", "west", "up", "down"].map((name, i) => [name, { uv: [(i % 4) * 16, Math.floor(i / 4) * 16], uv_size: [16, 16] }]));
  const geo = { "minecraft:geometry": [{ description: { identifier: "geometry.reliability", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: faceUV }] }] }] };
  for (const name of ["uv", "paint"]) {
    const folder = path.join(models, name); await fs.mkdir(path.join(folder, "textures"), { recursive: true });
    const source = structuredClone(geo); source["minecraft:geometry"][0].description.identifier = "geometry." + name;
    await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify(source), "utf8");
    await fs.writeFile(path.join(folder, "textures", "texture.png"), png(name === "uv"));
  }
  const curveFile = path.join(models, "paint", "curve.animation.json");
  const linear = { "0.00": [0, 0, 0], "1.00": [0, 0, 0], "2.00": [10, 0, 0], "3.00": [0, 0, 0] };
  const animation = rotation => ({ loop: false, animation_length: 3, bones: { body: { rotation } } });
  await fs.writeFile(curveFile, JSON.stringify({ animations: {
    "animation.linear": animation(linear),
    "animation.smooth": animation({ ...linear, "2.00": { post: [10, 0, 0], lerp_mode: "catmullrom", extra: true } }),
    "animation.step": animation({ ...linear, "2.00": { pre: [0, 0, 0], post: [10, 0, 0] } }),
  } }), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  let page;
  const errors = [];
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    const open = async name => { await page.locator(".model-library-open").filter({ hasText: "geometry." + name }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor(); await page.getByRole("button", { name: "texture.png", exact: true }).waitFor(); };
    const saveModel = async () => { await page.getByRole("button", { name: "保存模型", exact: true }).click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); };
    await open("uv");
    const uvCanvas = page.locator(".model-uv canvas");
    const uvPoint = async (x, y) => { const box = await uvCanvas.boundingBox(); const scale = Math.min(box.width / 64, box.height / 33); return { x: box.x + (box.width - 64 * scale) / 2 + x * scale, y: box.y + (box.height - 33 * scale) / 2 + y * scale }; };
    await page.getByRole("button", { name: "body 立方体 1", exact: true }).click();
    const south = await uvPoint(8, 8); await page.mouse.click(south.x, south.y);
    await page.getByText("当前面：南", { exact: true }).waitFor();
    const before = await page.locator(".model-stage").screenshot();
    await page.getByRole("button", { name: "旋转这一面", exact: true }).click(); await saveModel();
    const readUv = async () => JSON.parse(await fs.readFile(path.join(models, "uv/model.geo.json"), "utf8"))["minecraft:geometry"][0].bones[0].cubes[0].uv;
    assert.deepEqual(await readUv(), { ...faceUV, south: { ...faceUV.south, uv_rotation: 90 } });
    const after = await page.locator(".model-stage").screenshot(); assert.notDeepEqual(after, before);
    await page.screenshot({ path: artifactPath("outputs/single-face-uv.png") });
    await page.getByRole("button", { name: "撤销", exact: true }).click(); await saveModel(); assert.deepEqual(await readUv(), faceUV);
    await page.getByRole("button", { name: "重做", exact: true }).click(); await saveModel(); assert.equal((await readUv()).south.uv_rotation, 90);
    await page.getByRole("button", { name: "退出编辑", exact: true }).click(); await open("uv");
    await page.getByRole("button", { name: "body 立方体 1", exact: true }).click();
    const east = await uvPoint(24, 8); await page.mouse.click(east.x, east.y);
    await page.getByText("当前面：东", { exact: true }).waitFor();
    await page.getByRole("button", { name: "缩小 UV", exact: true }).click(); await saveModel();
    assert.deepEqual((await readUv()).east, { uv: [20, 4], uv_size: [8, 8] }); assert.equal((await readUv()).south.uv_rotation, 90);
    console.log("PASS 单面 UV 保存、方向和重开");
    await page.getByRole("button", { name: "退出编辑", exact: true }).click(); await open("paint");
    await page.getByRole("button", { name: "绘制", exact: true }).click();
    const brush = page.locator(".model-brush"), tool = name => brush.getByRole("button", { name, exact: true });
    await tool("立体").click();
    const stage = page.locator(".model-stage canvas"); await stage.waitFor();
    await page.getByLabel("画笔大小").fill("1"); await page.getByLabel("画笔颜色").fill("#cc3333");
    const at = async (x = 0.48, y = 0.5) => { const box = await stage.boundingBox(); return { x: box.x + x * box.width, y: box.y + y * box.height }; };
    const stroke = async (name, x1 = 0.43, y1 = 0.45, x2 = 0.51, y2 = 0.55, cancel = false) => {
      await tool(name).click(); const a = await at(x1, y1), b = await at(x2, y2);
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
      if (cancel) await page.keyboard.press("Escape"); await page.mouse.up();
      console.log("绘制操作", name, cancel ? "取消" : "完成");
    };
    const pngFile = path.join(models, "paint/textures/texture.png");
    const savePaint = async () => { await tool("保存贴图").click(); await page.waitForFunction(() => { const buttons = [...document.querySelectorAll('.model-brush button')]; return buttons.some(b => b.textContent.trim() === "放弃" && b.disabled) && buttons.some(b => b.textContent.trim() === "保存贴图" && !b.disabled); }); return fs.readFile(pngFile); };
    const pixels = async () => { const bytes = await savePaint(); return decodePng(bytes).pixels; };
    await stroke("填充", 0.48, 0.5, 0.48, 0.5);
    let image = await pixels();
    assert.ok(image, "PNG 解码输出");
    for (let i = 0; i < image.length; i += 4) assert.deepEqual([...image.subarray(i, i + 4)], [204, 51, 51, 255], "填充不应成为单个笔点");
    const red = await fs.readFile(pngFile);
    await page.getByLabel("画笔颜色").fill("#0000ff"); await stroke("吸色", 0.48, 0.5, 0.48, 0.5);
    assert.equal(await page.getByLabel("画笔颜色").inputValue(), "#cc3333"); assert.deepEqual(await savePaint(), red);
    await stroke("选区"); assert.equal(await tool("复制选区").isEnabled(), true); assert.deepEqual(await savePaint(), red);
    await stroke("橡皮"); image = await pixels(); assert.ok(image.some((v, i) => i % 4 === 3 && v === 0));
    await tool("撤销").click(); await page.waitForFunction(() => [...document.querySelectorAll('.model-brush button')].some(b => b.textContent.trim() === "重做" && !b.disabled)); assert.deepEqual(await savePaint(), red);
    for (const name of ["画笔", "矩形", "椭圆", "直线"]) {
      await page.getByLabel("画笔颜色").fill("#3366cc"); await stroke(name);
      const changed = await savePaint(); assert.notDeepEqual(changed, red, name);
      await tool("撤销").click(); assert.deepEqual(await savePaint(), red, name + " 撤销");
      await stroke(name, 0.43, 0.45, 0.51, 0.55, true); assert.deepEqual(await savePaint(), red, name + " Esc 取消");
    }
    const a = await at(); await page.mouse.click(a.x, a.y, { button: "right" }); assert.deepEqual(await savePaint(), red);
    await page.screenshot({ path: artifactPath("outputs/solid-tools.png") });
    await page.getByRole("button", { name: "动画", exact: true }).click();
    await page.locator('.model-bone-list').getByRole("button", { name: "body", exact: true }).click();
    const curve = page.getByRole("img", { name: "曲线", exact: true });
    const sampleGraph = async (animation, time, expected) => {
      await page.getByRole("button", { name: animation, exact: true }).click(); await page.getByRole("tab", { name: "曲线", exact: true }).click(); await curve.waitFor();
      await page.waitForFunction(({ time, expected }) => {
        const node = document.querySelector('.model-curve');
        if (!node) return false;
        const points = node.querySelector('polyline').getAttribute('points').trim().split(/\s+/).map(p => p.split(',').map(Number));
        const box = node.viewBox.baseVal; const x = 6 + time / 3 * (box.width - 12);
        const closest = points.reduce((a, b) => Math.abs(a[0] - x) < Math.abs(b[0] - x) ? a : b);
        const value = Number(node.dataset.min) + (1 - (closest[1] - 10) / (box.height - 20)) * (Number(node.dataset.max) - Number(node.dataset.min));
        return Math.abs(value - expected) < 0.001;
      }, { time, expected });
      const point = await curve.evaluate((node, time) => {
        const points = node.querySelector('polyline').getAttribute('points').trim().split(/\s+/).map(p => p.split(',').map(Number));
        const box = node.viewBox.baseVal; const x = 6 + time / 3 * (box.width - 12);
        const closest = points.reduce((a, b) => Math.abs(a[0] - x) < Math.abs(b[0] - x) ? a : b);
        return Number(node.dataset.min) + (1 - (closest[1] - 10) / (box.height - 20)) * (Number(node.dataset.max) - Number(node.dataset.min));
      }, time);
      assert.ok(Math.abs(point - expected) < 0.001, animation + " 曲线值 " + point);
    };
    await sampleGraph("animation.linear", 1.5, 5);
    await sampleGraph("animation.smooth", 1.5, 5.625);
    await page.screenshot({ path: artifactPath("outputs/smooth-curve.png") });
    const frame = curve.getByRole("slider", { name: "曲线点 2", exact: true });
    await frame.focus(); await frame.press("ArrowUp"); await page.getByText("已改曲线", { exact: true }).waitFor();
    let saved = JSON.parse(await fs.readFile(curveFile, "utf8")); assert.equal(saved.animations["animation.smooth"].bones.body.rotation["2.00"].post[0], 11); assert.equal(saved.animations["animation.smooth"].bones.body.rotation["2.00"].extra, true);
    await page.locator('.model-timeline').getByRole("button", { name: "撤销", exact: true }).click(); await page.getByText("已撤销", { exact: true }).waitFor();
    await sampleGraph("animation.step", 1.5, 0);
    const jump = await curve.locator("polyline").getAttribute("points");
    const jumpPoints = jump.split(" ").map(p => p.split(",").map(Number));
    assert.ok(jumpPoints.some((p, i) => i > 0 && p[0] === jumpPoints[i - 1][0] && Math.abs(p[1] - jumpPoints[i - 1][1]) > 50));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800)); await page.screenshot({ path: artifactPath("outputs/step-curve-1180.png") });
    assert.deepEqual(errors, []);
    console.log("PASS 单面 UV 点击/方向/保存重开，三维各工具/撤销/取消/右键，真实插值曲线与关键帧保存"); console.log(artifactRoot);
  } catch (error) { console.error(error); if (page) await page.screenshot({ path: artifactPath("outputs/failure.png"), timeout: 5000 }).catch(() => {}); throw error; }
  finally {
    const stop = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } finally { clearTimeout(stop); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
