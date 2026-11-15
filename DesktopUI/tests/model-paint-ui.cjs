const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    cwd: path.join(__dirname, ".."),
    ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }),
    env,
  });
  let page;
  const errors = [];
  const capture = async name => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name), Buffer.from(png, "base64"));
  };
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.getByLabel("新模型标识符").fill("geometry.paintline");
    await page.getByRole("button", { name: "新建模型", exact: true }).click();
    await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
    await page.getByLabel("新贴图名").fill("ink");
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("button", { name: "ink.png", exact: true }).waitFor();
    await page.getByRole("button", { name: "绘制", exact: true }).click();
    const canvas = page.locator(".model-paint canvas");
    await canvas.waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector(".model-paint canvas");
      return node && node.getContext("2d").getImageData(node.width / 2, node.height / 2, 1, 1).data[3] === 255;
    });
    const brush = page.locator(".model-brush");
    const discard = brush.getByRole("button", { name: "放弃", exact: true });
    const position = async (x, y) => {
      const box = await canvas.boundingBox();
      const scale = Math.min(box.width / 64, box.height / 64);
      return { x: box.x + (box.width - 64 * scale) / 2 + (x + 0.5) * scale,
        y: box.y + (box.height - 64 * scale) / 2 + (y + 0.5) * scale };
    };
    const start = async (x, y) => {
      const point = await position(x, y);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
    };
    const move = async (x, y, steps = 1) => {
      const point = await position(x, y);
      await page.mouse.move(point.x, point.y, { steps });
    };
    const stroke = async (x1, y1, x2, y2, steps = 1) => {
      await start(x1, y1);
      await move(x2, y2, steps);
      await page.mouse.up();
    };
    const save = async () => {
      await brush.getByRole("button", { name: "保存贴图", exact: true }).click();
      await page.waitForFunction(() => { const buttons = [...document.querySelectorAll('.model-brush button')]; return buttons.some(button => button.textContent.trim() === "放弃" && button.disabled) && buttons.some(button => button.textContent.trim() === "保存贴图" && !button.disabled); });
    };
    const png = path.join(data, "model-studio", "paintline", "textures", "ink.png");
    const pixels = async points => {
      const bytes = await fs.readFile(png);
      return page.evaluate(async ({ src, points }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const node = document.createElement("canvas");
        node.width = image.width;
        node.height = image.height;
        const ctx = node.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
      }, { src: "data:image/png;base64," + bytes.toString("base64"), points });
    };
    const tool = name => brush.getByRole("button", { name, exact: true });
    await tool("直线").click();
    assert.equal(await brush.getByLabel("描边").count(), 0);
    await page.getByLabel("画笔颜色").fill("#cc3333");
    await stroke(8, 40, 40, 40, 12);
    await save();
    assert.deepEqual(await pixels([[8, 40], [24, 40], [40, 40], [24, 39]]),
      [[204, 51, 51, 255], [204, 51, 51, 255], [204, 51, 51, 255], [255, 255, 255, 255]]);
    await page.getByLabel("画笔颜色").fill("#3366cc");
    await stroke(48, 55, 48, 35);
    await save();
    const vertical = await pixels([[48, 35], [48, 45], [48, 55]]);
    assert.deepEqual(vertical[1], [51, 102, 204, 255]);
    assert.ok(vertical.every(pixel => pixel[2] > 180 && pixel[0] < 100 && pixel[3] === 255), "圆头允许边缘抗锯齿，中段保持原色");
    await tool("橡皮").click();
    await page.getByLabel("画笔大小").fill("16");
    await stroke(24, 51, 24, 51);
    await tool("直线").click();
    await page.getByLabel("画笔大小").fill("1");
    await page.getByLabel("画笔不透明度").fill("128");
    await stroke(18, 51, 30, 51, 20);
    await save();
    const alpha = await pixels([[19, 51], [24, 51], [29, 51], [24, 50]]);
    for (const pixel of alpha.slice(0, 3)) assert.equal(pixel[3], 128, "预览不应重复叠加透明度");
    assert.equal(alpha[3][3], 0);
    const beforeCancel = await fs.readFile(png);
    await start(35, 48);
    await move(43, 56, 4);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await discard.isDisabled(), true);
    await save();
    assert.deepEqual(await fs.readFile(png), beforeCancel, "Esc 应精确恢复拖动前 PNG");
    await start(35, 48);
    await move(43, 56);
    await canvas.dispatchEvent("pointercancel");
    await page.mouse.up();
    assert.equal(await discard.isDisabled(), true);
    await save();
    assert.deepEqual(await fs.readFile(png), beforeCancel, "指针取消应恢复预览");
    await page.getByLabel("画笔不透明度").fill("255");
    await page.getByLabel("画笔颜色").fill("#33aa66");
    await page.getByLabel("画笔大小").fill("3");
    await stroke(8, 60, 20, 60);
    await save();
    assert.deepEqual(await pixels([[14, 59], [14, 60], [14, 61]]), Array(3).fill([51, 170, 102, 255]));
    await page.getByLabel("画笔大小").fill("1");
    await stroke(55, 55, 55, 55);
    await stroke(50, 30, 60, 20, 6);
    await save();
    assert.ok((await pixels([[55, 55], [55, 25]])).every(pixel => pixel[1] > pixel[0]), "点击和反向斜线应留下颜色");
    // 矩形和椭圆共享预览路径，也应能取消且保留之前尚未保存的绘制。
    for (const name of ["矩形", "椭圆"]) {
      await tool(name).click();
      await brush.getByLabel("描边").check();
      const before = await fs.readFile(png);
      await start(33, 48);
      await move(42, 57, 4);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await save();
      assert.deepEqual(await fs.readFile(png), before);
    }
    await tool("直线").click();
    await stroke(33, 44, 42, 44);
    await start(33, 48);
    await move(42, 57);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await discard.isEnabled(), true, "取消应保留此前未保存状态");
    await save();
    await capture("line-1440.png");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
    const toolbar = brush.getByRole("toolbar", { name: "绘制工具" });
    await toolbar.getByRole("button", { name: "直线", exact: true }).waitFor();
    const bounds = await toolbar.boundingBox();
    for (const button of await toolbar.getByRole("button").all()) {
      const box = await button.boundingBox();
      assert.ok(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1);
      assert.ok(box.height < 40, "工具文字不应挤成竖排");
    }
    await capture("line-1180.png");
    assert.deepEqual(errors, []);
    console.log("PASS 直线横竖/反向/点击/粗细、半透明 PNG、Esc/指针取消、形状回归及两种窗口布局");
    console.log(artifactRoot);
  } catch (error) {
    if (page) await page.screenshot({ path: artifactPath("outputs/failure.png") }).catch(() => {});
    throw error;
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
