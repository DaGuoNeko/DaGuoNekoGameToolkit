const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { exportProject, importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { createModel, createTexture } = require("../electron/domains/profiles/content-files.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data");
  const fixtures = artifactPath("fixtures");
  const library = { list: async () => ({ mods: [] }) };
  const created = await createModel({ identifier: "geometry.fixture" }, fixtures);
  const texture = await createTexture(library, { modelPath: created.path, name: "texture", width: 64, height: 64 }, null, fixtures);
  const bytes = await fs.readFile(texture.path);
  const expression = "math.sin(q.anim_time * 360) * 30";
  const project = exportProject({ identifier: "geometry.exchange", textureWidth: 64, textureHeight: 64,
    bones: [{ name: "body", pivot: [0, 8, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }],
    texture: "data:image/png;base64," + bytes.toString("base64"),
    animations: { "animation.wave": { loop: false, animation_length: 1, bones: { body: { rotation: [0, expression, 0] } } } },
  });
  const input = artifactPath("fixtures/input.bbmodel"), invalid = artifactPath("fixtures/mesh.bbmodel"), output = artifactPath("outputs/edited.bbmodel");
  await fs.writeFile(input, JSON.stringify(project), "utf8");
  const broken = structuredClone(project); broken.elements[0].type = "mesh";
  await fs.writeFile(invalid, JSON.stringify(broken), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ cwd: path.join(__dirname, ".."), env,
    ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
  let page;
  const errors = [];
  const choose = async (kind, file) => app.evaluate(({ dialog }, { kind, file }) => {
    if (kind === "open") dialog.showOpenDialog = async () => file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] };
    else dialog.showSaveDialog = async () => file ? { canceled: false, filePath: file } : { canceled: true };
  }, { kind, file });
  try {
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click();
    await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await choose("open", null);
    await page.getByRole("button", { name: "导入 .bbmodel", exact: true }).click();
    await page.getByRole("button", { name: "导入 .bbmodel", exact: true }).waitFor();
    assert.equal(await page.locator(".model-library-open").count(), 0);
    await choose("open", invalid);
    await page.getByRole("button", { name: "导入 .bbmodel", exact: true }).click();
    await page.getByText(/网格顶点无效/).waitFor();
    assert.equal(await page.locator(".model-library-open").count(), 0);
    await choose("open", input);
    await page.getByRole("button", { name: "导入 .bbmodel", exact: true }).click();
    await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
    await page.getByRole("button", { name: "texture.png", exact: true }).waitFor();
    await page.getByRole("button", { name: "body 立方体 1", exact: true }).click();
    await page.getByLabel("起点X", { exact: true }).fill("2");
    await page.getByRole("button", { name: "绘制", exact: true }).click();
    await page.getByLabel("画笔颜色").fill("#cc3333");
    const canvas = page.locator(".model-paint canvas");
    await page.waitForFunction(() => {
      const node = document.querySelector(".model-paint canvas");
      return node && node.getContext("2d").getImageData(node.width / 2, node.height / 2, 1, 1).data[3] === 255;
    });
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator(".model-brush").getByRole("button", { name: "撤销", exact: true }).waitFor();
    await choose("save", output);
    await page.getByRole("button", { name: "导出 .bbmodel", exact: true }).click();
    await page.getByText(/工程已导出：/).waitFor();
    const exported = JSON.parse(await fs.readFile(output, "utf8"));
    const decoded = importProject(exported);
    assert.equal(decoded.bones[0].cubes[0].origin[0], 2, "尚未保存的模型改动应进入工程");
    assert.equal(decoded.animations["animation.wave"].bones.body.rotation["0.00"][1], expression);
    assert.notEqual(exported.textures[0].source, project.textures[0].source, "尚未保存的笔画应进入工程");
    assert.deepEqual(JSON.parse(await fs.readFile(input, "utf8")), project, "导入源工程不能被改写");
    await page.screenshot({ path: artifactPath("outputs/export-paint.png") });
    await page.getByRole("button", { name: "退出编辑", exact: true }).click();
    await choose("open", output);
    await page.getByRole("button", { name: "导入 .bbmodel", exact: true }).click();
    await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
    await page.getByRole("button", { name: "body 立方体 1", exact: true }).click();
    assert.equal(await page.getByLabel("起点X", { exact: true }).inputValue(), "2");
    await page.getByRole("button", { name: "动画", exact: true }).click();
    await page.getByRole("button", { name: "animation.wave", exact: true }).click();
    await page.locator(".model-bone-list").getByRole("button", { name: "body", exact: true }).click();
    await page.getByRole("region", { name: "Molang 通道" }).waitFor();
    const time = page.getByRole("slider", { name: "时间", exact: true });
    await time.press("Home");
    for (let i = 0; i < 5; i++) await time.press("ArrowRight");
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="旋转Y"]').value) === 30);
    await page.screenshot({ path: artifactPath("outputs/reopened-animation.png") });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 800));
    await page.getByRole("button", { name: "导出 .bbmodel", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: artifactPath("outputs/project-1180.png") });
    assert.deepEqual(errors, []);
    console.log("PASS 原生选择取消/拒绝 mesh/真实 IPC 导入、导出未保存模型与笔画、动画重开、源文件不变");
    console.log(artifactRoot);
  } catch (error) {
    if (page) await page.screenshot({ path: artifactPath("outputs/failure.png") }).catch(() => {});
    throw error;
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
