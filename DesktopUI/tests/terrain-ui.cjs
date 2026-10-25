const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { levelData } = require("./fixtures/zip.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-terrain-ui-"));
  let app;
  try {
    const data = path.join(root, "data"), source = path.join(root, "source"), game = path.join(root, "Game.exe"), launcher = path.join(root, "Launcher.exe");
    await fs.mkdir(source); await fs.mkdir(path.join(source, "db"));
    await fs.writeFile(path.join(source, "level.dat"), levelData("Source"));
    await fs.writeFile(game, "fixture only");
    const cs = path.join(root, "Fixture.cs");
    await fs.writeFile(cs, `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/debug-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Console.Error.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();}}`);
    const c = spawnSync(path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", "/target:exe", "/out:" + launcher, cs], { encoding: "utf8", windowsHide: true });
    assert.equal(c.status, 0, c.stdout + c.stderr);
    const store = new WorkspaceStore(data); await store.load();
    const profiles = new Profiles(store); await profiles.initialize();
    await store.updateSettings({ GamePath: game, LauncherPath: launcher });
    const profile = await profiles.read(store.value.projects[0].id);
    const worlds = new WorldLibrary(store, path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"));
    const world = await worlds.create(profile.project.id, { name: "目标地图" });
    await fs.mkdir(worlds.location(world.id), { recursive: true });
    await fs.writeFile(path.join(worlds.location(world.id), "level.dat"), levelData("Target"));
    app = await electron.launch({ args: ["tests/fixtures/multi-hosts-ui-entry.cjs"], env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data } });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await app.evaluate(({ dialog, BrowserWindow }, file) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, source);
    const ipc = (method, args = {}) => page.evaluate(({ method, args }) => window.toolkit.call(method, args), { method, args });
    async function poll(predicate) {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('terrain UI state timeout: ' + JSON.stringify(await ipc('architecture.state')));
    }
    await page.getByRole("article", { name: "存档 目标地图", exact: true }).getByRole("button", { name: "启动此存档", exact: true }).click();
    await page.getByText("调试已就绪", { exact: true }).waitFor();
    const state = await ipc("launch.state");
    await ipc("launch.stop", { sessionId: state.selectedSession });
    await page.getByRole("button", { name: "地形与建筑导入", exact: true }).click();
    const panel = page.locator("dialog").filter({ has: page.getByRole("heading", { name: "地形与建筑导入", exact: true }) });
    await panel.getByRole("combobox", { name: "来源类型", exact: true }).click();
    await page.getByRole("option", { name: "基岩世界 · 文件夹 / MCWORLD / ZIP", exact: true }).click();
    await panel.getByRole("button", { name: "选择文件夹", exact: true }).click();
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/terrain-source-light.png" });
    await panel.getByRole("button", { name: "准备来源副本", exact: true }).click();
    const stage = expected => poll(async () => { const task = await ipc('architecture.state'); if (task?.error) throw Error(task.error); return task?.stage === expected && !task.busy; });
    await stage("prepared");
    await panel.getByRole("button", { name: "启动来源世界", exact: true }).click();
    await stage("source-running");
    await poll(async () => { const t = await ipc("architecture.state"); return (await ipc("world-actions.state", { worldId: t.sourceWorldId })).ready; });
    for (const [name, value] of [["角点一 X", "-2"], ["角点一 Y", "64"], ["角点一 Z", "0"], ["角点二 X", "-1"], ["角点二 Y", "64"], ["角点二 Z", "0"]]) await panel.locator(`input[aria-label="${name}"]`).fill(value);
    await panel.getByRole("button", { name: "读取选区地形", exact: true }).click();
    await stage("source-ready");
    assert.deepEqual((await ipc("architecture.state")).region.min, [-2,64,0]);
    await panel.getByRole("button", { name: "退出来源副本", exact: true }).click(); await stage("source-saved");
    await panel.getByRole("button", { name: "备份并启动目标存档", exact: true }).click(); await stage("target-running");
    await poll(async () => (await ipc("world-actions.state", { worldId: world.id })).ready);
    await panel.getByRole("button", { name: "读取当前玩家位置与维度", exact: true }).click();
    await panel.getByText(/当前读取：维度 3/).waitFor();
    await panel.getByRole("button", { name: "检查目标并生成预览", exact: true }).click(); await stage("preview-ready");
    const preview = await ipc("architecture.state");
    assert.equal(preview.plan.counts.changed, 2);
    await page.screenshot({ path: "test-results/terrain-preview-light.png" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: "test-results/terrain-preview-dark.png" });
    await panel.getByRole("button", { name: /确认导入 \d+ 格/, exact: true }).click();
    await page.locator("dialog").filter({ has: page.getByRole("heading", { name: "确认写入目标区域", exact: true }) }).last().getByRole("button", { name: "开始导入", exact: true }).click(); await stage("done");
    await panel.getByRole("button", { name: "撤销本次导入", exact: true }).click();
    await page.locator("dialog").filter({ has: page.getByRole("heading", { name: "确认撤销本次导入", exact: true }) }).last().getByRole("button", { name: "开始撤销", exact: true }).click(); await stage("undone");
    assert.deepEqual(errors, []);
    console.log("PASS terrain UI: real IPC, edited negative selection, backup, dimension 3 preview, confirmation, write/undo, themes, clean renderer");
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-terrain-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
