const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { WorkspaceStore } = require("../electron/services.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-actions-ui-"));
  let app;
  try {
    const project = path.join(root, "project"),
      dataRoot = path.join(root, "data");
    await fs.mkdir(project);
    const game = path.join(root, "Game.exe"),
      runtime = path.join(root, "Fixture.exe");
    await fs.writeFile(game, "fixture not executed");
    const csharp = path.join(root, "Fixture.cs");
    await fs.writeFile(
      csharp,
      `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/debug-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Console.Error.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();}}`,
    );
    const compile = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + runtime, csharp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const store = new WorkspaceStore(dataRoot);
    await store.load();
    await store.addProject(project);
    const profileId = store.value.projects[0].id;
    await store.updateSettings({ LauncherPath: runtime, GamePath: game });
    await store.saveProject(profileId, null, {
      game_executable_path: game,
      include_debug_mod: false,
      included_mod_dirs: [{ path: project, enabled: true, hot_reload: true }],
    });
    const worlds = new WorldLibrary(
      store,
      path.join(dataRoot, "game-data/MinecraftPE_Netease/minecraftWorlds"),
    );
    const world = await worlds.create(profileId, { name: "功能测试存档" });
    const launch = async () => {
      app = await electron.launch({
        executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
        args: process.env.DGN_GAME_TEST_EXE
          ? []
          : ["tests/fixtures/isolated-ui-entry.cjs"],
        env: {
          ...process.env,
          DGN_GAME_HEADLESS: "1",
          DGN_GAME_DATA_DIR: dataRoot,
        },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(20000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
          false,
        ),
      );
      return page;
    };
    let page = await launch();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("article", { name: "存档 功能测试存档", exact: true })
      .getByRole("button", { name: "功能配置", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "存档控制台", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "给予物品", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "添加功能", exact: true }).click();
    await page.getByLabel("按钮名称", { exact: true }).fill("进服设为白天");
    await page.getByLabel("游戏指令", { exact: true }).fill("/time set day");
    await page
      .getByLabel("每次启动存档，玩家就绪后自动执行一次", { exact: true })
      .check();
    await page.getByRole("button", { name: "保存功能", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "添加功能", exact: true }).click();
    await page.getByLabel("按钮名称", { exact: true }).fill("领取钻石");
    await page.getByRole("combobox", { name: "功能类型", exact: true }).click();
    await page.getByRole("option", { name: "给予物品", exact: true }).click();
    await page.getByLabel("数量", { exact: true }).fill("5");
    await page.getByRole("button", { name: "保存功能", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "上移 领取钻石", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".custom-action-card h3")?.textContent ===
        "领取钻石",
    );
    await app.close();
    app = null;
    // Reopen verifies storage across application lifetimes, before any game is started.
    page = await launch();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "功能配置", exact: true }).click();
    await page
      .getByRole("article", { name: "功能 领取钻石", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "启动此存档", exact: true }).click();
    await page.getByText("本次启动的自动操作已完成", { exact: true }).waitFor();
    const launchState = await page.evaluate(() =>
      window.toolkit.call("launch.state"),
    );
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(launchState.session.runDirectory, ".mcdev.json"),
          "utf8",
        ),
      ).include_debug_mod,
      true,
    );
    const records = async () =>
      (await fs.readFile(path.join(project, "actions.fixture"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal((await records()).length, 1);
    assert.equal((await records())[0].command, "/time set day");
    assert.equal((await records())[0].side, false);
    await page
      .getByRole("article", { name: "功能 领取钻石", exact: true })
      .getByRole("button", { name: "执行", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".action-result.success").length === 2,
    );
    assert.equal((await records())[1].item, "minecraft:diamond");
    assert.equal((await records())[1].playerId, "-123456789123456");
    await page.getByRole("button", { name: "执行指令", exact: true }).click();
    await page.getByLabel("游戏指令", { exact: true }).fill('/say 中文 "测试"');
    await page.getByRole("button", { name: "立即执行", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal((await records())[2].command, '/say 中文 "测试"');
    // Keep the dashboard navigable and ensure mounting it again never replays auto actions.
    await page.getByRole("button", { name: "查看日志", exact: true }).click();
    await page
      .getByRole("heading", { name: "运行日志", exact: true })
      .waitFor();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "存档", exact: true })
      .click();
    await page.getByText("本次启动的自动操作已完成", { exact: true }).waitFor();
    assert.equal((await records()).length, 3);
    await page.getByRole("button", { name: "执行指令", exact: true }).click();
    await page.getByLabel("游戏指令", { exact: true }).fill("/invalid_fixture");
    await page.getByRole("button", { name: "立即执行", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText(/游戏返回失败/)
      .waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("article", { name: "功能 领取钻石", exact: true })
      .getByRole("button", { name: "停用", exact: true })
      .click();
    await page.getByText("已停用", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("article", { name: "功能 领取钻石", exact: true })
        .getByRole("button", { name: "执行", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "添加功能", exact: true }).click();
    await page.getByLabel("按钮名称", { exact: true }).fill("圆形沙漠");
    await page.getByRole("combobox", { name: "功能类型", exact: true }).click();
    await page.getByRole("option", { name: "设置群系", exact: true }).click();
    await page.getByRole("combobox", { name: "目标群系", exact: true }).click();
    await page
      .getByRole("option", { name: "沙漠 · desert", exact: true })
      .click();
    await page.getByRole("combobox", { name: "横向范围", exact: true }).click();
    await page.getByRole("option", { name: "圆形", exact: true }).click();
    await page.getByLabel("半径 R（方块）", { exact: true }).fill("3");
    await fs.mkdir(testResultsRoot, { recursive: true });
    const biomeEditor = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      path.join(testResultsRoot, "biome-action-editor.png"),
      Buffer.from(biomeEditor, "base64"),
    );
    await page.getByRole("button", { name: "保存功能", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const biomeCard = page.getByRole("article", {
      name: "功能 圆形沙漠",
      exact: true,
    });
    await biomeCard.getByRole("button", { name: "执行", exact: true }).click();
    await page
      .getByText(/群系已设置为 minecraft:desert；维度 3/)
      .waitFor({ state: "attached" });
    await page.getByRole("button", { name: "设置群系", exact: true }).click();
    await page.getByRole("combobox", { name: "横向范围", exact: true }).click();
    await page.getByRole("option", { name: "矩形", exact: true }).click();
    await page.getByLabel("长度 X（方块）", { exact: true }).fill("4");
    await page.getByLabel("宽度 Z（方块）", { exact: true }).fill("2");
    await page.getByRole("combobox", { name: "高度范围", exact: true }).click();
    await page
      .getByRole("option", { name: "指定最低 / 最高 Y", exact: true })
      .click();
    await page.getByLabel("最低 Y", { exact: true }).fill("66");
    await page.getByLabel("最高 Y", { exact: true }).fill("65");
    await page.getByRole("button", { name: "立即执行", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText(/最低 Y 不能高于最高 Y/)
      .waitFor();
    await page.getByLabel("最低 Y", { exact: true }).fill("64");
    await page.getByRole("button", { name: "立即执行", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByText(/Y 64～65.*共 8 列/).waitFor({ state: "attached" });
    const savedBiome = await page.evaluate(
      (worldId) => window.toolkit.call("world-actions.read", { worldId }),
      world.id,
    );
    assert.equal(
      savedBiome.actions.find((a) => a.name === "圆形沙漠").radius,
      3,
    );
    await fs.mkdir(testResultsRoot, { recursive: true });
    const shot = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      path.join(testResultsRoot, "world-actions.png"),
      Buffer.from(shot, "base64"),
    );
    await page
      .getByRole("button", { name: "删除 领取钻石", exact: true })
      .click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("article", { name: "功能 领取钻石", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "删除 领取钻石", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认删除功能", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page
      .getByRole("article", { name: "功能 领取钻石", exact: true })
      .waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("未运行", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "给予物品", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "返回存档列表", exact: true })
      .click();
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "World actions UI passed: persistence, auto once, quick command, item target, errors, navigation, edit/delete, shutdown",
    );
    await fs.writeFile(
      path.join(testResultsRoot, "world-actions-ui.json"),
      JSON.stringify(
        { passed: true, worldId: world.id, requests: await records(), errors },
        null,
        2,
      ),
    );
  } catch (error) {
    if (app) {
      const page = await app.firstWindow();
      console.error(await page.locator("body").innerText());
      console.error(
        JSON.stringify(
          await page.evaluate(async () => ({
            launch: await window.toolkit.call("launch.state"),
            debug: await window.toolkit.call("debug.state"),
          })),
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-actions-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
