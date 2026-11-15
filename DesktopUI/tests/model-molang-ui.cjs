const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data");
  const modelDir = path.join(data, "model-studio", "molang");
  await fs.mkdir(modelDir, { recursive: true });
  await fs.writeFile(path.join(modelDir, "model.geo.json"), JSON.stringify({
    format_version: "1.12.0",
    "minecraft:geometry": [{ description: { identifier: "geometry.molang", texture_width: 64, texture_height: 64 }, bones: [
      { name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] },
      { name: "arm", parent: "body", pivot: [5, 10, 0], cubes: [{ origin: [4, 3, -2], size: [3, 7, 4], uv: [0, 0] }] },
    ] }],
  }), "utf8");
  const expression = "math.sin(query.anim_time * 360) * 30";
  const wave = {
    loop: true, animation_length: 2, override_previous_animation: true,
    sound_effects: { "0.5": { effect: "fixture" } },
    bones: { body: { rotation: [0, expression, 0] }, arm: { position: { "0.00": [0, 0, 0] } } },
  };
  const file = path.join(modelDir, "model.animation.json");
  const unsupported = { loop: false, animation_length: 2, bones: { body: { rotation: [0, "query.ground_speed", 0] } } };
  await fs.writeFile(file, JSON.stringify({ animations: { "animation.wave": wave, "animation.unsupported": unsupported } }, null, 2), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.join(__dirname, ".."), env,
    ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  let page;
  const errors = [];
  try {
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.molang" }).click();
    await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
    await page.getByRole("button", { name: "动画", exact: true }).click();
    await page.getByRole("button", { name: "animation.wave", exact: true }).click();
    await page.locator(".model-bone-list").getByRole("button", { name: "body", exact: true }).click();
    await page.getByRole("region", { name: "Molang 通道" }).waitFor();
    assert.ok((await page.locator(".model-molang pre").innerText()).includes(expression));
    assert.equal(await page.getByLabel("旋转Y", { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "记下旋转", exact: true }).isDisabled(), true);
    assert.equal(await page.locator(".model-curve").count(), 0);
    const time = page.getByRole("slider", { name: "时间", exact: true });
    await time.focus();
    await time.press("Home");
    const before = await page.locator(".model-stage").screenshot();
    for (let i = 0; i < 5; i++) await time.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转Y"]').value) === 30);
    const after = await page.locator(".model-stage").screenshot();
    assert.notDeepEqual(before, after, "视口应显示公式计算后的旋转");
    await page.screenshot({ path: artifactPath("outputs/molang-preview.png") });
    for (let i = 0; i < 10; i++) await time.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转Y"]').value) === -30);
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="时间"]').value) !== 0.75);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await time.press("Home");
    await page.locator(".model-bone-list").getByRole("button", { name: "arm", exact: true }).click();
    await page.getByRole("toolbar", { name: "动画通道" }).getByRole("button", { name: "位移", exact: true }).click();
    await page.getByLabel("位移X", { exact: true }).fill("2");
    await page.getByRole("button", { name: "记下位移", exact: true }).click();
    await page.getByText("已写入关键帧", { exact: true }).waitFor();
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.deepEqual(saved.animations["animation.wave"].bones.body, wave.bones.body);
    assert.deepEqual(saved.animations["animation.wave"].sound_effects, wave.sound_effects);
    assert.equal(saved.animations["animation.wave"].override_previous_animation, true);
    assert.deepEqual(saved.animations["animation.wave"].bones.arm.position["0.00"], [2, 0, 0]);
    assert.deepEqual(saved.animations["animation.unsupported"], unsupported);
    await page.getByRole("button", { name: "animation.unsupported", exact: true }).click();
    await page.getByRole("status", { name: "动画预览提示" }).waitFor();
    assert.ok((await page.getByRole("status", { name: "动画预览提示" }).innerText()).includes("query.ground_speed"));
    await page.locator(".model-bone-list").getByRole("button", { name: "body", exact: true }).click();
    await page.getByRole("toolbar", { name: "动画通道" }).getByRole("button", { name: "旋转", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
    await page.screenshot({ path: artifactPath("outputs/molang-unsupported-1180.png") });
    await page.getByRole("button", { name: "animation.wave", exact: true }).click();
    await page.getByRole("status", { name: "动画预览提示" }).waitFor({ state: "hidden" });
    await page.waitForFunction(expression => document.querySelector(".model-molang pre")?.textContent.includes(expression), expression);
    await time.press("Home");
    for (let i = 0; i < 5; i++) await time.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转Y"]').value) === 30);
    assert.deepEqual(errors, []);
    console.log("PASS Molang 时间采样、播放与视口、只读表达式、未知查询提示、真实 IPC 保存和重新打开");
    console.log(artifactRoot);
  } catch (error) {
    if (page) await page.screenshot({ path: artifactPath("outputs/failure.png") }).catch(() => {});
    throw error;
  } finally {
    const timer = setTimeout(() => app.process().kill(), 5000);
    try { await app.close(); } finally { clearTimeout(timer); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
