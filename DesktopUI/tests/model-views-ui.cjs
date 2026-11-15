const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifactPath } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "views");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "model.geo.json"), JSON.stringify({ "minecraft:geometry": [{ description: { identifier: "geometry.views", texture_width: 16, texture_height: 16 }, bones: [{ name: "body", pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }] }] }), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  const open = async app => {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.views" }).click();
    await page.getByRole("combobox", { name: "视角", exact: true }).first().waitFor();
    return page;
  };
  const settings = path.join(data, "settings.json");
  const readViews = async () => JSON.parse(await fs.readFile(settings, "utf8")).settings.ModelStudioViews;
  let app = await launch();
  try {
    let page = await open(app);
    await page.getByRole("combobox", { name: "视角", exact: true }).first().click();
    await page.getByRole("option", { name: "底视图", exact: true }).click();
    await page.getByRole("combobox", { name: "预览布局", exact: true }).click();
    await page.getByRole("option", { name: "四视图", exact: true }).click();
    const started = Date.now();
    let saved;
    while (Date.now() - started < 8000) {
      saved = await readViews();
      if (saved?.slots?.[0]?.view === "bottom" && saved.quad === true && saved.slots[0].custom === true) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(saved.slots[0].view, "bottom");
    assert.equal(saved.quad, true);
    assert.equal(saved.slots[0].custom, true);
    await page.screenshot({ path: artifactPath("outputs/views-quad-1440.png") });
    await app.close();
    app = await launch();
    page = await open(app);
    await page.locator(".model-view-grid.quad").waitFor();
    await page.getByRole("combobox", { name: "视角", exact: true }).filter({ hasText: "底视图" }).waitFor();
    assert.equal((await readViews()).slots[0].view, "bottom");
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
