// 显式执行的联网验收：只读取公开 Release，不需要用户授权。
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
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
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
    await page.waitForFunction(
      () => !document.documentElement.dataset.pageAnimating,
    );
    await page
      .getByRole("heading", { name: "工具箱更新", exact: true })
      .evaluate((element) =>
        element
          .closest("section")
          .scrollIntoView({ block: "start", behavior: "instant" }),
      );
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
