const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { parse } = require("jsonc-parser");
const { importProject } = require("../electron/domains/profiles/bbmodel-codec.cjs");
const { artifactPath, artifactRoot } = require("./fixtures/artifacts.cjs");

(async () => {
  const data = artifactPath("data"), folder = path.join(data, "model-studio", "bones");
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, "model.geo.json");
  const bones = [
    { name: "body", pivot: [0, 1, 0], rotation: [0, 0, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] },
    { name: "arm", parent: "body", pivot: [0, 5, 0], rotation: [0, 0, 0], cubes: [{ origin: [4, 0, -1], size: [3, 6, 2], uv: [0, 0] }] },
    { name: "hand", parent: "arm", pivot: [0, 6, 0], locators: { grip: { offset: [0, 1, 0] } }, extension: "keep" },
    { name: "stand", pivot: [10, 0, 0], cubes: [] },
  ];
  const other = { description: { identifier: "geometry.other", texture_width: 16, texture_height: 16 }, bones: [{ name: "other", cubes: [] }] };
  const geometry = { "minecraft:geometry": [{ description: { identifier: "geometry.bones", texture_width: 16, texture_height: 16 }, bones }, other], keep: "original" };
  await fs.writeFile(file, "// preserve this comment\n" + JSON.stringify(geometry, null, 2), "utf8");
  const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  let app, page; const errors = [];
  const read = async () => parse(await fs.readFile(file, "utf8"));
  const launch = async () => {
    app = await electron.launch({ cwd: path.join(__dirname, ".."), env, ...(process.env.DGN_GAME_TEST_EXE ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] } : { args: ["."] }) });
    page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setSize(1440, 900); win.show(); win.focus(); });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await page.getByRole("button", { name: "模组与资源", exact: true }).click(); await page.getByRole("button", { name: "模型制作", exact: true }).click();
    await page.locator(".model-library-open").filter({ hasText: "geometry.bones" }).click(); await page.getByRole("heading", { name: "大纲", exact: true }).waitFor();
  };
  const close = async () => {
    if (!app) return; const instance = app; app = null;
    const timer = setTimeout(() => instance.process().kill(), 5000);
    try { await instance.close(); } finally { clearTimeout(timer); }
  };
  const button = name => page.getByRole("button", { name, exact: true });
  const treeButton = name => page.locator(".model-tree").getByRole("button", { name, exact: true });
  const input = name => page.getByLabel("批量骨骼" + name, { exact: true });
  const selected = async names => {
    const actual = await page.locator(".model-tree button[aria-pressed=true]:not(.model-eye)").allTextContents();
    assert.deepEqual(actual.map(name => name.trim()).sort(), names.slice().sort());
  };
  const select = async names => { for (let i = 0; i < names.length; i++) await treeButton(names[i]).click(i ? { modifiers: ["Control"] } : {}); await selected(names); };
  const commit = async (name, value) => { await input(name).fill(String(value)); await input(name).press("Enter"); };
  const save = async () => {
    await button("保存模型").click(); await page.getByText("已写回模型文件，原文件保存在同名 .bak", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".model-studio-actions button")].some(node => node.textContent.trim() === "保存模型" && !node.disabled));
    return (await read())["minecraft:geometry"][0].bones;
  };
  const undo = async expected => { await button("撤销").click(); assert.deepEqual(await save(), expected); };
  const choose = async (label, value) => { await page.getByRole("combobox", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const capture = async name => {
    await page.waitForTimeout(350);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    await fs.writeFile(artifactPath("outputs/" + name + ".png"), Buffer.from(png, "base64"));
  };
  try {
    await launch(); await select(["body", "arm"]);
    assert.equal(await treeButton("body").evaluate(node => getComputedStyle(node).backgroundColor === "rgba(0, 0, 0, 0)"), false, "大纲多选须有可见高亮");
    assert.equal(await input("轴心Y").getAttribute("placeholder"), "多个值"); assert.equal(await input("轴心X").inputValue(), "0");
    assert.equal(await page.getByLabel("骨骼名称", { exact: true }).count(), 0);
    await input("轴心Y").fill("8"); await input("轴心Y").press("Escape"); await input("轴心Y").press("Tab"); assert.deepEqual(await save(), bones);
    await input("轴心Y").fill(""); await input("轴心Y").press("Tab"); assert.deepEqual(await save(), bones);
    await commit("轴心Y", 8); const pivoted = structuredClone(bones); pivoted[0].pivot[1] = 8; pivoted[1].pivot[1] = 8;
    assert.deepEqual((await read())["minecraft:geometry"][0].bones, bones, "只改草稿"); assert.deepEqual(await save(), pivoted);
    assert.deepEqual(parse(await fs.readFile(file + ".bak", "utf8"))["minecraft:geometry"][0].bones, bones);
    await undo(bones); await selected(["body", "arm"]); await button("重做").click(); assert.deepEqual(await save(), pivoted); await undo(bones);
    await choose("骨骼批量修改方式", "按原值增减"); await commit("旋转Z", 15);
    const rotated = structuredClone(bones); rotated[0].rotation[2] = 15; rotated[1].rotation[2] = 15; assert.deepEqual(await save(), rotated); await undo(bones);
    await commit("轴心Y", 1000000); await page.getByRole("alert").filter({ hasText: "超出范围" }).waitFor(); assert.deepEqual(await save(), bones);
    await choose("骨骼批量修改方式", "统一设值"); await commit("旋转Z", 0);
    await page.getByRole("separator", { name: "调整贴图与元素高度", exact: true }).focus(); await page.keyboard.press("Home");
    await page.locator(".model-props").evaluate(node => node.scrollTo(0, 0)); await capture("bone-properties-dark");
    console.log("PASS 骨骼共同值/混合值、空白/Esc、统一值/增减、超限拒绝、保存备份和撤销重做");

    await button("移动").click(); await page.getByLabel("透视模型画布", { exact: true }).focus(); await page.keyboard.press("ArrowRight");
    const moved = await save(); for (let i = 0; i < 3; i++) assert.equal(moved[i].pivot[0], bones[i].pivot[0] + 1, "父子同时选中只移动一次");
    assert.deepEqual(moved[3], bones[3]); await undo(bones);
    await choose("批量父级骨骼", "stand"); const parented = structuredClone(bones); parented[0].parent = "stand";
    assert.deepEqual(await save(), parented); await capture("bone-parented"); await undo(bones); await selected(["body", "arm"]);
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await treeButton("body").dispatchEvent("dragstart", { dataTransfer: transfer }); await treeButton("hand").dispatchEvent("drop", { dataTransfer: transfer });
    await page.getByText("不能把骨骼挂到自己或所选骨骼的子级上", { exact: true }).waitFor(); assert.deepEqual(await save(), bones);
    await treeButton("body").dispatchEvent("dragstart", { dataTransfer: transfer }); await treeButton("stand").dispatchEvent("drop", { dataTransfer: transfer });
    assert.deepEqual(await save(), parented); await undo(bones); await transfer.dispose();
    console.log("PASS 父子组移动去重、批量父级、拖动和循环层级拒绝");

    await treeButton("arm").focus(); await page.keyboard.press("Control+d");
    const copied = await save(); assert.equal(copied.length, 7); assert.equal(copied[5].parent, copied[4].name); assert.equal(copied[6].parent, copied[5].name); assert.deepEqual(copied[6].locators, bones[2].locators);
    await selected(["body2", "arm2"]); await capture("bone-copied"); await undo(bones); await selected(["body", "arm"]);
    await button("重做").click(); assert.deepEqual(await save(), copied); await selected(["body2", "arm2"]); await undo(bones);
    await treeButton("arm").focus(); await page.keyboard.press("Delete");
    const deleted = await save(); assert.deepEqual(deleted.map(bone => bone.name), ["hand", "stand"]); assert.equal(deleted[0].parent, undefined);
    await undo(bones); await selected(["body", "arm"]);
    await treeButton("arm").click({ modifiers: ["Control"] }); await selected(["body"]); assert.equal(await page.getByRole("region", { name: "多选骨骼属性", exact: true }).count(), 0);
    await page.getByLabel("骨骼名称", { exact: true }).fill("torso"); await page.getByLabel("骨骼名称", { exact: true }).press("Tab");
    await selected(["torso"]); await undo(bones); await selected(["body"]);
    await treeButton("body 立方体 1").click(); await selected([]); assert.equal(await page.getByRole("region", { name: "多选骨骼属性", exact: true }).count(), 0);
    await select(["body", "arm"]);
    console.log("PASS 整组复制/删除、子级保留、快捷键、取消多选、单选重命名和立方体选择隔离");

    await commit("轴心Y", 9); const final = structuredClone(bones); final[0].pivot[1] = 9; final[1].pivot[1] = 9;
    const output = artifactPath("outputs/bone-batch.bbmodel");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, output);
    await button("导出 .bbmodel").click(); await page.getByText(/工程已导出：/).waitFor();
    const project = importProject(JSON.parse(await fs.readFile(output, "utf8"))); assert.deepEqual(project.bones.slice(0, 2).map(bone => bone.pivot), [[0, 9, 0], [0, 9, 0]]);
    await fs.unlink(file + ".bak"); await fs.mkdir(file + ".bak");
    await button("保存模型").click(); await page.getByText(/EISDIR|EPERM|illegal operation|operation not permitted/).waitFor();
    assert.deepEqual((await read())["minecraft:geometry"][0].bones, bones); assert.equal(await input("轴心Y").inputValue(), "9");
    await fs.rmdir(file + ".bak"); assert.deepEqual(await save(), final);
    assert.equal((await read()).keep, "original"); assert.ok((await fs.readFile(file, "utf8")).startsWith("// preserve this comment")); assert.deepEqual((await read())["minecraft:geometry"][1], other);
    await page.getByLabel("模型", { exact: true }).selectOption("geometry.other"); await selected([]); assert.equal(await page.getByRole("region", { name: "多选骨骼属性", exact: true }).count(), 0);
    await close(); await launch(); await selected([]); await select(["body", "arm"]); assert.equal(await input("轴心Y").inputValue(), "9");
    await app.evaluate(({ BrowserWindow, nativeTheme }) => { BrowserWindow.getAllWindows()[0].setSize(1000, 720); nativeTheme.themeSource = "light"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.waitForTimeout(350);
    await button("重置视角").click();
    await page.locator(".model-props").evaluate(node => node.scrollTo(0, 0)); await capture("bone-properties-small-light");
    assert.equal(await page.locator(".model-multi-properties .model-vec input").evaluateAll(nodes => nodes.length === 6 && nodes.every(node => { const a = node.getBoundingClientRect(), b = node.closest(".model-props").getBoundingClientRect(); return a.width >= 40 && a.left >= b.left && a.right <= b.right; })), true);
    assert.deepEqual(errors, []);
    console.log("PASS 未保存导出、写入失败重试、切模型清选择、重启和窄窗浅色布局");
    await fs.writeFile(artifactPath("outputs/result.json"), JSON.stringify({ passed: true, scenarios: 4, errors }, null, 2), "utf8"); console.log(artifactRoot);
  } catch (error) { if (page) await capture("failure").catch(() => {}); throw error; }
  finally { await close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
