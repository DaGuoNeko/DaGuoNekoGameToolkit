const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { WorkspaceStore } = require("../electron/services.cjs");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-game-ui-"));
  const project = path.join(root, "游戏项目");
  await fs.mkdir(project);
  const game = path.join(root, "FixtureGame.exe"),
    runtime = path.join(root, "FakeMcdk.exe");
  await fs.writeFile(game, "never executed");
  const source = path.join(root, "Fake.cs");
  const colorSamples = [
    "[INFO][Engine][Client] value=12.5 (0xFF) <Player> https://example.test/a?q=12",
    "[DEBUG][Developer] debug value=42",
    "[ERROR][Engine] example failure 123",
    "[WARNING][Server] warning value=3",
    "<img src=x onerror=alert(1)> & literal text",
    "[MCP] [INFO] 2026-10-09 04:39:30 Method call successful: tools/call",
    '[MCP] [INFO] 2026-10-09 04:39:30 ::1:56514 - "POST /mcp HTTP/1.1" 200',
    "[MCP] [ERROR] request failed",
  ];
  await fs.writeFile(
    source,
    'using System;using System.Text;using System.Threading;using System.IO;class Fake {static void Main(){Console.OutputEncoding=new UTF8Encoding(false);Console.WriteLine("测试启动成功");Console.WriteLine(Environment.CurrentDirectory);Console.Error.WriteLine("测试错误输出");bool sent=false,tail=false,again=false;for(int i=0;i<1800;i++){if(!sent && File.Exists("burst.fixture")){for(int j=0;j<3500;j++)Console.WriteLine("BURST_"+j);Console.WriteLine("[INFO][Engine] HISTORY_COLOR value=99");sent=true;}if(!tail && File.Exists("tail.fixture")){for(int j=0;j<30;j++)Console.WriteLine("TAIL_"+j);tail=true;}if(!again && File.Exists("again.fixture")){for(int j=0;j<30;j++)Console.WriteLine("AGAIN_"+j);again=true;}Thread.Sleep(100);}}}'.replace(
      "bool sent=false,tail=false,again=false;",
      colorSamples
        .map(
          (text, index) =>
            (index >= 5 ? "Console.Error.WriteLine(" : "Console.WriteLine(") +
            JSON.stringify(text) +
            ");",
        )
        .join("") + "bool sent=false,tail=false,again=false;",
    ),
  );
  const bridgeLaunch = `var identityBridge=new System.Diagnostics.Process();identityBridge.StartInfo=new System.Diagnostics.ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/menu-bridge.cjs") + '"')});identityBridge.StartInfo.UseShellExecute=false;identityBridge.StartInfo.CreateNoWindow=true;identityBridge.Start();`;
  await fs.writeFile(
    source,
    (await fs.readFile(source, "utf8")).replace(
      "Console.OutputEncoding=new UTF8Encoding(false);",
      "Console.OutputEncoding=new UTF8Encoding(false);" + bridgeLaunch,
    ),
  );
  const compiled = spawnSync(
    path.join(
      process.env.WINDIR,
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    ),
    ["/nologo", "/target:exe", `/out:${runtime}`, source],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  let app;
  try {
    const store = new WorkspaceStore(path.join(root, "profile"));
    await store.load();
    await store.addProject(project);
    await store.updateSettings({
      LauncherPath: runtime,
      GamePath: process.execPath,
    });
    await store.saveProject(store.value.projects[0].id, null, {
      game_executable_path: process.execPath,
    });
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_NATIVE_LOG_FIXTURE: "1",
        DGN_GAME_DATA_DIR: path.join(root, "profile"),
      },
    });
    const page = await app.firstWindow();
    await require("./fixtures/mock-menu-name.cjs")(app);
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await app.evaluate(
      ({ BrowserWindow, dialog }, values) => {
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
          false,
        );
        globalThis.pickFiles = [values.project];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: globalThis.pickFiles,
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: values.log,
        });
      },
      { project, log: path.join(root, "export.log") },
    );
    const nav = async (name) => {
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForFunction(
        (title) =>
          document.querySelector(".sidebar button.active")?.title === title &&
          !document.documentElement.dataset.pageAnimating,
        name,
      );
    };
    await nav("启动配置");
    await page
      .getByRole("article")
      .first()
      .getByRole("button", { name: "启动客户端", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "运行日志", exact: true })
      .waitFor();
    const runtimeProject = await page.evaluate(
      async () =>
        (await window.toolkit.call("launch.state")).session.runDirectory,
    );
    assert.equal(await page.getByRole("button", { name: "脚本日志", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByText("测试启动成功", { exact: true }).waitFor();
    await page.getByText("测试错误输出", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "游戏调试日志", exact: true })
      .click();
    await page
      .locator(".log-text")
      .filter({ hasText: "NATIVE_CONTENT" })
      .waitFor()
      .catch(async (error) => {
        console.error(
          await page.evaluate(async () => {
            const state = await window.toolkit.call("launch.state");
            return window.toolkit.call("logs.gameState", {
              sessionId: state.session.id,
            });
          }),
        );
        throw error;
      });
    assert.equal(
      await page
        .locator(".log-text")
        .filter({ hasText: "测试启动成功" })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("combobox", { name: "日志类型", exact: true }).click();
    await page
      .getByRole("option", { name: "原版引擎日志", exact: true })
      .click();
    await page
      .locator(".log-text")
      .filter({ hasText: "NATIVE_ENGINE" })
      .waitFor();
    assert.equal(
      await page
        .locator(".log-text")
        .filter({ hasText: "NATIVE_CONTENT" })
        .count(),
      0,
    );
    await page.getByRole("combobox", { name: "日志类型", exact: true }).click();
    await page.getByRole("option", { name: "全部日志", exact: true }).click();
    await page.getByRole("button", { name: "清空显示", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".log-line"));
    await fs.writeFile(path.join(runtimeProject, "native-tail.fixture"), "go");
    await page
      .locator(".log-text")
      .filter({ hasText: "NATIVE_TAIL" })
      .waitFor();
    await page.getByRole("button", { name: "导出日志", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "日志已导出" }).waitFor();
    assert.match(
      await fs.readFile(path.join(root, "export.log"), "utf8"),
      /NATIVE_CONTENT/,
    );
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/game-debug-logs.png" });
    await page
      .getByRole("button", { name: "收起日志设置", exact: true })
      .click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page.getByText("测试启动成功", { exact: true }).waitFor();
    await page
      .locator(".log-text")
      .filter({ hasText: colorSamples[4] })
      .waitFor();
    for (const sample of colorSamples.slice(5, 7)) {
      const token = page.locator(".log-token-mcp").filter({ hasText: sample });
      await token.waitFor();
      assert.equal(await token.textContent(), sample);
      assert.equal(
        await token.evaluate((el) => getComputedStyle(el).color),
        "rgb(147, 197, 253)",
      );
    }
    assert.equal(
      await page
        .locator(".log-token-error")
        .filter({ hasText: colorSamples[7] })
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(235, 38, 101)",
    );
    const colored = page
      .locator(".log-line")
      .filter({ hasText: colorSamples[0] });
    assert.equal(
      await colored.locator(".log-text").textContent(),
      colorSamples[0],
    );
    for (const [kind, rgb] of Object.entries({
      tags: "rgb(129, 239, 102)",
      number: "rgb(174, 129, 255)",
      url: "rgb(102, 217, 239)",
      angle: "rgb(225, 38, 213)",
    }))
      assert.equal(
        await colored
          .locator(".log-token-" + kind)
          .first()
          .evaluate((el) => getComputedStyle(el).color),
        rgb,
      );
    assert.equal(
      await page
        .locator(".log-token-error")
        .last()
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(235, 38, 101)",
    );
    await page.locator(".log-token-debug").scrollIntoViewIfNeeded();
    assert.equal(
      await page
        .locator(".log-token-debug")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(96, 165, 255)",
    );
    assert.equal(
      await page.locator(".log-console img,.log-console a").count(),
      0,
    );
    assert.equal(
      await page
        .locator(".log-console")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(18, 19, 20)",
    );
    await fs.mkdir("test-results", { recursive: true });
    await page.waitForFunction(
      () => !document.documentElement.dataset.pageAnimating,
    );
    await page.locator(".log-console").scrollIntoViewIfNeeded();
    const colorScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      "test-results/log-colors.png",
      Buffer.from(colorScreenshot, "base64"),
    );
    assert.equal(
      await page
        .getByRole("textbox", { name: "搜索日志", exact: true })
        .isVisible(),
      true,
    );
    const compact = await page.locator(".log-console").boundingBox();
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const cardStrip = await page.locator(".log-session-cards").boundingBox();
    assert.ok(cardStrip.height < 140, "session cards remain one compact row");
    const reloadBar = await page.locator(".reload-toolbar").boundingBox();
    const searchBar = await page.locator(".log-search-bar").boundingBox();
    const searchSummary = await page
      .locator(".log-search-summary")
      .boundingBox();
    assert.ok(
      compact.height >
        viewport.height -
          195 -
          cardStrip.height -
          reloadBar.height -
          searchBar.height -
          searchSummary.height,
    );
    const line = await page
      .locator(".log-line")
      .filter({ hasText: "测试启动成功" })
      .boundingBox();
    assert.ok(line.height <= 19, "single-line logs should use compact spacing");
    assert.ok(compact.y + compact.height <= viewport.height + 1);
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    const expanded = await page.locator(".log-console").boundingBox();
    assert.ok(compact.width - expanded.width > 200);
    assert.ok(Math.abs(compact.height - expanded.height) < 3);
    const settingsScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      "test-results/log-settings.png",
      Buffer.from(settingsScreenshot, "base64"),
    );
    await page
      .getByRole("textbox", { name: "搜索日志", exact: true })
      .fill("测试");
    await page
      .getByRole("button", { name: "收起日志设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "搜索日志", exact: true })
        .inputValue(),
      "测试",
    );
    await page.getByRole("textbox", { name: "搜索日志", exact: true }).fill("");
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole("textbox", { name: "搜索日志", exact: true })
        .fill("测试错误输出");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".log-line").length === 1 &&
          document
            .querySelector(".log-line")
            .textContent.includes("测试错误输出"),
      );
      await page
        .getByRole("textbox", { name: "搜索日志", exact: true })
        .fill("");
    }
    assert.equal(
      await page.getByRole("button", { name: "跟随最新", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "暂停跟随", exact: true }).count(),
      0,
    );
    await fs.writeFile(path.join(runtimeProject, "burst.fixture"), "go");
    await page.getByText("BURST_3499", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector(".log-console");
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    });
    const anchor = await page.locator(".log-console").evaluate((el) => {
      el.scrollTop = el.scrollHeight / 3;
      el.dispatchEvent(new Event("scroll"));
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-log-id]")].find(
        (r) => r.getBoundingClientRect().bottom > top,
      );
      return {
        id: row.dataset.logId,
        offset: row.getBoundingClientRect().top - top,
      };
    });
    await page
      .getByText("已暂停跟随，滚动到底部继续", { exact: true })
      .waitFor();
    await fs.writeFile(path.join(runtimeProject, "tail.fixture"), "go");
    await page.getByText("TAIL_29", { exact: true }).waitFor();
    const offset = await page
      .locator(".log-console")
      .evaluate(
        (el, id) =>
          el.querySelector('[data-log-id="' + id + '"]').getBoundingClientRect()
            .top - el.getBoundingClientRect().top,
        anchor.id,
      );
    assert.ok(
      Math.abs(offset - anchor.offset) < 3,
      "visible anchor is preserved after log eviction",
    );
    await page.getByRole("button", { name: "一键到底", exact: true }).click();
    await page.getByText("自动跟随最新日志", { exact: true }).waitFor();
    await fs.writeFile(path.join(runtimeProject, "again.fixture"), "go");
    await page.getByText("AGAIN_29", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const el = document.querySelector(".log-console");
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    });
    assert.ok((await page.locator(".log-line").count()) <= 2000);
    await page.getByRole("button", { name: "清空显示", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".log-line").length === 0,
    );
    await page.getByRole("button", { name: "导出日志", exact: true }).click();
    await page.waitForFunction(() =>
      document.body.textContent.includes("日志已导出"),
    );
    assert.match(
      await fs.readFile(path.join(root, "export.log"), "utf8"),
      /测试启动成功/,
    );
    assert.match(
      await fs.readFile(path.join(root, "export.log"), "utf8"),
      /BURST_3499/,
    );
    for (const sample of colorSamples)
      assert.ok(
        (await fs.readFile(path.join(root, "export.log"), "utf8")).includes(
          sample,
        ),
      );
    const historyDirectory = path.join(root, "profile", "logs");
    async function seedHistory(name) {
      const id = randomUUID();
      await fs.writeFile(
        path.join(historyDirectory, id + ".json"),
        JSON.stringify({
          id,
          projectName: name,
          startedAt: "2026-10-01T00:00:00Z",
        }),
      );
      await fs.writeFile(
        path.join(historyDirectory, id + ".log"),
        "[2026-10-01T00:00:00Z] [stdout] old fixture log\n",
      );
      return id;
    }
    for (let i = 0; i < 105; i++) await seedHistory("旧日志 " + i);
    const liveId = await page.evaluate(
      async () => (await window.toolkit.call("launch.state")).session.id,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "删除选中历史日志", exact: true })
        .isDisabled(),
      true,
    );
    const cleanupButton = page.getByRole("button", {
      name: "清理全部已结束日志",
      exact: true,
    });
    await cleanupButton.click();
    await page
      .getByRole("dialog")
      .getByText(/105 份历史日志/)
      .waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(
      (await fs.readdir(historyDirectory)).filter((n) => n.endsWith(".log"))
        .length,
      106,
    );
    await cleanupButton.click();
    await page
      .getByRole("dialog")
      .getByText(/105 份历史日志/)
      .waitFor();
    const createdAfterPreview = await seedHistory("确认后新日志");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "已删除 105 份历史日志" })
      .waitFor();
    assert.equal(
      (await fs.readdir(historyDirectory)).filter((n) => n.endsWith(".log"))
        .length,
      2,
    );
    await fs.access(path.join(historyDirectory, createdAfterPreview + ".log"));
    assert.match(
      await fs.readFile(path.join(historyDirectory, liveId + ".log"), "utf8"),
      /测试启动成功/,
    );
    assert.equal(
      await page.evaluate(
        async () => (await window.toolkit.call("launch.state")).session.running,
      ),
      true,
    );
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("会话已停止", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新历史", exact: true }).click();
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /游戏项目/ }).click();
    await page.getByText("BURST_3499", { exact: true }).waitFor();
    const archivedColor = page
      .locator(".log-line")
      .filter({ hasText: "HISTORY_COLOR" });
    assert.equal(
      await archivedColor
        .locator(".log-token-tags")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(129, 239, 102)",
    );
    await nav("设置");
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    await nav("运行日志");
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /游戏项目/ }).click();
    await page
      .locator(".log-line")
      .filter({ hasText: "HISTORY_COLOR" })
      .waitFor();
    assert.equal(
      await page
        .locator(".log-console")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgb(18, 19, 20)",
    );
    assert.equal(
      await page
        .locator(".log-line")
        .filter({ hasText: "HISTORY_COLOR" })
        .locator(".log-token-number")
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(174, 129, 255)",
    );
    assert.equal(
      await page.locator('.log-session-card[aria-pressed="true"]').count(),
      0,
    );
    await page.locator(".log-session-card").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".log-session-card")
          ?.getAttribute("aria-pressed") === "true",
    );
    assert.equal(
      await page.locator(".logs-session-name").textContent(),
      "游戏项目 · 已结束",
    );
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /游戏项目/ }).click();
    await page
      .getByRole("button", { name: "删除选中历史日志", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await fs.access(path.join(historyDirectory, liveId + ".log"));
    await page
      .getByRole("button", { name: "删除选中历史日志", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "永久删除历史日志", exact: true })
      .waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const cleanupScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      "test-results/log-delete-confirm.png",
      Buffer.from(cleanupScreenshot, "base64"),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "已删除 1 份历史日志" })
      .waitFor();
    for (const ext of ["log", "json"])
      await assert.rejects(
        fs.access(path.join(historyDirectory, liveId + "." + ext)),
        { code: "ENOENT" },
      );
    assert.equal(await page.locator(".log-line").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "导出日志", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("logs.history"))).length,
      1,
    );
    await page
      .getByRole("button", { name: "游戏调试日志", exact: true })
      .click();
    await page.getByRole("button", { name: "刷新历史", exact: true }).click();
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /游戏项目/ }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "NATIVE_CONTENT" })
      .waitFor();
    await page
      .getByRole("button", { name: "删除选中历史日志", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认永久删除", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "已删除 1 份历史日志" })
      .waitFor();
    assert.equal(
      (
        await page.evaluate(() =>
          window.toolkit.call("logs.history", { channel: "game" }),
        )
      ).length,
      0,
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("logs.history"))).length,
      1,
    );
    assert.equal(
      (
        await fs.readdir(
          path.join(runtimeProject, "game-data/MinecraftPE_Netease/logs"),
        )
      ).length,
      2,
    );
    await nav("存档");
    await fs.mkdir("test-results", { recursive: true });
    const screenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      "test-results/launcher.png",
      Buffer.from(screenshot, "base64"),
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
              () =>
                reject(
                  Error("Test application did not exit within 20 seconds"),
                ),
              20000,
            );
          }),
        ]);
      } catch (error) {
        const child = app.process();
        if (child.exitCode === null && Number.isInteger(child.pid)) {
          spawnSync(
            path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10000 },
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("dgn-game-ui-")
    )
      throw Error("Unsafe cleanup");
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    "PASS logs UI including clean exit: colors, follow, clear/export/history, selected/bulk deletion, confirmation cancellation, >100 histories, live/later logs protected, owned-session stop, theme and settings",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
