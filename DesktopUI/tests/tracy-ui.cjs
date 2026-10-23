const { _electron: electron } = require("playwright");
const nativeState = require("./fixtures/native-tracy.cjs");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgtr-"));
  let app, profilerPid;
  try {
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root },
    });
    const page = await app.firstWindow(),
      errors = [];
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "Tracy 性能", exact: true }).click();
    await page.getByRole("heading", { name: "Tracy 性能分析" }).waitFor();
    assert(
      await page.getByRole("button", { name: "连接所选游戏" }).isDisabled(),
    );
    if (process.env.DGN_TRACY_EXE) {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        });
      }, process.env.DGN_TRACY_EXE);
      await page.getByRole("button", { name: "选择 Tracy 程序" }).click();
      await page
        .getByRole("button", { name: "打开分析器", exact: true })
        .click();
      await page
        .getByRole("button", { name: "独立窗口", exact: true })
        .waitFor();
      await page.waitForFunction(() =>
        window.toolkit.call("tracy.state").then((s) => s.phase === "open"),
      );
      const s = await page.evaluate(() => window.toolkit.call("tracy.state"));
      profilerPid = s.pid;
      assert(s.pid > 0);
      assert.equal(s.mode, "embedded");
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.webContents.setBackgroundThrottling(false);
        w.showInactive();
      });
      await page.waitForTimeout(1000);
      const embedded = await nativeState(app, profilerPid);
      assert.equal(embedded.visible, true);
      assert.equal(embedded.owner, embedded.host);
      const originalSize = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0],
          size = w.getSize();
        w.setSize(size[0] + 80, size[1] + 40);
        return size;
      });
      await page.waitForTimeout(600);
      const resized = await nativeState(app, profilerPid);
      assert(
        resized.rect[2] - resized.rect[0] > embedded.rect[2] - embedded.rect[0],
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].minimize(),
      );
      await page.waitForTimeout(400);
      assert.equal((await nativeState(app, profilerPid)).visible, false);
      await app.evaluate(({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.restore();
        w.showInactive();
        w.setSize(...size);
      }, originalSize);
      await page.waitForTimeout(600);
      assert.equal((await nativeState(app, profilerPid)).visible, true);
      await page.getByRole("button", { name: "独立窗口", exact: true }).click();
      await page
        .getByRole("button", { name: "嵌入页面", exact: true })
        .waitFor();
      assert.equal((await nativeState(app, profilerPid)).owner, 0);
      await page.getByRole("button", { name: "嵌入页面", exact: true }).click();
      await page
        .getByRole("button", { name: "独立窗口", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "存档", exact: true }).click();
      await page.waitForTimeout(350);
      assert.equal((await nativeState(app, profilerPid)).visible, false);
      assert.equal(
        (await page.evaluate(() => window.toolkit.call("tracy.state"))).pid,
        profilerPid,
      );
      await page
        .getByRole("button", { name: "Tracy 性能", exact: true })
        .click();
      await page
        .getByRole("button", { name: "独立窗口", exact: true })
        .waitFor();
      await page.waitForTimeout(1000);
      assert.equal((await nativeState(app, profilerPid)).visible, true);
      await fs.mkdir("test-results", { recursive: true });
      await page.screenshot({ path: "test-results/tracy-shell.png" });
      // OS window capture is separate; Chromium screenshots do not contain native windows.
      console.log(
        "NATIVE",
        JSON.stringify({ root, profilerPid, hostPid: app.process().pid }),
      );
      if (process.env.DGN_TRACY_CAPTURE)
        await new Promise((r) => setTimeout(r, 12000));
      await page
        .getByRole("button", { name: "关闭分析器", exact: true })
        .click();
      await page.getByRole("button", { name: "已保存，关闭分析器" }).click();
      await page.waitForFunction(() =>
        window.toolkit.call("tracy.state").then((s) => s.phase === "stopped"),
      );
      profilerPid = null;
      // A second launch verifies native callback types and handles are reusable.
      await page
        .getByRole("button", { name: "打开分析器", exact: true })
        .click();
      await page.waitForFunction(() =>
        window.toolkit.call("tracy.state").then((s) => s.phase === "open"),
      );
      profilerPid = (
        await page.evaluate(() => window.toolkit.call("tracy.state"))
      ).pid;
      await page
        .getByRole("button", { name: "关闭分析器", exact: true })
        .click();
      await page.getByRole("button", { name: "已保存，关闭分析器" }).click();
      await page.waitForFunction(() =>
        window.toolkit.call("tracy.state").then((s) => s.phase === "stopped"),
      );
      profilerPid = null;
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS Tracy UI: no-game page; optional actual official window embed/popout/return, page persistence, confirmed close, reopen",
    );
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit());
      await app.close();
    }
    if (profilerPid)
      console.error(
        "Test-owned profiler preserved after failure; inspect PID",
        profilerPid,
      );
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgtr-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
