const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-profiles-ui-"));
  let app;
  try {
    const project = path.join(root, "project"),
      dataRoot = path.join(root, "profile");
    await fs.mkdir(project);
    // Use the real basename so an unrelated retail instance exercises identity filtering.
    const game = path.join(root, "Minecraft.Windows.exe"),
      runtime = path.join(root, "Fixture.exe");
    await fs.writeFile(game, "fixture");
    const csharp = path.join(root, "Fake.cs");
    await fs.writeFile(
      csharp,
      `using System;using System.Diagnostics;using System.Text;class Fake{static void Main(){Console.OutputEncoding=new UTF8Encoding(false);var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/world-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.WaitForExit();}}`,
    );
    const compiled = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + runtime, csharp],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const store = new WorkspaceStore(dataRoot);
    await store.load();
    await store.addProject(project);
    const hostId = store.value.projects[0].id;
    await store.updateSettings({ LauncherPath: runtime, GamePath: game });
    const optionsFile = path.join(
      dataRoot,
      "game-data/MinecraftPE_Netease/minecraftpe/options.txt",
    );
    await fs.mkdir(path.dirname(optionsFile), { recursive: true });
    const originalOptions =
      "dev_connection_quality:0\r\naudio_music:0.25\r\nunknown:https://keep:a\r\n";
    await fs.writeFile(optionsFile, originalOptions);
    await store.saveProject(hostId, null, {
      game_executable_path: game,
      world_name: "Legacy world",
    });
    const original = await fs.readFile(
      path.join(project, ".mcdev.json"),
      "utf8",
    );
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE
        ? []
        : [
            process.env.DGN_UI_ISOLATE_PROCESSES
              ? "tests/fixtures/isolated-ui-entry.cjs"
              : ".",
          ],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: dataRoot,
        DGN_OPTIONS_TEST: "1",
      },
    });
    const page = await app.firstWindow();
    await require("./fixtures/mock-menu-name.cjs")(app);
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow, dialog }, game) => {
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      );
      globalThis.fixturePick = game;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [globalThis.fixturePick],
      });
    }, game);
    const nav = async (name) => {
      await require("./fixtures/navigation.cjs").navigate(page, name);
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
    };
    const capture = async (file, allowDialog = false) => {
      if (!allowDialog)
        await page.locator("dialog[open]").waitFor({ state: "hidden" });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
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
      await fs.writeFile(file, Buffer.from(shot, "base64"));
    };
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await nav("游戏设置");
    await page
      .getByRole("button", { name: "启用完整网络堆栈", exact: true })
      .click();
    await nav("存档");
    await nav("游戏设置");
    assert.match(
      await page
        .getByRole("combobox", { name: "网络调节器", exact: true })
        .innerText(),
      /完整网络堆栈/,
    );
    assert.equal(await fs.readFile(optionsFile, "utf8"), originalOptions);
    await page
      .getByRole("button", { name: "保存游戏设置", exact: true })
      .click();
    await page
      .getByText("已保存，将在下一次启动游戏前应用。", { exact: true })
      .waitFor();
    assert.equal(await fs.readFile(optionsFile, "utf8"), originalOptions);
    await page.getByLabel("覆盖音乐音量", { exact: true }).check();
    await page
      .getByRole("textbox", { name: "音乐音量", exact: true })
      .fill("0.15");
    await page
      .getByRole("button", { name: "重新读取游戏设置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认重新读取", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="覆盖音乐音量"]')?.checked ===
        false,
    );
    assert.equal(
      await page.getByLabel("覆盖音乐音量", { exact: true }).isChecked(),
      false,
    );
    await capture(path.join(testResultsRoot, "game-options.png"));
    await nav("存档");
    assert.equal(await page.getByText("当前项目", { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "添加项目", exact: true }).count(),
      0,
    );
    await nav("启动配置");
    await page
      .getByRole("article", { name: "启动配置 project", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("combobox", { name: "启动配置", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByLabel("玩家名称", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("世界名称", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("游戏模式", { exact: true }).count(), 0);
    assert.equal(
      await page.getByLabel("存档目录名", { exact: true }).count(),
      0,
    );
    const sharedMod = path.join(root, "shared-mod");
    await fs.mkdir(sharedMod);
    await fs.writeFile(path.join(sharedMod, "keep.py"), "SOURCE");
    await nav("模组库");
    await page
      .getByRole("article", { name: "模组 project", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "添加全局模组", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("模组名称", { exact: true })
      .fill("共享模组");
    await page
      .getByRole("dialog")
      .getByLabel("模组目录", { exact: true })
      .fill(sharedMod);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存到模组库", exact: true })
      .click();
    const sharedCard = page.getByRole("article", {
      name: "模组 共享模组",
      exact: true,
    });
    await sharedCard.waitFor();
    await sharedCard
      .getByRole("button", { name: "编辑模组", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("模组名称", { exact: true })
      .fill("共享模组 A");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存到模组库", exact: true })
      .click();
    await page
      .getByRole("article", { name: "模组 共享模组 A", exact: true })
      .waitFor();
    await capture(path.join(testResultsRoot, "global-mod-library.png"));
    await nav("启动配置");
    await page.getByRole("button", { name: "新建配置", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("配置名称", { exact: true })
      .fill("联机 B");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByRole("heading", { name: "联机 B", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "使用全局游戏程序", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "选择游戏程序", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("checkbox", { name: "使用全局游戏程序", exact: true })
      .uncheck();
    await page
      .getByRole("button", { name: "选择游戏程序", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "重新载入", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("fieldset.workspace-fieldset[disabled]"),
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: "使用全局游戏程序", exact: true })
        .isChecked(),
      true,
      "reloading the same revision restores inherited game selection",
    );
    await page
      .getByRole("checkbox", { name: "使用全局游戏程序", exact: true })
      .check();
    await page.getByLabel("玩家名称", { exact: true }).fill("ClientB");
    assert.equal(
      await page.getByLabel("脚本热更新按键", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "打开全局热更新设置", exact: true })
      .click();
    const globalGame = path.join(root, "global", "Minecraft.Windows.exe");
    await fs.mkdir(path.dirname(globalGame));
    await fs.writeFile(globalGame, "fixture");
    await app.evaluate((_, value) => {
      globalThis.fixturePick = value;
    }, globalGame);
    await page
      .getByRole("button", { name: "选择游戏程序", exact: true })
      .click();
    await page.waitForFunction(
      async (value) =>
        (await window.toolkit.call("bootstrap")).settings.GamePath === value,
      globalGame,
    );
    await capture(path.join(testResultsRoot, "global-game-settings.png"));
    await page.getByLabel("脚本热更新按键", { exact: true }).press("F6");
    await page.waitForFunction(
      () => !document.querySelector("fieldset.workspace-fieldset[disabled]"),
    );
    await page.getByLabel("重载世界按键", { exact: true }).press("F8");
    await page.waitForFunction(
      () => !document.querySelector("fieldset.workspace-fieldset[disabled]"),
    );
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "在其他游戏界面也响应快捷键",
          exact: true,
        })
        .isChecked(),
      true,
    );
    await capture(path.join(testResultsRoot, "reload-hotkeys.png"));
    await nav("启动配置");
    await page
      .getByRole("article", { name: "启动配置 联机 B", exact: true })
      .getByRole("button", { name: "编辑配置", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("玩家名称", { exact: true }).inputValue(),
      "ClientB",
    );
    await page.getByLabel("搜索模组", { exact: true }).fill("共享");
    await page
      .getByRole("button", { name: "启用筛选结果", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "启用模组 共享模组 A", exact: true })
        .isChecked(),
      true,
    );
    await page
      .getByRole("checkbox", { name: "模组热更新 共享模组 A", exact: true })
      .uncheck();
    await page
      .getByRole("button", { name: "停用筛选结果", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "启用模组 共享模组 A", exact: true })
      .check();
    assert.equal(
      await page
        .getByRole("checkbox", { name: "模组热更新 共享模组 A", exact: true })
        .isChecked(),
      false,
    );
    await page.getByLabel("搜索模组", { exact: true }).fill("");
    await capture(path.join(testResultsRoot, "profile-mod-selection.png"));
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.getByText("已保存", { exact: false }).first().waitFor();
    await page
      .getByRole("button", { name: "返回配置卡片", exact: true })
      .click();
    const profileCard = (name) =>
      page.getByRole("article", { name: "启动配置 " + name, exact: true });
    await profileCard("联机 B").getByText("ClientB", { exact: true }).waitFor();
    await page.getByLabel("搜索启动配置").fill("联机 B");
    assert.equal(await page.getByRole("article").count(), 1);
    await page.getByLabel("搜索启动配置").fill("");
    await profileCard("联机 B")
      .getByRole("button", { name: "复制配置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("配置名称", { exact: true })
      .fill("联机 C");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByRole("heading", { name: "联机 C", exact: true }).waitFor();
    await page
      .getByRole("checkbox", { name: "启用模组 共享模组 A", exact: true })
      .uncheck();
    await page.getByLabel("玩家名称", { exact: true }).fill("ClientC");
    await page
      .getByRole("button", { name: "返回配置卡片", exact: true })
      .click();
    await profileCard("联机 B")
      .getByRole("button", { name: "编辑配置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await profileCard("联机 C")
      .getByRole("button", { name: "编辑配置", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("玩家名称", { exact: true }).inputValue(),
      "ClientC",
    );
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page
      .getByRole("button", { name: "返回配置卡片", exact: true })
      .click();
    await profileCard("联机 C")
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await page.getByRole("dialog").getByLabel("配置名称").fill("待删除副本");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await profileCard("待删除副本")
      .getByRole("button", { name: "重命名", exact: true })
      .click();
    await page.getByRole("dialog").getByLabel("配置名称").fill("联机 C");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await profileCard("联机 B")
      .getByRole("button", { name: "复制配置", exact: true })
      .click();
    await page.getByRole("dialog").getByLabel("配置名称").fill("临时配置");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page
      .getByRole("button", { name: "返回配置卡片", exact: true })
      .click();
    await profileCard("临时配置")
      .getByRole("button", { name: "删除配置", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await profileCard("临时配置").waitFor({ state: "hidden" });
    // Removing a shared mod also cleans the active unsaved draft, retaining
    // unrelated edits and cleaning both enabled and disabled saved references.
    await profileCard("联机 B")
      .getByRole("button", { name: "编辑配置", exact: true })
      .click();
    await page.getByLabel("玩家名称", { exact: true }).fill("ClientB_Draft");
    await nav("模组库");
    await page
      .getByRole("article", { name: "模组 共享模组 A", exact: true })
      .getByRole("button", { name: "移出模组库", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认移出", exact: true })
      .click();
    await page
      .getByRole("article", { name: "模组 共享模组 A", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(
      await fs.readFile(path.join(sharedMod, "keep.py"), "utf8"),
      "SOURCE",
    );
    await nav("启动配置");
    await profileCard("联机 B")
      .getByRole("button", { name: "编辑配置", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("玩家名称", { exact: true }).inputValue(),
      "ClientB_Draft",
    );
    assert.equal(
      await page
        .getByText("仅在此配置中，未登记到全局库", { exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByRole("checkbox", { name: /启用模组 (shared-mod|共享模组 A)/ })
        .count(),
      0,
    );
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await page
      .getByText("启动配置已保存，原文件已备份", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "管理模组库", exact: true }).click();
    await page
      .getByRole("button", { name: "从启动配置收录", exact: true })
      .click();
    await page.getByText(/已收录 0/).waitFor();
    assert.equal(
      await page
        .getByRole("article", { name: "模组 shared-mod", exact: true })
        .count(),
      0,
    );
    await nav("存档");
    await page.getByRole("button", { name: "新建存档", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("存档名称", { exact: true })
      .fill("世界 A");
    await page
      .getByRole("dialog")
      .getByLabel("世界种子", { exact: true })
      .fill("123");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "创建存档", exact: true })
      .click();
    const card = page.getByRole("article", {
      name: "存档 世界 A",
      exact: true,
    });
    await card.waitFor();
    await card.getByRole("button", { name: "存档设置", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "使用启动配置", exact: true })
      .click();
    await page.getByRole("option", { name: "联机 B", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "保存存档设置", exact: true })
      .click();
    await card.getByText("启动配置：联机 B", { exact: true }).waitFor();
    await card.getByRole("button", { name: "启动此存档", exact: true }).click();
    await page.getByRole("button", { name: "查看日志", exact: true }).click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "WORLD_READY 世界 A" })
      .waitFor();
    const startMenu = async (label) => {
      await nav("控制台");
      await page
        .getByRole("button", { name: "启动空白客户端", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      assert.equal(await dialog.getByRole("combobox").count(), 0);
      const before = await dialog
        .getByLabel("玩家名字", { exact: true })
        .inputValue();
      assert.match(before, /^[A-Za-z]+$/);
      await dialog
        .getByRole("button", { name: "随机英文名", exact: true })
        .click();
      const after = await dialog
        .getByLabel("玩家名字", { exact: true })
        .inputValue();
      assert.match(after, /^[A-Za-z]+$/);
      assert.notEqual(after, before);
      await dialog.getByLabel("玩家名字", { exact: true }).fill(label);
      await capture(path.join(testResultsRoot, "blank-client.png"), true);
      await dialog
        .getByRole("button", { name: "启动客户端", exact: true })
        .click();
      await page.getByRole("button", { name: "脚本日志", exact: true }).click();
      await page
        .locator(".log-text")
        .filter({ hasText: "MENU_READY " + label })
        .waitFor();
    };
    await nav("启动配置");
    await profileCard("联机 C")
      .getByRole("button", { name: "启动客户端", exact: true })
      .click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "MENU_READY ClientC" })
      .waitFor();
    await nav("启动配置");
    await profileCard("联机 C")
      .getByText("1 个游戏运行中", { exact: true })
      .waitFor();
    assert.equal(
      await profileCard("联机 C")
        .getByRole("button", { name: "删除配置", exact: true })
        .isDisabled(),
      true,
    );
    await startMenu("BlankPlayer");
    let state = await page.evaluate(() => window.toolkit.call("launch.state"));
    assert.equal(state.sessions.filter((s) => s.running).length, 3);
    assert.deepEqual(
      (await app.evaluate(() => globalThis.menuNameCalls)).map(
        (args) => args[4],
      ),
      ["ClientC", "BlankPlayer"],
    );
    assert(
      state.sessions
        .filter((s) => s.role === "menu")
        .every((s) => s.playerNameStatus === "applied"),
    );
    const host = state.sessions.find((s) => s.worldId),
      client = state.sessions.find((s) => s.profileName === "联机 C");
    assert.equal(
      await fs.readFile(path.join(project, ".mcdev.json"), "utf8"),
      original,
    );
    const profiles = await page.evaluate(() =>
      window.toolkit.call("profiles.list"),
    );
    for (const p of profiles) {
      const raw = JSON.parse(
        await fs.readFile(path.join(p.root, ".mcdev.json"), "utf8"),
      );
      assert.ok(!Object.hasOwn(raw, "world_name"));
      assert.ok(!Object.hasOwn(raw, "world_seed"));
    }
    const runtimeConfigs = await Promise.all(
      state.sessions.map((s) =>
        fs
          .readFile(path.join(s.runDirectory, ".mcdev.json"), "utf8")
          .then(JSON.parse),
      ),
    );
    assert.equal(
      await fs.readFile(optionsFile, "utf8"),
      originalOptions.replace(
        "dev_connection_quality:0",
        "dev_connection_quality:1",
      ) + "gfx_fullscreen:0\r\n",
    );
    const optionBackups = await fs.readdir(
      path.join(dataRoot, "game-options-backups"),
    );
    assert.equal(optionBackups.length, 1);
    assert.equal(
      await fs.readFile(
        path.join(dataRoot, "game-options-backups", optionBackups[0]),
        "utf8",
      ),
      originalOptions,
    );
    assert.equal(
      runtimeConfigs.filter((c) => c.auto_join_game === false).length,
      2,
    );
    assert.equal(runtimeConfigs.find((c) => c.auto_join_game).world_seed, 123);
    assert(runtimeConfigs.every((c) => c.game_executable_path === globalGame));
    const blankConfig = runtimeConfigs.find(
      (c) => c.user_name === "BlankPlayer",
    );
    assert.deepEqual(blankConfig.included_mod_dirs, []);
    assert.equal(blankConfig.include_debug_mod, false);
    assert.equal(blankConfig.auto_join_game, false);
    assert.equal(blankConfig.reset_world, false);
    assert.equal(
      runtimeConfigs.find((c) => c.auto_join_game).debug_options.reload_key,
      "117",
    );
    assert.equal(
      runtimeConfigs.find((c) => c.auto_join_game).debug_options
        .reload_world_key,
      "119",
    );
    assert.equal(
      runtimeConfigs.find((c) => c.user_name === "ClientC").debug_options
        .reload_key,
      "117",
    );
    assert.equal(
      runtimeConfigs.find((c) => c.user_name === "ClientC").debug_options
        .reload_key_global,
      true,
    );
    const sessionCard = (session) =>
      page.getByRole("button", {
        name: `查看会话 ${session.profileName} ${session.userName} PID ${session.pid}`,
        exact: true,
      });
    assert.equal(await page.locator(".log-session-card").count(), 3);
    const compactCard = await page
      .locator(".log-session-card")
      .first()
      .boundingBox();
    assert.ok(compactCard.height <= 52, "session card uses two compact rows");
    assert.equal(await page.locator("#log-settings").isVisible(), false);
    await sessionCard(client).click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "MENU_READY ClientC" })
      .waitFor();
    assert.equal(
      await sessionCard(client).getAttribute("aria-pressed"),
      "true",
    );
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "暂停实时显示", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "收起日志设置", exact: true })
      .click();
    await sessionCard(host).click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "WORLD_READY 世界 A" })
      .waitFor();
    assert.equal(
      await page
        .locator(".log-text")
        .filter({ hasText: "MENU_READY ClientC" })
        .count(),
      0,
    );
    await page.locator(".log-session-cards").evaluate((el) => {
      const buttons = el.querySelectorAll("button");
      buttons[1].click();
      buttons[0].click();
      buttons[1].click();
    });
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "MENU_READY ClientC" })
      .waitFor();
    await capture(path.join(testResultsRoot, "log-session-cards.png"));
    const configB = await page.evaluate(async () => {
      const ps = await window.toolkit.call("profiles.list");
      return window.toolkit.call("project.read", {
        id: ps.find((p) => p.name === "联机 B").id,
      });
    });
    const configC = await page.evaluate(async () => {
      const ps = await window.toolkit.call("profiles.list");
      return window.toolkit.call("project.read", {
        id: ps.find((p) => p.name === "联机 C").id,
      });
    });
    assert.deepEqual(configB.config.included_mod_dirs, []);
    assert.equal(configB.config.user_name, "ClientB_Draft");
    assert.deepEqual(configC.config.included_mod_dirs, []);
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("会话已停止", { exact: true }).waitFor();
    state = await page.evaluate(() => window.toolkit.call("launch.state"));
    assert.equal(state.sessions.find((s) => s.id === client.id).running, false);
    assert.equal(state.sessions.find((s) => s.id === host.id).running, true);
    assert.equal(state.sessions.filter((s) => s.running).length, 2);
    const blank = state.sessions.find((s) => s.blank);
    await page.evaluate(
      (id) => window.toolkit.call("launch.stop", { sessionId: id }),
      blank.id,
    );
    await sessionCard(blank).click();
    await page
      .getByRole("button", {
        name: `删除会话 ${blank.profileName} PID ${blank.pid}`,
        exact: true,
      })
      .click();
    await sessionCard(blank).waitFor({ state: "hidden" });
    await page.waitForFunction(
      (id) =>
        document
          .querySelector('.log-session-card[aria-pressed="true"]')
          ?.getAttribute("aria-label")
          .includes("PID " + id),
      host.pid,
    );
    state = await page.evaluate(() => window.toolkit.call("launch.state"));
    assert.equal(
      state.sessions.some((s) => s.id === blank.id),
      false,
    );
    assert(
      (await page.evaluate(() => window.toolkit.call("logs.history"))).some(
        (h) => h.id === blank.id,
      ),
    );
    for (const s of state.sessions.filter((s) => s.running))
      await page.evaluate(
        (id) => window.toolkit.call("launch.stop", { sessionId: id }),
        s.id,
      );
    await nav("存档");
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    await card.getByRole("button", { name: "删除存档", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await card.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "回收站", exact: true }).click();
    await card.getByRole("button", { name: "恢复存档", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认恢复", exact: true })
      .click();
    await page.getByRole("tab", { name: "存档", exact: true }).click();
    await card.waitFor();
    const legacy = path.join(
      dataRoot,
      "game-data/MinecraftPE_Netease/minecraftWorlds/import-me",
    );
    await fs.mkdir(path.join(legacy, "db"), { recursive: true });
    const level = Buffer.alloc(12);
    level.writeUInt32LE(10, 0);
    level.writeUInt32LE(4, 4);
    level[8] = 10;
    await fs.writeFile(path.join(legacy, "level.dat"), level);
    await fs.writeFile(path.join(legacy, "db", "keep"), "IMPORTED_PROGRESS");
    await app.evaluate((_, folder) => {
      globalThis.fixturePick = folder;
    }, legacy);
    await page.getByRole("button", { name: "导入旧存档", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("存档名称", { exact: true })
      .fill("旧存档副本");
    await page
      .getByRole("button", { name: "选择旧存档目录", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("combobox", { name: "存档使用方式", exact: true }).click();
    await page.getByRole("option", { name: "复制导入（独立副本）", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "开始导入", exact: true })
      .click();
    await page
      .getByRole("article", { name: "存档 旧存档副本", exact: true })
      .waitFor();
    assert.equal(
      await fs.readFile(path.join(legacy, "db", "keep"), "utf8"),
      "IMPORTED_PROGRESS",
    );
    await page.waitForFunction(
      () =>
        document.querySelector("[role=tab][aria-selected=true]")
          ?.textContent === "存档",
    );
    await card.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
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
      path.join(testResultsRoot, "profiles-world-home.png"),
      Buffer.from(shot, "base64"),
    );
    // Cancel is non-destructive; confirmed removal deletes only the copy.
    const imported = page.getByRole("article", {
      name: "存档 旧存档副本",
      exact: true,
    });
    const worldRecords = await page.evaluate(() =>
      window.toolkit.call("worlds.list"),
    );
    const importedRecord = worldRecords.worlds.find(
      (w) => w.name === "旧存档副本",
    );
    await imported
      .getByRole("button", { name: "删除存档", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "移入回收站", exact: true })
      .click();
    await imported.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "回收站", exact: true }).click();
    await imported
      .getByRole("button", { name: "永久删除", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    const trashPath = path.join(worldRecords.root, ".trash", importedRecord.id);
    assert.equal(
      await fs.readFile(path.join(trashPath, "db", "keep"), "utf8"),
      "IMPORTED_PROGRESS",
    );
    await imported
      .getByRole("button", { name: "永久删除", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    await imported.waitFor({ state: "hidden" });
    await assert.rejects(fs.stat(trashPath), { code: "ENOENT" });
    assert.equal(
      await fs.readFile(path.join(legacy, "db", "keep"), "utf8"),
      "IMPORTED_PROGRESS",
    );
    // Bulk confirmation contains the complete trash snapshot, even when filtered.
    await page.evaluate(async (profileId) => {
      for (const name of ["清空测试 A", "清空测试 B"]) {
        const w = await window.toolkit.call("worlds.create", {
          projectId: profileId,
          name,
        });
        await window.toolkit.call("worlds.recycle", {
          worldId: w.id,
          confirmed: true,
        });
      }
    }, hostId);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page
      .getByRole("article", { name: "存档 清空测试 A", exact: true })
      .waitFor();
    await page.getByLabel("搜索存档").fill("清空测试 A");
    await page.getByRole("button", { name: "清空回收站", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByText("清空测试 B", { exact: true })
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(
      (
        await page.evaluate(() => window.toolkit.call("worlds.list"))
      ).worlds.filter((w) => w.deleted).length,
      2,
    );
    await page.getByRole("button", { name: "清空回收站", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认清空回收站", exact: true })
      .click();
    await page.getByText("回收站为空", { exact: true }).waitFor();
    const afterPurge = await page.evaluate(() =>
      window.toolkit.call("worlds.list"),
    );
    assert.deepEqual(
      afterPurge.worlds.map((w) => w.name),
      ["世界 A"],
    );
    await fs.stat(path.join(afterPurge.worlds[0].path, "level.dat"));
    await nav("启动配置");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const configShot = await app.evaluate(async ({ BrowserWindow }) =>
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
      path.join(testResultsRoot, "launch-profiles.png"),
      Buffer.from(configShot, "base64"),
    );
    assert.deepEqual(errors, []);
  } finally {
    if (app) {
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("profile UI exit timed out")),
              20000,
            );
          }),
        ]);
      } catch (e) {
        if (app.process().exitCode === null)
          spawnSync(
            path.join(process.env.SystemRoot, "System32/taskkill.exe"),
            ["/PID", String(app.process().pid), "/T", "/F"],
            { windowsHide: true },
          );
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-profiles-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    "PASS profiles/world UI: global mod library CRUD/import/independent enable and hot reload; session cards/rapid switching/pause isolation; profile cards, world binding, sessions, recycle/restore/permanent deletion; clean exit",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
