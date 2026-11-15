const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data");
  const folder = path.join(data, "model-studio", "mesh");
  const file = path.join(folder, "model.geo.json");
  await fs.mkdir(folder, { recursive: true });
  const geometry = { "minecraft:geometry": [{ description: { identifier: "geometry.mesh_edit", texture_width: 64, texture_height: 64 }, bones: [{ name: "body", pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }] }] };
  const original = JSON.stringify(geometry);
  await fs.writeFile(file, original, "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const errors = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const capture = async name => {
    await page.waitForTimeout(250);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  try {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 900); window.webContents.setBackgroundThrottling(false); window.show(); window.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await button("模组与资源").click();
    await button("模型制作").click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.mesh_edit" }).click();
    await button("body 立方体 1").click();
    await button("转为网格").click();
    await button("body 网格").waitFor();
    await page.getByRole("heading", { name: "网格", exact: true }).waitFor();
    assert.equal(await page.getByLabel("坐标X", { exact: true }).inputValue(), "-4");
    await page.getByLabel("坐标X", { exact: true }).fill("-5");
    await page.getByLabel("坐标X", { exact: true }).press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-label="坐标X"]').value === "-5");
    assert.equal(await fs.readFile(file, "utf8"), original);
    await capture("mesh-dark");
    await button("撤销").click();
    await page.waitForFunction(() => document.querySelector('[aria-label="坐标X"]').value === "-4");
    await button("新建顶点").click();
    await page.getByText("已新建顶点，可一次撤销", { exact: true }).waitFor();
    await button("建面").click();
    await page.getByText(/请选 3 或 4 个不同的顶点/).waitFor();
    await button("删除顶点").click();
    await page.waitForFunction(() => !document.body.textContent.includes("顶点 8"));
    await button("细分这一面").click();
    await page.getByText("已把这一面分成四块，共享边已切开，可一次撤销", { exact: true }).waitFor();
    await button("撤销").click();
    const exported = artifactPath("outputs/mesh.bbmodel");
    await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, exported);
    await button("导出 .bbmodel").click();
    await page.getByText(/工程已导出：/).waitFor();
    const project = JSON.parse(await fs.readFile(exported, "utf8"));
    assert.equal(project.elements.some(item => item.type === "mesh"), true);
    const imported = importProject(project);
    assert.equal(imported.bones[0].poly_mesh.positions.length, 24);
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await capture("mesh-small-light");
    assert.deepEqual(errors, []);
    console.log("PASS 立方体转网格、角点坐标、撤销、bbmodel 往返、窄窗浅色");
    console.log(artifactRoot);
  } catch (error) {
    if (page) await capture("failure").catch(() => {});
    console.error("renderer errors", errors);
    throw error;
  } finally {
    if (app) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
