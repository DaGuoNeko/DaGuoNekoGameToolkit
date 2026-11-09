const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

const { testResultsRoot } = require("./fixtures/artifacts.cjs");
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
    await fs.mkdir(testResultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(testResultsRoot, "update-popup.png") });
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
    await page.screenshot({ path: path.join(testResultsRoot, "update-history-dark.png") });
    await page.evaluate(() =>
      window.toolkit.call("settings.update", { AppearanceMode: "Light" }),
    );
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "light",
    );
    await page.screenshot({ path: path.join(testResultsRoot, "update-history-light.png") });
    await fs.writeFile(control, "empty", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page
      .getByText("暂时没有可用的正式版本。", { exact: true })
      .waitFor();
    assert.equal(await history.count(), 0);
    await fs.writeFile(control, "denied", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText(/更新服务请求失败|暂时没有可用的正式版本/).waitFor();
    await fs.writeFile(control, "reset", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("net::ERR_CONNECTION_RESET", { exact: true }).waitFor();
    const activity = await page.evaluate(() =>
      window.toolkit.call("activity.snapshot", {}),
    );
    assert(
      activity.events.some(
        (event) =>
          event.method === "update.check" &&
          event.level === "error" &&
          event.message.includes("net::ERR_CONNECTION_RESET"),
      ),
      "update check failures must be recorded in the project log",
    );
    assert.equal(activity.events[0].level, "error", "a failed check must not be marked completed");
    await page.evaluate(() => window.toolkit.call("update.check", { automatic: true }));
    const automatic = await page.evaluate(() => window.toolkit.call("activity.snapshot"));
    assert.equal(automatic.events[0].source, "system");
    assert.equal(automatic.events[0].level, "error");
    await fs.writeFile(control, "history-reset", "utf8");
    await page.evaluate(() => window.toolkit.call("update.history"));
    const historyFailure = await page.evaluate(() => window.toolkit.call("activity.snapshot"));
    assert.equal(historyFailure.events[0].method, "update.history");
    assert.equal(historyFailure.events[0].level, "error");
    assert.match(historyFailure.events[0].message, /net::ERR_CONNECTION_RESET/);
    const untrackedError = await page.evaluate(() =>
      window.toolkit.call("files.pick", { kind: "invalid-fixture" }).catch(error => error.message),
    );
    assert.equal(untrackedError, "不支持的文件类型");
    const failures = await page.evaluate(() => window.toolkit.call("activity.snapshot", { level: "error" }));
    assert(failures.events.some(event => event.method === "files.pick" && event.message.includes(untrackedError)), "untracked IPC failures must also reach the project log");
    await require("./fixtures/navigation.cjs").navigate(page, "项目日志");
    await page.locator(".activity-events").getByText(/net::ERR_CONNECTION_RESET/).first().waitFor();
    await page.locator(".sidebar").getByRole("button", { name: "设置", exact: true }).click();
    const persisted = await fs.readFile(path.join(root, "logs/activity/events.jsonl"), "utf8");
    assert(persisted.split("\n").filter(Boolean).map(line => JSON.parse(line).event).some(event => event?.method === "update.check" && event.level === "error" && event.message.includes("net::ERR_CONNECTION_RESET")), "update failures must be persisted to disk");
    await fs.writeFile(control, "current", "utf8");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("当前已是最新正式版本。", { exact: true }).waitFor();
    // 历史请求成功时不能沿用上次检查的错误。
    await page.evaluate(() => window.toolkit.call("update.history"));
    const historyActivity = await page.evaluate(() => window.toolkit.call("activity.snapshot"));
    assert.equal(historyActivity.events[0].method, "update.history");
    assert.equal(historyActivity.events[0].level, "info");
    const eventCount = await page.evaluate(async () => (await window.toolkit.call("activity.snapshot")).events.length);
    await page.evaluate(() => window.toolkit.call("update.check", { automatic: true }));
    assert.equal(await page.evaluate(async () => (await window.toolkit.call("activity.snapshot")).events.length), eventCount, "successful automatic checks must not add events");
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
      path.join(testResultsRoot, "update-ui-result.json"),
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
            "project log failure recording and persistence",
            "automatic check errors",
            "untracked IPC errors",
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
