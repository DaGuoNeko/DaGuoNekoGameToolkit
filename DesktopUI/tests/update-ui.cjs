const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-update-ui-"));
  const control = path.join(root, "mode.txt");
  let app;
  const errors = [],
    stderr = [];
  try {
    await fs.writeFile(control, "available", "utf8");
    app = await electron.launch({
      args: ["tests/fixtures/update-ui-entry.cjs"],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: root,
        DGN_UPDATE_FIXTURE_CONTROL: control,
      },
    });
    app.process().stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "发现新版本", exact: true })
      .waitFor();
    assert.match(await page.locator("body").innerText(), /99\.0\.0/);
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/update-popup.png" });
    await page.getByRole("button", { name: "去设置下载", exact: true }).click();
    const history = page.getByLabel("GitHub 更新历史", { exact: true });
    await history.waitFor();
    assert.equal(await history.locator("details").count(), 30);
    await page
      .getByRole("button", { name: "加载更早版本", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[aria-label="GitHub 更新历史"] details')
          .length === 31,
    );
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.waitForFunction(
      async () =>
        (await window.toolkit.call("update.state")).phase === "available",
    );
    assert.equal(
      await page
        .getByRole("heading", { name: "发现新版本", exact: true })
        .count(),
      0,
      "same version must not interrupt twice",
    );
    await page
      .getByRole("heading", { name: "工具箱更新", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/update-history-dark.png" });
    await page.evaluate(() =>
      window.toolkit.call("settings.update", { AppearanceMode: "Light" }),
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    await page.screenshot({ path: "test-results/update-history-light.png" });
    await fs.writeFile(control, "empty", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page
      .getByText("暂时没有可用的正式版本。", { exact: true })
      .waitFor();
    assert.equal(await history.count(), 0);
    await fs.writeFile(control, "denied", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText(/更新服务请求失败|暂时没有可用的正式版本/).waitFor();
    await fs.writeFile(control, "current", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("当前已是最新正式版本。", { exact: true }).waitFor();
    const isolated = await page.evaluate(() => ({
      require: typeof window.require,
      node: typeof window.process,
      token: window.toolkit.token,
    }));
    assert.deepEqual(isolated, {
      require: "undefined",
      node: "undefined",
      token: undefined,
    });
    const lastCheck = await page.evaluate(async () => (await window.toolkit.call("update.state")).checkedAt);
    await page.clock.install();
    await page.reload();
    await page.waitForFunction(async (previous) => {
      const state = await window.toolkit.call("update.state");
      return state.phase === "up-to-date" && state.checkedAt !== previous;
    }, lastCheck);
    await fs.writeFile(control, "future", "utf8");
    await page.clock.fastForward(6 * 60 * 60 * 1000);
    await page.getByRole("heading", { name: "发现新版本", exact: true }).waitFor();
    assert.match(await page.locator("body").innerText(), /99\.0\.1/);
    await page.getByRole("button", { name: "稍后处理", exact: true }).click();
    await page.clock.fastForward(6 * 60 * 60 * 1000);
    await page.waitForFunction(async () => (await window.toolkit.call("update.state")).phase === "available");
    assert.equal(await page.getByRole("heading", { name: "发现新版本", exact: true }).count(), 0);
    assert.equal(await history.count(), 0);
    assert.deepEqual(errors, []);
    assert(
      !stderr.some((line) =>
        /UnhandledPromiseRejection|Uncaught|Error occurred in handler/.test(
          line,
        ),
      ),
      stderr.join(""),
    );
    await fs.writeFile(
      "test-results/update-ui-result.json",
      JSON.stringify(
        {
          passed: true,
          rendererErrors: errors,
          scenarios: [
            "startup popup",
            "six-hour automatic popup",
            "history pagination",
            "manual check",
            "deduplication",
            "light/dark",
            "no releases",
            "public feed errors",
            "current version",
            "sandbox",
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(
      "PASS update UI through real IPC/service: startup popup, history, pagination, errors, themes, sandbox",
    );
  } catch (error) {
    console.error("Update UI failed:", error.message, stderr.join(""));
    throw error;
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-update-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
