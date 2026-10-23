// First-run package check: no copied user data or Node/Python on the app's PATH.
const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
(async () => {
  const executable = process.env.DGN_GAME_TEST_EXE;
  assert(
    executable && path.isAbsolute(executable),
    "Use the extracted distribution EXE",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-distribution-"));
  let app;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(PATH|DGN_|MCDEV_|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(key),
      ),
    );
    env.PATH =
      path.join(process.env.SystemRoot, "System32") +
      ";" +
      process.env.SystemRoot;
    Object.assign(env, { DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root });
    const open = async () => {
      app = await electron.launch({
        executablePath: executable,
        args: [],
        env,
      });
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
          false,
        ),
      );
      await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
      return page;
    };
    let page = await open();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const initial = await page.evaluate(() => window.toolkit.call("bootstrap"));
    assert.equal(initial.projects.length, 1);
    assert.equal(initial.projects[0].name, "默认配置");
    assert(
      initial.projects[0].root.toLowerCase().startsWith(root.toLowerCase()),
    );
    const defaults = await page.evaluate(
      (id) => window.toolkit.call("project.read", { id }),
      initial.projects[0].id,
    );
    assert.equal(defaults.config.game_executable_path, "");
    assert.deepEqual(defaults.config.included_mod_dirs, []);
    assert.equal(initial.settings.GamePath, "");
    assert.equal(initial.settings.LauncherPath, "");
    assert.equal(initial.session, null);
    assert.equal(initial.logs.length, 0);
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("worlds.list"))).worlds
        .length,
      0,
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("logs.history"))).length,
      0,
    );
    assert.equal(
      (
        await page.evaluate(() =>
          window.toolkit.call("logs.history", { channel: "game" }),
        )
      ).length,
      0,
    );
    assert(
      initial.runtime
        .toLowerCase()
        .startsWith(path.dirname(executable).toLowerCase()),
    );
    await fs.access(initial.runtime);
    for (const name of [
      "启动配置",
      "游戏设置",
      "模组库",
      "运行日志",
      "游戏调试",
      "UI 调试器",
      "Tracy 性能",
      "UI 编辑器",
      "设置",
      "关于",
    ]) {
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForFunction(
        (name) =>
          document
            .querySelector(".sidebar button.active")
            ?.getAttribute("aria-label") === name &&
          !document.documentElement.dataset.pageAnimating,
        name,
      );
    }
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "运行日志", exact: true })
      .click();
    await page.getByRole("button", { name: "脚本日志", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "脚本日志", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    const created = await page.evaluate(() =>
      window.toolkit.call("profiles.create", { name: "新用户测试配置" }),
    );
    assert.equal(created.config.game_executable_path, "");
    assert.deepEqual(created.config.included_mod_dirs, []);
    assert(created.project.root.toLowerCase().startsWith(root.toLowerCase()));
    assert.deepEqual(errors, []);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    const width = page.getByLabel("窗口宽度（像素）", { exact: true });
    const height = page.getByLabel("窗口高度（像素）", { exact: true });
    assert.equal(await width.inputValue(), "1280");
    await width.fill("");
    assert.equal(
      await page
        .getByRole("button", { name: "保存窗口大小", exact: true })
        .isDisabled(),
      true,
    );
    await width.fill("1600");
    await height.fill("900");
    await page
      .getByRole("button", { name: "保存窗口大小", exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.toolkit.call("bootstrap")).settings.GameWindowSize
          .width === 1600,
    );
    await app.close();
    app = null;
    page = await open();
    assert.deepEqual(
      (await page.evaluate(() => window.toolkit.call("bootstrap"))).settings
        .GameWindowSize,
      { enabled: true, width: 1600, height: 900 },
    );
    const profiles = await page.evaluate(() =>
      window.toolkit.call("profiles.list"),
    );
    assert.equal(profiles.length, 2);
    assert(
      profiles.some(
        (profile) =>
          profile.id === created.project.id &&
          profile.name === "新用户测试配置",
      ),
    );
    assert.equal(
      (await page.evaluate(() => window.toolkit.call("launch.state"))).sessions
        .length,
      0,
    );
    console.log(
      "PASS extracted distribution: clean first run, empty data, bundled runtime, 11 pages, default script logs, profile persistence, no Node/Python PATH",
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-distribution-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
