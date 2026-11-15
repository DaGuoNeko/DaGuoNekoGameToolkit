const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactPath } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "particle");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.particle", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", pivot: [0, 6, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }] }] }), "utf8");
  const source = { loop: false, animation_length: 2, bones: { body: { rotation: { "0.00": [0, 0, 0] } } } };
  const file = path.join(folder, "model.animation.json");
  await fs.writeFile(file, JSON.stringify({ animations: { "animation.particle": source } }, null, 2), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  const errors = [];
  const read = async () => JSON.parse(await fs.readFile(file, "utf8")).animations["animation.particle"];
  const until = async (check) => {
    const start = Date.now();
    let last;
    while (Date.now() - start < 8000) {
      last = await read();
      if (check(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("动画没有变成预期结果: " + JSON.stringify(last && last.particle_effects));
  };
  let page;
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.particle" }).click();
    await page.getByRole("button", { name: "动画", exact: true }).click();
    await page.getByRole("button", { name: "animation.particle", exact: true }).click();
    await page.getByRole("toolbar", { name: "效果", exact: true }).getByRole("button", { name: "粒子", exact: true }).click();
    const panel = page.getByRole("region", { name: "粒子关键帧", exact: true });
    await panel.getByLabel("粒子名称", { exact: true }).fill("bad name");
    await panel.getByRole("button", { name: "记录粒子", exact: true }).click();
    await page.getByText("粒子名称应为", { exact: false }).waitFor();
    assert.equal((await read()).particle_effects, undefined);
    await panel.getByLabel("粒子名称", { exact: true }).fill("minecraft:basic_smoke_particle");
    await panel.getByLabel("粒子定位器", { exact: true }).fill("lead");
    await panel.getByRole("button", { name: "记录粒子", exact: true }).click();
    await until(animation => animation.particle_effects?.["0.00"]?.effect === "minecraft:basic_smoke_particle");
    await page.getByRole("group", { name: "粒子轨道", exact: true }).getByRole("button", { name: "粒子 0.00 minecraft:basic_smoke_particle", exact: true }).click();
    await panel.getByLabel("粒子定位器", { exact: true }).fill("");
    await panel.getByRole("button", { name: "更新粒子", exact: true }).click();
    const updated = await until(animation => animation.particle_effects["0.00"].effect === "minecraft:basic_smoke_particle" && animation.particle_effects["0.00"].locator === undefined);
    assert.equal(updated.animation_length, 2);
    await panel.getByLabel("粒子脚本", { exact: true }).fill("v.x = 1;");
    await panel.getByLabel("绑定到实体", { exact: true }).check();
    await panel.getByRole("button", { name: "更新粒子", exact: true }).click();
    await until(animation => animation.particle_effects["0.00"].pre_effect_script === "v.x = 1;" && animation.particle_effects["0.00"].bind_to_actor === true && animation.particle_effects["0.00"].locator === undefined);
    await page.screenshot({ path: artifactPath("outputs/particle-track-1440.png") });
    await panel.getByRole("button", { name: "删除粒子", exact: true }).click();
    await until(animation => animation.particle_effects === undefined);
    await page.locator(".model-timeline").getByRole("button", { name: "撤销", exact: true }).click();
    await until(animation => animation.particle_effects?.["0.00"]?.pre_effect_script === "v.x = 1;" && animation.particle_effects["0.00"].bind_to_actor === true);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
