const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactPath } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "sound");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.sound", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }] }] }), "utf8");
  const source = { loop: false, animation_length: 2, sound_effects: { "0.00": { effect: "random.click" } }, bones: { body: { rotation: { "0.00": [0, 0, 0] } } } };
  const file = path.join(folder, "model.animation.json");
  await fs.writeFile(file, JSON.stringify({ animations: { "animation.sound": source } }, null, 2), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  const errors = [];
  const read = async () => JSON.parse(await fs.readFile(file, "utf8")).animations["animation.sound"];
  const until = async (check) => {
    const start = Date.now();
    let last;
    while (Date.now() - start < 8000) {
      last = await read();
      if (check(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("动画没有变成预期结果: " + JSON.stringify(last && last.sound_effects));
  };
  let page;
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.sound" }).click();
    await page.getByRole("button", { name: "动画", exact: true }).click();
    await page.getByRole("button", { name: "animation.sound", exact: true }).click();
    await page.getByRole("group", { name: "声音轨道", exact: true }).getByRole("button", { name: "声音 0.00 random.click", exact: true }).click();
    await page.getByRole("region", { name: "声音关键帧", exact: true }).waitFor();
    await page.getByLabel("声音名称", { exact: true }).fill("bad name");
    await page.getByRole("button", { name: "更新声音", exact: true }).click();
    await page.getByText("声音名称应为", { exact: false }).waitFor();
    assert.equal((await read()).sound_effects["0.00"].effect, "random.click");
    await page.getByLabel("声音名称", { exact: true }).fill("mob.cow.say");
    await page.getByRole("button", { name: "更新声音", exact: true }).click();
    await until(animation => animation.sound_effects["0.00"].effect === "mob.cow.say");
    await page.getByLabel("音高", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "更新声音", exact: true }).click();
    await page.getByText("音高应为", { exact: false }).waitFor();
    assert.equal((await read()).sound_effects["0.00"].pitch, undefined);
    await page.getByLabel("音高", { exact: true }).fill("1.5");
    await page.getByLabel("音量", { exact: true }).fill("0.25");
    await page.getByRole("button", { name: "更新声音", exact: true }).click();
    await until(animation => animation.sound_effects["0.00"].pitch === 1.5 && animation.sound_effects["0.00"].volume === 0.25);
    await page.screenshot({ path: artifactPath("outputs/sound-track-1440.png") });
    await page.getByRole("slider", { name: "时间", exact: true }).fill("2");
    await page.getByRole("heading", { name: "声音 · 2.00 秒", exact: true }).waitFor();
    await page.getByLabel("声音名称", { exact: true }).fill("random.pop");
    await page.getByRole("button", { name: "记录声音", exact: true }).click();
    await until(animation => animation.sound_effects["2.00"] && animation.sound_effects["2.00"].effect === "random.pop");
    await page.getByRole("combobox", { name: "当前声音", exact: true }).click();
    await page.getByRole("option", { name: "追加声音", exact: true }).click();
    await page.getByLabel("声音名称", { exact: true }).fill("mob.cat.meow");
    await page.getByRole("button", { name: "记录声音", exact: true }).click();
    const both = await until(animation => Array.isArray(animation.sound_effects["2.00"]) && animation.sound_effects["2.00"].length === 2);
    assert.deepEqual(both.sound_effects["2.00"], [{ effect: "random.pop" }, { effect: "mob.cat.meow" }]);
    assert.equal(both.sound_effects["0.00"].effect, "mob.cow.say");
    await page.screenshot({ path: artifactPath("outputs/sound-list-1440.png") });
    await page.getByRole("combobox", { name: "当前声音", exact: true }).click();
    await page.getByRole("option", { name: "2. mob.cat.meow", exact: true }).click();
    await page.getByRole("button", { name: "删除声音", exact: true }).click();
    await until(animation => Array.isArray(animation.sound_effects["2.00"]) && animation.sound_effects["2.00"].length === 1);
    await page.locator(".model-timeline").getByRole("button", { name: "撤销", exact: true }).click();
    const restored = await until(animation => Array.isArray(animation.sound_effects["2.00"]) && animation.sound_effects["2.00"].length === 2);
    assert.deepEqual(restored.sound_effects["2.00"][1], { effect: "mob.cat.meow" });
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
