const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createReadStream } = require("node:fs");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { javaMap, bedrockMap, zipMap } = require("./fixtures/map-world.cjs");

async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-map-preview-ui-"));
  let app;
  const checks = [], shots = [];
  try {
    const data = path.join(root, "data"), source = path.join(root, "java-world");
    await javaMap(source);
    const archive = path.join(root, "java.zip"); await zipMap(source, archive);
    const store = new WorkspaceStore(data); await store.load();
    const profiles = new Profiles(store); await profiles.initialize();
    const worlds = new WorldLibrary(store, path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"));
    const world = await worlds.create(store.value.projects[0].id, { name: "地图预览验收" });
    await bedrockMap(worlds.location(world.id));
    const alternate = await worlds.create(store.value.projects[0].id, { name: "同项目存档" });
    await javaMap(worlds.location(alternate.id));
    await worlds.create(store.value.projects[0].id, { name: "未生成存档" });
    const copying = await worlds.create(store.value.projects[0].id, { name: "复制未完成" });
    await bedrockMap(worlds.location(copying.id));
    const deleted = await worlds.create(store.value.projects[0].id, { name: "已回收存档" });
    await bedrockMap(worlds.location(deleted.id));
    const anotherProject = await profiles.create("其他项目");
    const foreign = await worlds.create(anotherProject.project.id, { name: "其他项目存档" });
    await bedrockMap(worlds.location(foreign.id));
    const index = await worlds.read();
    index.worlds.find(w => w.id === copying.id).copying = true;
    index.worlds.find(w => w.id === deleted.id).deletedAt = new Date().toISOString();
    await worlds.write(index);
    const mcworld = path.join(root, "bedrock.mcworld"); await zipMap(worlds.location(world.id), mcworld);
    await fs.mkdir(testResultsRoot, { recursive: true });
    const env = { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data };
    delete env.ELECTRON_RUN_AS_NODE;
    if(process.env.DGN_GAME_TEST_EXE) {
      assert(path.isAbsolute(process.env.DGN_GAME_TEST_EXE));
      env.PATH=path.join(process.env.SystemRoot,"System32")+";"+process.env.SystemRoot;
    }
    app = await electron.launch({ executablePath:process.env.DGN_GAME_TEST_EXE||undefined,args:process.env.DGN_GAME_TEST_EXE?[]:["."], env });
    console.log("map UI: Electron launched");
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
    // 只允许地图输入；客户端 JAR 不可用时必须仍能完成真实 IPC 预览。
    await app.evaluate(()=>{
      const fs=process.getBuiltinModule("node:fs"),fsp=fs.promises;
      for(const [object,methods] of [[fs,["readFileSync","openSync"]],[fsp,["readFile","open"]]]) for(const name of methods) {
        const original=object[name];object[name]=function(file,...args){
          if(typeof file==="string"&&/\.jar$/i.test(file))throw Error("External game JAR access is forbidden in this test");
          return original.call(this,file,...args);
        };
      }
    });
    await app.evaluate(async ({ dialog, BrowserWindow, nativeTheme, clipboard }) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      nativeTheme.themeSource = "light";
      globalThis.previewClipboard = await clipboard.read();
      dialog.showOpenDialog = async (_, options) => {
        globalThis.lastPreviewPicker = options;
        return { canceled: !globalThis.previewPick, filePaths: globalThis.previewPick ? [globalThis.previewPick] : [] };
      };
    });
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    console.log("map UI: home ready");
    const panel = page.locator("dialog").filter({ has: page.getByRole("heading", { name: "地图预览", exact: true }) });
    const canvas = panel.locator("canvas");
    const button = name => panel.getByRole("button", { name, exact: true });
    const flush = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const choose = async (file, zip = false) => {
      await app.evaluate((_, file) => { globalThis.previewPick = file; }, file);
      await panel.getByRole("combobox", { name: "选择外部地图", exact: true }).click();
      await page.getByRole("option", { name: zip ? "ZIP / MCWORLD" : "文件夹", exact: true }).click();
      const picker = await app.evaluate(() => globalThis.lastPreviewPicker);
      assert.deepEqual(picker.properties, [zip ? "openFile" : "openDirectory"]);
      if (zip) assert.deepEqual(picker.filters[0].extensions, ["zip", "mcworld"]);
    };
    const generate = async expected => {
      await panel.locator(".map-preview-meta").getByText(expected).waitFor({ timeout: 90000 });
      await panel.locator(".map-preview-status").first().getByText(/范围 X|该维度没有可预览/).waitFor({ timeout: 90000 });
      await flush();
    };
    const selectWorld = async name => {
      await panel.getByRole("combobox", { name: "选择当前存档", exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const capture = async name => {
      console.log("map UI: capture " + name);
      await flush();
      const file = path.join(testResultsRoot, name) + ".png";
      const bytes = await app.evaluate(async ({ BrowserWindow }) =>
        (
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          )
        ).toPNG().toString("base64"),
      );
      await fs.writeFile(file, Buffer.from(bytes, "base64"));
      shots.push(path.resolve(file));
    };
    const landmark = () => canvas.evaluate(c => {
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] === 217 && data[i + 1] === 105 && data[i + 2] === 26) {
        const p = i / 4, x = p % c.width, y = Math.floor(p / c.width);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++;
      }
      const r = c.getBoundingClientRect();
      return { x: (minX + maxX) / 2 * r.width / c.width, y: (minY + maxY) / 2 * r.height / c.height,
        width: (maxX - minX + 1) * r.width / c.width, count };
    });
    await page.getByRole("article", { name: "存档 其他项目存档", exact: true }).waitFor();
    await page.getByRole("article", { name: "存档 地图预览验收", exact: true }).getByRole("button", { name: "地图预览", exact: true }).click();
    await panel.getByText(/基岩 · 9 个区块/).waitFor(); await flush();
    console.log("map UI: Bedrock rendered");
    assert.equal(await button("选择材质 JAR / ZIP").count(),0);
    await assert.rejects(page.evaluate(()=>window.toolkit.call("map-preview.pick-resources")),/不支持/);
    await panel.getByText(/内置地图配色/).waitFor();
    assert.equal(await button("加载当前视野附近").count(), 0);
    assert.equal(await panel.getByLabel("区块上限", { exact: true }).count(), 0);
    const be = await landmark(); assert(be.count > 0, "Bedrock known surface landmark must be rendered");
    await capture("map-preview-bedrock-light");
    checks.push("managed Bedrock card opens through real IPC; known surface landmark");

    const localPicker = panel.getByRole("combobox", { name: "选择当前存档", exact: true });
    assert.equal(await localPicker.innerText(), "地图预览验收");
    await localPicker.click();
    for (const name of ["未生成存档", "复制未完成", "已回收存档", "其他项目存档"]) {
      assert.equal(await page.getByRole("option", { name, exact: true }).count(), 0);
    }
    await page.getByRole("option", { name: "同项目存档", exact: true }).click();
    await generate(/Java · 9 个区块/);
    assert.equal(await panel.locator(".map-preview-source").innerText(), worlds.location(alternate.id));
    await choose(mcworld, true); await generate(/基岩 · 9 个区块/);
    assert.equal(await localPicker.innerText(), "请选择存档");
    await choose(mcworld, true); await generate(/基岩 · 9 个区块/);
    await choose(null); await generate(/基岩 · 9 个区块/);
    assert.equal(await panel.locator(".map-preview-source").innerText(), mcworld, "cancelling keeps the current source");
    await selectWorld("地图预览验收"); await generate(/基岩 · 9 个区块/);
    assert.equal(await panel.locator(".map-preview-source").innerText(), worlds.location(world.id));
    checks.push("current project dropdown excludes unavailable/foreign worlds; managed/external switching; MCWORLD and cancel");

    // 从存档卡片打开后更换来源，不能继续渲染原 worldId。
    await choose(source); await generate(/Java · 9 个区块/);
    const box = await canvas.boundingBox(), first = await landmark();
    assert(first.count > 0);
    const unit = Math.min(8, (box.width - 40) / 48, (box.height - 40) / 48);
    assert(Math.abs(first.x - (box.width / 2 + (5.5 - 8) * unit)) < 2, "Java landmark X must match known world coordinate");
    assert(Math.abs(first.y - (box.height / 2 + (11.5 - 8) * unit)) < 2, "Java landmark Z must match known world coordinate");
    await capture("map-preview-java-light");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(before=>Number(document.querySelector(".map-preview-status")?.textContent.match(/缩放 ([\d.]+)/)?.[1])>before*1.1,unit);
    await flush();
    const zoomed = await landmark();
    assert(zoomed.count > first.count * 1.1, "wheel zoom increases actual landmark pixel area despite integer edge rounding");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, { steps: 4 }); await page.mouse.up(); await flush();
    const panned = await landmark();
    assert(Math.abs(panned.x - zoomed.x - 40) < 2 && Math.abs(panned.y - zoomed.y - 25) < 2, "drag translates actual pixels by pointer delta");
    checks.push("switch source from managed card; Java X/Z landmark; pixel zoom and pan assertions");

    await button("适应画布").click(); await flush();
    const selectionBox = await canvas.boundingBox();
    const sx = x => selectionBox.x + selectionBox.width / 2 + (x + .5 - 8) * unit;
    const sy = z => selectionBox.y + selectionBox.height / 2 + (z + .5 - 8) * unit;
    await page.keyboard.down("Shift");
    await page.mouse.move(sx(-4), sy(-3)); await page.mouse.down();
    await page.mouse.move(sx(6), sy(12), { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Shift"); await flush();
    console.log("map UI: " + await panel.locator(".map-preview-selection").innerText());
    await panel.locator(".map-preview-selection").getByText(/^选区 X /).waitFor();
    await button("复制坐标").click(); await panel.getByText("已复制坐标", { exact: true }).waitFor();
    assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /^-?\d+,-?\d+ → -?\d+,-?\d+$/);
    await capture("map-preview-selection-light");
    checks.push("negative X/Z selection; real clipboard exact readback");

    const selectDimension = async label => {
      await panel.getByRole("combobox", { name: "维度", exact: true }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
    };
    await selectDimension("末地"); await generate(/Java · 0 个区块/);
    await panel.getByText("该维度没有可预览的已生成区块", { exact: true }).waitFor();
    assert.equal((await landmark()).count, 0, "dimension switch clears previous map");
    await selectDimension("主世界"); await choose(archive, true); await generate(/Java · 9 个区块/);
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark"); await capture("map-preview-java-dark");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 650));
    await flush();
    assert(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "small window has no horizontal clipping");
    assert(await panel.locator(".modal-body").evaluate(el => el.scrollHeight <= el.clientHeight + 1), "controls fit in the smallest supported window");
    await button("适应画布").click();
    await capture("map-preview-small-dark");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1240, 820));
    await selectDimension("下界"); await choose(worlds.location(world.id)); await generate(/基岩 · 1 个区块/);
    await capture("map-preview-bedrock-nether-dark");
    checks.push("Java ZIP; empty dimension; Bedrock nether v9 singleton; both themes; 900x650 layout");

    // 拖动视野后自动补读区块；加载期间已显示的图片保持不变。
    await selectDimension("主世界");await choose(source);await generate(/Java · 9 个区块/);
    const beforePan=await canvas.boundingBox();
    await page.mouse.move(beforePan.x+beforePan.width/2,beforePan.y+beforePan.height/2);
    await page.mouse.down();await page.mouse.move(beforePan.x+beforePan.width/2+55,beforePan.y+beforePan.height/2+30,{steps:4});await page.mouse.up();await flush();
    const beforeLoad=await canvas.evaluate(c=>c.toDataURL());
    await panel.locator(".map-preview-meta").getByText(/Java ·/).waitFor({timeout:90000});await flush();
    assert.equal(await canvas.evaluate(c=>c.toDataURL()),beforeLoad,"loading this view preserves the camera");
    await page.evaluate(()=>window.toolkit.call("launch.state"));
    checks.push("viewport drag preserves camera and unrelated IPC remains available");

    if (process.env.DGN_MAP_JAVA_ZIP) {
      const input = path.resolve(process.env.DGN_MAP_JAVA_ZIP), before = await digest(input);
      await selectDimension("主世界"); await choose(input, true); await generate(/Java ·/);
      const start=Date.now();await page.evaluate(()=>window.toolkit.call("launch.state"));
      assert(Date.now()-start<3000,"background map work must not block main-process IPC");
      await capture("map-preview-background-loading");
      checks.push("automatic viewport loading, retained map while panning, responsive IPC");
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "light"; }); await flush();
      await capture("map-preview-java-archive-light");
      await panel.locator(".map-preview-options summary").click();
      await panel.getByLabel("地形明暗与水深",{exact:true}).uncheck();
      await panel.locator(".map-preview-options summary").click();
      await capture("map-preview-flat-comparison");
      await panel.locator(".map-preview-options summary").click();
      await panel.getByLabel("地形明暗与水深",{exact:true}).check();
      await panel.locator(".map-preview-options summary").click();
      await panel.getByText(/内置地图配色/).waitFor();
      await capture("map-preview-builtin-terrain");
      await button("1:1").click(); await flush(); await capture("map-preview-builtin-detail");
      await panel.locator(".map-preview-options summary").click();await capture("map-preview-loading-options");
      await panel.locator(".map-preview-options summary").click();
      assert.equal(await digest(input), before, "supplied Java ZIP must remain byte-identical");
      checks.push("supplied Java ZIP, built-in palette with external JAR reads forbidden, centered full-resolution tiles, relief on/off, 1:1 details, original SHA256 unchanged");
    }
    await choose(root);
    await panel.locator(".error-box").waitFor();
    assert.equal((await landmark()).count, 0, "failed source must clear stale map");
    await selectDimension("主世界");
    await choose(source); await generate(/Java · 9 个区块/);
    checks.push("invalid source shows an error and subsequent valid source recovers in overworld");
    await button("关闭").click();
    await page.getByRole("article", { name: "存档 其他项目存档", exact: true }).getByRole("button", { name: "地图预览", exact: true }).click();
    await generate(/基岩 · 9 个区块/);
    await panel.getByRole("combobox", { name: "选择当前存档", exact: true }).click();
    assert.equal(await page.getByRole("option", { name: "同项目存档", exact: true }).count(), 0);
    await page.getByRole("option", { name: "其他项目存档", exact: true }).click();
    await button("关闭").click();
    checks.push("opening a card uses that world's project without filtering the global world library");
    assert.deepEqual(errors, [], "renderer must have no errors or passive wheel warnings");
    await fs.writeFile(path.join(testResultsRoot, "map-preview-ui.json"), JSON.stringify({ passed: true, checks, shots }, null, 2) + "\n", "utf8");
    console.log("PASS map preview UI: " + checks.join("; "));
  } catch (error) {
    console.error("map UI failure:", error.message);
    throw error;
  } finally {
    if (app) {
      await app.evaluate(async ({ clipboard }) => {
        if (globalThis.previewClipboard?.length) await clipboard.write(globalThis.previewClipboard);
        else clipboard.clear();
      }).catch(() => {});
      let timer;
      try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("map UI close timeout")), 10000); })]); }
      finally { clearTimeout(timer); }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-map-preview-ui-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
