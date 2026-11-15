const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "properties"); await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.geo.json");
  const bones = [{ name: "body", pivot: [0, 6, 0], cubes: [
    { origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0], extension: { keep: 42 } },
    { origin: [8, 2, -1], size: [3, 6, 2], uv: [8, 4], inflate: 0.5, mirror: true },
  ] }, { name: "arm", parent: "body", pivot: [4, 10, 0], cubes: [{ origin: [1, 3, 2], size: [2, 3, 4], pivot: [3, 4, 5], rotation: [10, 20, 30], uv: { north: { uv: [2, 3], uv_size: [-2, 4], uv_rotation: 90 } } }] }];
  const geometry = { "format_version": "1.12.0", "minecraft:geometry": [
    { description: { identifier: "geometry.properties", texture_width: 64, texture_height: 64 }, bones },
    { description: { identifier: "geometry.other", texture_width: 32, texture_height: 32 }, bones: [{ name: "other", cubes: [{ origin: [0, 0, 0], size: [2, 2, 2], uv: [0, 0] }] }] },
  ], keep: "original" };
  const original = "// preserved comment\n" + JSON.stringify(geometry, null, 2); await fs.writeFile(file, original, "utf8");
  const read = async () => JSON.parse((await fs.readFile(file, "utf8")).replace(/^\/\/[^\n]*\n/, ""));
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const launch = async () => {
    app = await electron.launch({ cwd: path.resolve(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor(); await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator('.model-library-open').filter({ hasText: "geometry.properties" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => { if (!app) return; const instance = app; app = null; const timer = setTimeout(() => instance.process().kill(), 5000); try { await instance.close(); } finally { clearTimeout(timer); } };
  const capture = async name => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64")); await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(image, "base64")); };
  try {
    await launch();
    const button = name => page.getByRole("button", { name, exact: true }), input = name => page.getByLabel("批量" + name, { exact: true });
    const select = async second => { await button("body 立方体 1").click(); await button(second).click({ modifiers: ["Control"] }); await page.getByRole("status", { name: "元素选择", exact: true }).filter({ hasText: "已选 2 个立方体" }).waitFor(); };
    const mode = async label => { await page.getByRole("combobox", { name: "批量修改方式", exact: true }).click(); await page.getByRole("option", { name: label, exact: true }).click(); };
    const commit = async (name, value) => { await input(name).fill(String(value)); await input(name).press("Enter"); };
    const save = async () => { await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('.model-studio-actions button')].some(n => n.textContent.trim() === "保存模型" && !n.disabled)); return (await read())["minecraft:geometry"][0].bones; };
    const undo = async expected => { await button("撤销").click(); assert.deepEqual(await save(), expected); };
    await select("arm 立方体 1");
    assert.equal(await input("起点X").getAttribute("placeholder"), "多个值"); assert.equal(await input("尺寸Z").inputValue(), "4"); assert.equal(await input("UVU").isDisabled(), true); assert.equal(await page.getByRole("combobox", { name: "批量镜像贴图", exact: true }).isDisabled(), true);
    await input("起点X").fill("9"); await input("起点X").press("Escape"); await input("起点X").press("Tab"); assert.deepEqual(await save(), bones);
    await input("尺寸Z").fill(""); await input("尺寸Z").press("Tab"); assert.deepEqual(await save(), bones);
    await commit("起点X", 5); assert.equal(await input("起点X").inputValue(), "5");
    assert.deepEqual((await read())["minecraft:geometry"][0].bones, bones, "属性编辑只改草稿");
    const positioned = structuredClone(bones); positioned[0].cubes[0].origin[0] = 5; positioned[1].cubes[0].origin[0] = 5;
    assert.deepEqual(await save(), positioned); assert.deepEqual(JSON.parse((await fs.readFile(file + ".bak", "utf8")).replace(/^\/\/[^\n]*\n/, ""))["minecraft:geometry"][0].bones, bones);
    await undo(bones); await button("重做").click(); assert.deepEqual(await save(), positioned); await undo(bones);
    await mode("按原值增减"); await commit("尺寸Y", 2);
    const sized = structuredClone(bones); sized[0].cubes[0].size[1] = 14; sized[1].cubes[0].size[1] = 5; assert.deepEqual(await save(), sized); assert.equal(await input("尺寸Y").inputValue(), ""); await undo(bones);
    await mode("统一设值"); await commit("轴心Y", 9);
    const pivoted = structuredClone(bones); pivoted[0].cubes[0].pivot = [0, 9, 0]; pivoted[1].cubes[0].pivot[1] = 9; assert.deepEqual(await save(), pivoted); await undo(bones);
    await commit("旋转Z", 15); const rotated = structuredClone(bones); rotated[0].cubes[0].rotation = [0, 0, 15]; rotated[1].cubes[0].rotation[2] = 15; assert.deepEqual(await save(), rotated); await undo(bones);
    await commit("膨胀", -0.25); const inflated = structuredClone(bones); inflated[0].cubes[0].inflate = -0.25; inflated[1].cubes[0].inflate = -0.25; assert.deepEqual(await save(), inflated); await undo(bones);
    await page.getByRole("separator", { name: "调整贴图与元素高度", exact: true }).focus(); await page.keyboard.press("Home");
    await page.locator('.model-props').evaluate(node => node.scrollTo(0, 0)); await capture("multi-properties-dark");
    await mode("按原值增减"); await commit("起点X", 1000000); await page.getByRole("alert").filter({ hasText: "超出范围" }).waitFor(); assert.deepEqual(await save(), bones);
    console.log("PASS 跨骨骼共同值/混合值、Esc/空输入、单分量设置/增减、中心轴心、旋转/膨胀、整组撤销与超限拒绝");
    await select("body 立方体 2"); await commit("UVU", 12); const uvs = structuredClone(bones); uvs[0].cubes[0].uv[0] = 12; uvs[0].cubes[1].uv[0] = 12; assert.deepEqual(await save(), uvs); await undo(bones);
    await page.getByRole("combobox", { name: "批量镜像贴图", exact: true }).click(); await page.getByRole("option", { name: "镜像贴图：开启", exact: true }).click();
    const mirrored = structuredClone(bones); mirrored[0].cubes[0].mirror = true; assert.deepEqual(await save(), mirrored); await undo(bones);
    await commit("起点Z", 2); const final = structuredClone(bones); final[0].cubes[0].origin[2] = 2; final[0].cubes[1].origin[2] = 2;
    const output = artifactPath("outputs/batch-properties.bbmodel"); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output); await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const imported = importProject(JSON.parse(await fs.readFile(output, "utf8"))); assert.deepEqual(imported.bones[0].cubes.map(cube => cube.origin), final[0].cubes.map(cube => cube.origin));
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak"); await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor(); assert.deepEqual((await read())["minecraft:geometry"][0].bones, bones); assert.equal(await input("起点Z").inputValue(), "2");
    await fs.rmdir(file + ".bak"); assert.deepEqual(await save(), final);
    assert.deepEqual((await read())["minecraft:geometry"][1], geometry["minecraft:geometry"][1]); assert.equal((await read()).keep, "original"); assert.ok((await fs.readFile(file, "utf8")).startsWith("// preserved comment"));
    await page.getByLabel("模型", { exact: true }).selectOption("geometry.other"); assert.equal(await page.getByRole("region", { name: "多选元素属性", exact: true }).count(), 0);
    await button("other 立方体 1").click(); assert.equal(await page.getByLabel("尺寸X", { exact: true }).inputValue(), "2");
    await close(); await launch(); await select("body 立方体 2"); assert.equal(await input("起点Z").inputValue(), "2");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light"); await page.waitForTimeout(300); await input("膨胀").scrollIntoViewIfNeeded(); await capture("multi-properties-small-light");
    const fits = await page.locator('.model-multi-properties .model-vec input').evaluateAll(nodes => nodes.every(n => { const a = n.getBoundingClientRect(), b = n.closest('.model-props').getBoundingClientRect(); return a.width >= 40 && a.left >= b.left && a.right <= b.right; })); assert.equal(fits, true);
    assert.deepEqual(errors, []); console.log("PASS 盒子 UV/镜像、按面保护、未保存导出、保存失败重试、切模型清选择、重启和窄窗浅色布局"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
