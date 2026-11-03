const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { WorkspaceStore } = require("../electron/services.cjs");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-debug-ui-"));
  let app;
  try {
    const project = path.join(root, "project"),
      profile = path.join(root, "profile");
    await fs.mkdir(path.join(project, "testScripts"), { recursive: true });
    await fs.writeFile(
      path.join(project, "testScripts/modMain.py"),
      "def hello(value=1):\n return value\n",
    );
    await fs.writeFile(
      path.join(project, "manifest.json"),
      JSON.stringify({
        header: { uuid: "fixture", version: [1, 0, 0] },
        modules: [{ type: "data" }],
      }),
    );
    const game = path.join(root, "Game.exe"),
      runtime = path.join(root, "BridgeFixture.exe");
    await fs.writeFile(game, "fixture not executed");
    const fixture = path.resolve("tests/fixtures/debug-runtime.cjs");
    const csharp = path.join(root, "Fixture.cs");
    await fs.writeFile(
      csharp,
      `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + fixture + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Console.Error.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();}}`,
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
    const store = new WorkspaceStore(profile);
    await store.load();
    await store.addProject(project);
    await store.updateSettings({ LauncherPath: runtime });
    await store.saveProject(store.value.projects[0].id, null, {
      game_executable_path: game,
    });
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: profile,
      },
    });
    const page = await app.firstWindow();
    await require("./fixtures/mock-menu-name.cjs")(app);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    const nativeVersion = await app.evaluate(({ app }) => {
      const directory =
        (app.isPackaged ? process.resourcesPath : app.getAppPath()) +
        "/runtime/native/";
      const koffi = process.mainModule.require(directory + "koffi.node");
      const library = koffi.load(directory + "mcdev-tracy-bridge.dll");
      try {
        return {
          api: library.func("uint32_t mcdev_tracy_api_version()")(),
          protocol: library.func(
            "const char *mcdev_tracy_protocol_version()",
          )(),
        };
      } finally {
        library.unload();
      }
    });
    assert.deepEqual(nativeVersion, { api: 1, protocol: "0.11.1" });
    page.setDefaultTimeout(20000);
    const closePopout = async () => {
      await page
        .getByRole("button", { name: "收回工具箱", exact: true })
        .click();
    };
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const nav = async (name) => {
      const navigationStarted = Date.now();
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.getByRole("heading", { name, exact: true }).waitFor();
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
      if (Date.now() - navigationStarted > 5000)
        console.log(
          "Slow test navigation",
          name,
          Date.now() - navigationStarted,
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
    await page.getByRole("button", { name: "热更新脚本", exact: true }).click();
    await page
      .getByText(/已增量更新 \d+ 个脚本模块|没有检测到已加载脚本的改动/)
      .waitFor();
    await nav("游戏调试");
    await page.getByText("调试就绪", { exact: true }).waitFor();
    await page.getByRole("button", { name: "热更新脚本", exact: true }).click();
    await page
      .getByText(/已增量更新 \d+ 个脚本模块|没有检测到已加载脚本的改动/)
      .waitFor();
    await page.getByRole("button", { name: "重载游戏", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await assert.rejects(fs.stat(path.join(project, "reload.fixture")), {
      code: "ENOENT",
    });
    await page
      .getByRole("button", { name: "重载资源和游戏", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认重载", exact: true })
      .click();
    await page
      .getByText("重载请求已接收，请等待游戏重新就绪。", { exact: true })
      .waitFor();
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(project, "reload.fixture"), "utf8"),
      ).addons,
      true,
    );
    await page.getByRole("button", { name: "执行", exact: true }).click();
    await page.locator(".debug-result pre").filter({ hasText: "2" }).waitFor();
    await page
      .getByRole("textbox", { name: "Python 代码", exact: true })
      .fill('raise ValueError("fixture")');
    await page.getByRole("button", { name: "执行", exact: true }).click();
    await page.getByText("fixture exception", { exact: true }).waitFor();
    await nav("启动配置");
    await nav("游戏调试");
    assert.equal(
      await page
        .getByRole("textbox", { name: "Python 代码", exact: true })
        .inputValue(),
      'raise ValueError("fixture")',
    );
    await page.getByRole("tab", { name: "调试函数", exact: true }).click();
    await page
      .getByRole("button", { name: "扫描模组函数", exact: true })
      .click();
    await page
      .locator(".debug-function-list button")
      .filter({ hasText: "hello" })
      .click();
    await page.getByRole("button", { name: "保存收藏", exact: true }).click();
    await page.getByRole("button", { name: "调用函数", exact: true }).click();
    await page.getByText(/"invoked": true/).waitFor();
    assert.equal(
      await page.getByRole("tab", { name: "UI 调试器", exact: true }).count(),
      0,
    );
    await nav("UI 调试器");
    const freshWindow = app.waitForEvent("window");
    await page.getByRole("button", { name: "展开", exact: true }).click();
    const fresh = await freshWindow;
    fresh.on("pageerror", (e) => errors.push(e.message));
    await fresh.locator(".ui-node").filter({ hasText: /^root/ }).waitFor();
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    assert.equal(
      await fresh.locator(".intro,.debug-session,.inspector-toolbar").count(),
      0,
    );
    assert.equal(
      await fresh
        .getByRole("button", { name: "停止双向选中", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .click();
    await page
      .getByRole("button", { name: "开启双向选中", exact: true })
      .waitFor();
    await page
      .getByRole("checkbox", { name: "显示控件边界", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "自动刷新属性", exact: true })
      .check();
    await page
      .getByRole("button", { name: "开启双向选中", exact: true })
      .click();
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    await page
      .getByRole("checkbox", { name: "自动刷新属性", exact: true })
      .uncheck();
    const popupBounds = await fresh.evaluate(() => {
      const a = document.querySelector(".ui-workbench").getBoundingClientRect();
      return { top: a.top, height: a.height, viewport: innerHeight };
    });
    assert.ok(
      popupBounds.top < 20 && popupBounds.height > popupBounds.viewport - 35,
    );
    await fs.writeFile(
      path.join(project, "screens.fixture"),
      JSON.stringify(["hud_screen", "inventory_screen"]),
    );
    await page.getByRole("button", { name: "刷新屏幕", exact: true }).click();
    await page.getByRole("combobox", { name: "UI 屏幕", exact: true }).click();
    await page
      .getByRole("option", { name: "inventory_screen", exact: true })
      .click();
    await fresh.waitForFunction(async () => {
      const s = await window.toolkit.call("inspector.state");
      return s.caches.some(([, v]) => v.screen === "inventory_screen");
    });
    await page.getByRole("combobox", { name: "UI 屏幕", exact: true }).click();
    await page.getByRole("option", { name: "hud_screen", exact: true }).click();
    await fresh.waitForFunction(async () => {
      const s = await window.toolkit.call("inspector.state");
      return s.caches.some(([, v]) => v.screen === "hud_screen");
    });
    await closePopout(fresh);
    await page.getByRole("button", { name: "刷新屏幕", exact: true }).click();
    await page.locator(".ui-node").filter({ hasText: /^root/ }).click();
    await page.getByText("root · Panel", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "属性一览", exact: true }).waitFor();
    assert.ok(
      await page
        .getByRole("table", { name: "控件属性一览" })
        .getByText("相对位置", { exact: true })
        .count(),
    );
    await page.getByRole("tab", { name: "分组编辑", exact: true }).click();
    const positionX = page.locator('input[aria-label="位置 X"]');
    const positionY = page.locator('input[aria-label="位置 Y"]');
    await positionX.fill("12");
    await positionY.fill("24");
    await nav("游戏调试");
    await nav("UI 调试器");
    assert.equal(await positionX.inputValue(), "12");
    await page.getByRole("button", { name: "应用位置", exact: true }).click();
    await page.getByText("位置已应用并回读", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "撤销此控件修改", exact: true })
      .click();
    await page.getByText("位置已撤销并回读", { exact: true }).waitFor();
    assert.equal(await positionX.inputValue(), "0");
    await page.getByRole("button", { name: "展开 /root", exact: true }).click();
    await page.getByRole("button", { name: /加载更多 · 还有 170 项/ }).click();
    await page.getByRole("button", { name: /加载更多 · 还有 10 项/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".inspector-tree-row").length === 332,
    );
    await page.getByRole("button", { name: "刷新子控件", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".inspector-tree-row").length === 162,
    );
    await page.getByRole("button", { name: /加载更多 · 还有 170 项/ }).click();
    await page.getByRole("button", { name: /加载更多 · 还有 10 项/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".inspector-tree-row").length === 332,
    );
    await page
      .getByRole("textbox", { name: "搜索已读取控件", exact: true })
      .fill("label329");
    assert.equal(await page.locator(".inspector-tree-row").count(), 1);
    await page.locator(".ui-node").filter({ hasText: "label329" }).click();
    await page.getByText("label329 · Label", { exact: true }).waitFor();
    await page.getByRole("button", { name: "后退", exact: true }).click();
    await page.getByText("root · Panel", { exact: true }).waitFor();
    await positionX.fill("9");
    await page
      .getByRole("textbox", { name: "控件路径", exact: true })
      .fill("/root/label0");
    await page.getByRole("button", { name: "定位路径", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    assert.equal(await positionX.inputValue(), "9");
    await page.getByRole("button", { name: "重置位置", exact: true }).click();
    await page.getByRole("button", { name: "定位路径", exact: true }).click();
    await page.getByText("label0 · Label", { exact: true }).waitFor();
    await app.evaluate(({ clipboard }) => {
      globalThis.savedClipboardWrite = clipboard.writeText;
      clipboard.writeText = (value) => {
        globalThis.copiedUiPath = value;
      };
    });
    try {
      await page.getByRole("button", { name: "复制路径", exact: true }).click();
      assert.equal(
        await app.evaluate(() => globalThis.copiedUiPath),
        "/root/label0",
      );
    } finally {
      await app.evaluate(({ clipboard }) => {
        clipboard.writeText = globalThis.savedClipboardWrite;
      });
    }
    await positionX.fill("20");
    await fs.writeFile(
      path.join(project, "external-position.json"),
      JSON.stringify({ path: "/root/label0", value: [8, 0] }),
    );
    await page.getByRole("button", { name: "应用位置", exact: true }).click();
    await page
      .getByText("属性已在游戏中变化。请刷新，并重置该属性的草稿后再修改。", {
        exact: true,
      })
      .waitFor();
    assert.equal(await positionX.inputValue(), "20");
    await page.getByRole("button", { name: "刷新属性", exact: true }).click();
    await page.getByRole("button", { name: "重置位置", exact: true }).click();
    assert.equal(await positionX.inputValue(), "8");
    await fs.writeFile(path.join(project, "delay-mutation.fixture"), "delay");
    await positionX.fill("10");
    await page.getByRole("button", { name: "应用位置", exact: true }).click();
    await nav("游戏调试");
    await nav("UI 调试器");
    await fs.writeFile(
      path.join(project, "release-mutation.fixture"),
      "release",
    );
    await page.getByText("位置已应用并回读", { exact: true }).waitFor();
    assert.equal(await positionX.inputValue(), "10");
    await page
      .getByRole("button", { name: "开启双向选中", exact: true })
      .click();
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    await nav("游戏调试");
    await page.waitForFunction(async () => {
      const state = await window.toolkit.call("debug.state");
      return state.pickers.length === 0;
    });
    await nav("UI 调试器");
    assert.equal(await positionX.inputValue(), "10");
    await fs.writeFile(
      path.join(project, "delay-node.json"),
      JSON.stringify({
        path: "/root/label1",
        waitFile: "release-node.fixture",
      }),
    );
    await page
      .getByRole("textbox", { name: "控件路径", exact: true })
      .fill("/root/label1");
    await page.getByRole("button", { name: "定位路径", exact: true }).click();
    await nav("游戏调试");
    await nav("UI 调试器");
    await fs.writeFile(path.join(project, "release-node.fixture"), "release");
    await page.getByRole("button", { name: "刷新属性", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".inspector-selection strong")?.textContent ===
          "label0 · Label" &&
        !document
          .querySelector(".inspector-status")
          ?.textContent.includes("刷新属性…"),
    );
    await page
      .getByRole("textbox", { name: "控件路径", exact: true })
      .fill("/root/label0");
    await fs.mkdir(testResultsRoot, { recursive: true });
    const inspectorScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
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
      path.join(testResultsRoot, "ui-inspector.png"),
      Buffer.from(inspectorScreenshot, "base64"),
    );
    // A separate native window owns the inspector while the main window is suspended.
    await positionX.fill("41");
    const opened = app.waitForEvent("window");
    await page.getByRole("button", { name: "展开", exact: true }).click();
    const popup = await opened;
    popup.setDefaultTimeout(20000);
    popup.on("pageerror", (e) => errors.push(e.message));
    await popup.emulateMedia({ reducedMotion: "reduce" });
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    assert.equal(
      await popup.getByLabel("位置 X", { exact: true }).inputValue(),
      "41",
    );
    await page.getByText(/独立调试窗口正在使用/).waitFor();
    await page.getByRole("combobox", { name: "UI 屏幕", exact: true }).click();
    await page
      .getByRole("option", { name: "inventory_screen", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    assert.equal(
      await popup.getByLabel("位置 X", { exact: true }).inputValue(),
      "41",
    );
    assert.equal(await page.locator(".ui-node").count(), 0);
    await page
      .getByRole("button", { name: "显示调试窗口", exact: true })
      .click();
    assert.equal(app.windows().length, 2);
    assert.match(
      await popup.evaluate(async () => {
        try {
          await window.toolkit.call("launch.stop");
          return "allowed";
        } catch (e) {
          return e.message;
        }
      }),
      /不支持/,
    );
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes("inspector=1"))
            .webContents.getLastWebPreferences().sandbox,
      ),
      true,
    );
    // A late cleanup from the old editor must not disable the new window's picker.
    await page.evaluate(async () => {
      const state = await window.toolkit.call("debug.state");
      const s = state.sessions[0];
      await window.toolkit.call("debug.ui", {
        sessionId: s.id,
        generation: s.connectionGeneration,
        action: "picker-stop",
      });
    });
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    await popup.getByRole("button", { name: "重置位置", exact: true }).click();
    await popup.getByRole("tab", { name: "属性一览", exact: true }).click();
    await fs.writeFile(path.join(project, "delay-visible.fixture"), "delay");
    await popup
      .getByRole("button", { name: "隐藏 /root/label0", exact: true })
      .click();
    await popup
      .getByRole("button", { name: "显示 /root/label0", exact: true })
      .waitFor();
    assert.equal(
      await popup
        .getByRole("button", { name: "显示 /root/label0", exact: true })
        .isEnabled(),
      false,
    );
    await fs.writeFile(
      path.join(project, "release-visible.fixture"),
      "release",
    );
    await popup.getByText("label0 已隐藏", { exact: true }).waitFor();
    assert.equal(
      await popup
        .getByRole("row")
        .filter({
          has: popup.getByRole("rowheader", { name: "可见", exact: true }),
        })
        .getByRole("cell")
        .textContent(),
      "否",
    );
    await popup
      .getByRole("button", { name: "显示 /root/label0", exact: true })
      .click();
    await popup
      .getByRole("button", { name: "隐藏 /root/label0", exact: true })
      .waitFor();
    await popup.getByText("label0 已显示", { exact: true }).waitFor();
    await fs.writeFile(path.join(project, "fail-visible.fixture"), "reject");
    await popup
      .getByRole("button", { name: "隐藏 /root/label0", exact: true })
      .click();
    await popup
      .getByText("fixture visibility rejected", { exact: true })
      .waitFor();
    await popup
      .getByRole("button", { name: "隐藏 /root/label0", exact: true })
      .waitFor();
    await fs.writeFile(
      path.join(project, "delay-node.json"),
      JSON.stringify({
        path: "/root/label1",
        waitFile: "release-fast-selection.fixture",
      }),
    );
    await popup
      .locator(".ui-node")
      .filter({ hasText: /^label1文本$/ })
      .click();
    assert.equal(
      await popup
        .locator("[role=treeitem][aria-selected=true] .ui-node strong")
        .textContent(),
      "label1",
    );
    await popup.getByText("正在读取控件属性", { exact: true }).waitFor();
    assert.equal(await popup.locator(".inspector-selection").count(), 0);
    await popup
      .locator(".ui-node")
      .filter({ hasText: /^label2文本$/ })
      .click();
    await popup
      .locator(".ui-node")
      .filter({ hasText: /^label3文本$/ })
      .click();
    assert.equal(
      await popup
        .locator("[role=treeitem][aria-selected=true] .ui-node strong")
        .textContent(),
      "label3",
    );
    await fs.writeFile(
      path.join(project, "release-fast-selection.fixture"),
      "release",
    );
    await popup.getByText("label3 · Label", { exact: true }).waitFor();
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(project, "highlight.json"), "utf8"),
      ).path,
      "/root/label3",
    );
    await popup
      .locator(".ui-node")
      .filter({ hasText: /^label2文本$/ })
      .click();
    await popup.getByText("label2 · Label", { exact: true }).waitFor();
    assert.equal(
      JSON.parse(
        await fs.readFile(path.join(project, "highlight.json"), "utf8"),
      ).path,
      "/root/label2",
    );
    await fs.writeFile(
      path.join(project, "game-pick.json"),
      JSON.stringify(["selected", "hud_screen", "/hud_screen/root/label329"]),
    );
    await popup.getByText("label329 · Label", { exact: true }).waitFor();
    assert.equal(
      await popup
        .locator("[role=treeitem][aria-selected=true] .ui-node strong")
        .textContent(),
      "label329",
    );
    await popup
      .getByRole("textbox", { name: "搜索属性", exact: true })
      .fill("大小");
    assert.ok(
      await popup.getByRole("rowheader", { name: "大小", exact: true }).count(),
    );
    await popup
      .getByRole("textbox", { name: "搜索属性", exact: true })
      .fill("");
    await popup.getByRole("tab", { name: "分组编辑", exact: true }).click();
    await popup.getByLabel("位置 X", { exact: true }).fill("55");
    // Native X returns even unapplied drafts without stopping the game.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("inspector=1"))
        .close(),
    );
    await page.getByText("label329 · Label", { exact: true }).waitFor();
    assert.equal(await positionX.inputValue(), "55");
    assert.equal(app.windows().length, 1);
    assert.equal(
      await page.evaluate(async () => {
        const s = await window.toolkit.call("debug.state");
        return s.sessions[0].state;
      }),
      "game_ready",
    );
    const reopened = app.waitForEvent("window");
    await page.getByRole("button", { name: "展开", exact: true }).click();
    const popup2 = await reopened;
    await page
      .getByRole("button", { name: "停止双向选中", exact: true })
      .waitFor();
    assert.equal(
      await popup2.getByLabel("位置 X", { exact: true }).inputValue(),
      "55",
    );
    await popup2.getByRole("button", { name: "重置位置", exact: true }).click();
    await popup2.getByRole("tab", { name: "属性一览", exact: true }).click();
    // Check compact side-by-side layout at the minimum supported window width.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes("inspector=1"))
        .setContentSize(760, 720),
    );
    const bounds = await popup2.evaluate(() => {
      const a = document
          .querySelector(".inspector-tree-panel")
          .getBoundingClientRect(),
        b = document
          .querySelector(".inspector-details")
          .getBoundingClientRect();
      return {
        a: { right: a.right, top: a.top, bottom: a.bottom },
        b: { left: b.left, top: b.top, bottom: b.bottom },
        height: innerHeight,
        width: innerWidth,
        scroll: document.querySelector(".inspector-popout").scrollWidth,
      };
    });
    assert.ok(
      bounds.a.right <= bounds.b.left &&
        Math.abs(bounds.a.top - bounds.b.top) < 1,
    );
    assert.ok(
      bounds.b.bottom <= bounds.height && bounds.scroll <= bounds.width,
    );
    const popoutScreenshot = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes("inspector=1"))
          .webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
      )
        .toPNG()
        .toString("base64"),
    );
    await fs.writeFile(
      path.join(testResultsRoot, "ui-inspector-popout.png"),
      Buffer.from(popoutScreenshot, "base64"),
    );
    await closePopout(popup2);
    await page.getByText("label329 · Label", { exact: true }).waitFor();
    await nav("游戏调试");
    for (const tab of ["Python 性能", "Python 内存"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await page.getByLabel("采样时长（秒）", { exact: true }).fill("1");
      await page.getByRole("button", { name: "开始采样", exact: true }).click();
      await page.getByText("报告已生成", { exact: true }).waitFor();
      assert.ok((await page.locator(".profile-table tbody tr").count()) > 0);
    }
    await page.getByRole("tab", { name: "Native 性能", exact: true }).click();
    await page.getByRole("button", { name: "开始采样", exact: true }).click();
    await page.getByText(/该游戏进程没有 Tracy/).waitFor();
    await nav("运行日志");
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("会话已停止", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } catch (error) {
    if (app) {
      const window = app.windows()[0];
      if (window && !window.isClosed())
        console.error(
          "DEBUG UI FAILURE STATE",
          await window.evaluate(() => ({
            rows: document.querySelectorAll(".inspector-tree-row").length,
            status: document.querySelector(".inspector-status")?.textContent,
            errors: [...document.querySelectorAll(".error-box")].map(
              (x) => x.textContent,
            ),
            more: [...document.querySelectorAll(".inspector-more")].map(
              (x) => x.textContent,
            ),
            selected: document.querySelector(".inspector-selection")
              ?.textContent,
          })),
        );
    }
    throw error;
  } finally {
    if (app) {
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error("debug UI application exit timed out")),
              20000,
            );
          }),
        ]);
      } catch (error) {
        const child = app.process();
        if (child.exitCode === null)
          spawnSync(
            path.join(process.env.SystemRoot, "System32/taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true },
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-debug-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    "PASS debug UI: authenticated session, code/results/errors/drafts, function discovery/save/invoke, UI tree/properties/picker, Python CPU/memory, Native endpoint error, disconnect and clean exit",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
