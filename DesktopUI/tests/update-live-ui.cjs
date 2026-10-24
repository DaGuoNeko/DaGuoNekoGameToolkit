// 显式执行的联网验收：复用本 Windows 用户已有的加密授权，绝不输出或解密令牌到测试进程。
const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const executablePath = process.env.DGN_GAME_TEST_EXE;
  assert(
    executablePath && path.isAbsolute(executablePath),
    "Set DGN_GAME_TEST_EXE to the packaged client",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-update-live-"));
  let app;
  try {
    await fs.mkdir(path.join(root, "update"));
    await fs.copyFile(
      path.join(
        process.env.LOCALAPPDATA,
        "DaGuoNeko_GameToolkit/update/github-auth.json",
      ),
      path.join(root, "update/github-auth.json"),
    );
    await fs.mkdir(path.join(root, "Electron"));
    await fs.copyFile(
      path.join(
        process.env.LOCALAPPDATA,
        "DaGuoNeko_GameToolkit/Electron/Local State",
      ),
      path.join(root, "Electron/Local State"),
    );
    app = await electron.launch({
      executablePath,
      args: [],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: root,
      },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    const capture = async (file) => {
      const bytes = await app.evaluate(async ({ BrowserWindow }) =>
        (
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          )
        )
          .toPNG()
          .toString("base64"),
      );
      await fs.writeFile(file, Buffer.from(bytes, "base64"));
    };
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    const auth = await page.evaluate(() =>
      window.toolkit.call("update.auth.state"),
    );
    assert(
      auth.authenticated,
      "Saved authorization cannot be reused in the isolated profile",
    );
    const state = await page.evaluate(() =>
      window.toolkit.call("update.check"),
    );
    await fs.mkdir("test-results", { recursive: true });
    await fs.writeFile(
      "test-results/update-live-result.json",
      JSON.stringify(
        {
          currentVersion: state.currentVersion,
          latestVersion: state.latestVersion,
          phase: state.phase,
          checkedAt: state.checkedAt,
          error: state.error,
          historyCount: state.history?.length || 0,
        },
        null,
        2,
      ),
      "utf8",
    );
    if (state.phase === "available") {
      await page
        .getByRole("heading", { name: "发现新版本", exact: true })
        .waitFor();
      await capture("test-results/update-live-popup.png");
      await page
        .getByRole("button", { name: "去设置下载", exact: true })
        .click();
    } else {
      await page
        .locator(".sidebar")
        .getByRole("button", { name: "设置", exact: true })
        .click();
    }
    await page
      .getByRole("heading", { name: "工具箱更新", exact: true })
      .scrollIntoViewIfNeeded();
    await capture("test-results/update-live-history.png");
    assert(
      ["available", "up-to-date"].includes(state.phase),
      state.error || state.phase,
    );
    assert(
      state.history?.length && state.history.some((release) => release.notes),
      "Real GitHub release notes must be present",
    );
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.waitForFunction(
      async () =>
        (await window.toolkit.call("update.state")).phase !== "checking",
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS real GitHub UI: ${state.currentVersion} -> ${state.latestVersion}, ${state.history.length} release entries`,
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-update-live-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
