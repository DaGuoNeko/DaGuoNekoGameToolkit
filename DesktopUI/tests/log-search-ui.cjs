const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { WorkspaceStore } = require("../electron/services.cjs");
const { SessionHistory } = require("../electron/history.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-log-search-ui-"));
  let app;
  try {
    const store = new WorkspaceStore(root);
    await store.load();
    const id = crypto.randomUUID(),
      h = new SessionHistory(path.join(root, "logs/game"), () => {});
    await h.begin({
      id,
      projectName: "内容错误复现",
      startedAt: new Date().toISOString(),
    });
    for (const text of [
      '[Json][error]-Invalid aux value in item ID "minecraft:flower_pot:*minecraft:frame:*"',
      '[Json][error]-Excessive number of tokens in item ID "minecraft:flower_pot:*minecraft:frame:*"',
      "[Actor][error]-minecraft:input_air_controlled was not parsed.",
    ])
      h.append({ time: new Date().toISOString(), stream: "content", text });
    h.append({
      time: new Date().toISOString(),
      stream: "content",
      text: "literal <img src=x> a.*[b] 中文",
    });
    for (let n = 0; n < 4505; n++)
      h.append({
        time: new Date().toISOString(),
        stream: "engine",
        text: "noisy-engine " + n,
      });
    await h.finish();
    const importantId = crypto.randomUUID();
    await h.begin({
      id: importantId,
      projectName: "重要日志去重复现",
      startedAt: new Date().toISOString(),
    });
    const importantProblems = [
      "[Json][error]-Invalid aux value",
      "[Json][error]-Excessive number of tokens",
      "[Actor][error]-input_air_controlled was not parsed",
    ];
    for (let i = 0; i < 3; i++)
      for (let n = 0; n < [2, 2, 6][i]; n++)
        h.append({
          time: new Date().toISOString(),
          stream: "content",
          text: `12:00:0${n}` + importantProblems[i],
        });
    for (let n = 0; n < 2100; n++)
      h.append({
        time: new Date().toISOString(),
        stream: "content",
        text: "12:00:00[Json][inform]-normal error count 0",
      });
    await h.finish();
    const script = new SessionHistory(path.join(root, "logs"), () => {});
    await script.begin({
      id,
      projectName: "脚本搜索",
      startedAt: new Date().toISOString(),
    });
    script.append({
      time: new Date().toISOString(),
      stream: "stdout",
      text: "script only",
    });
    await script.finish();
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: { ...process.env, DGN_GAME_DATA_DIR: root, DGN_GAME_HEADLESS: "1" },
    });
    const page = await app.firstWindow(),
      errors = [];
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    const capture = async (file) => {
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          )
        )
          .toPNG()
          .toString("base64"),
      );
      await fs.writeFile(file, Buffer.from(png, "base64"));
    };
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(20000);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "运行日志", exact: true })
      .click();
    const input = page.getByRole("textbox", { name: "搜索日志", exact: true });
    await input.waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "脚本日志", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    assert.match(
      await page
        .getByRole("combobox", { name: "日志类型", exact: true })
        .textContent(),
      /全部/,
    );
    await page
      .getByRole("button", { name: "游戏调试日志", exact: true })
      .click();
    assert.match(await page.getByRole("combobox", {name:"日志类型",exact:true}).textContent(), /重要日志/);
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /重要日志去重复现/ }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".log-repeat-count").length === 3,
    );
    assert.equal(await page.locator(".log-line").count(), 3);
    assert.deepEqual(
      await page.locator(".log-repeat-count").allTextContents(),
      ["×2", "×2", "×6"],
    );
    assert.match(await page.locator(".logs-count").textContent(), /共 10 次/);
    await fs.mkdir("test-results", { recursive: true });
    await capture("test-results/important-logs-default.png");
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /内容错误复现/ }).click();
    await page
      .locator(".log-text")
      .filter({ hasText: "Invalid aux value" })
      .waitFor();
    assert.equal(await page.locator(".log-line").count(), 3);
    await page.getByRole("combobox", { name: "日志类型", exact: true }).click();
    await page
      .getByRole("option", { name: "原版内容日志", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".log-line").length === 4,
    );
    await page
      .getByRole("button", { name: "收起日志设置", exact: true })
      .click();
    await page.keyboard.press("Control+f");
    assert(await input.evaluate((el) => el === document.activeElement));
    await input.fill("flower_pot");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".log-line").length === 2 &&
        document.querySelectorAll(".log-text mark").length >= 2,
    );
    await page.getByRole("button", { name: "上一条", exact: true }).click();
    assert.match(
      await page.locator(".log-search-current").textContent(),
      /Invalid aux/,
    );
    await input.press("Enter");
    assert.match(
      await page.locator(".log-search-current").textContent(),
      /Excessive number/,
    );
    await input.press("Shift+Enter");
    assert.match(
      await page.locator(".log-search-current").textContent(),
      /Invalid aux/,
    );
    await input.fill("FLOWER_POT");
    await page.locator(".log-text mark").first().waitFor();
    await page.getByRole("button", { name: "区分大小写", exact: true }).click();
    await page.getByText("暂无匹配的日志", { exact: true }).waitFor();
    await page.getByRole("button", { name: "区分大小写", exact: true }).click();
    await page.locator(".log-text mark").first().waitFor();
    await input.fill("input_air_controlled");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".log-line").length === 1 &&
        document.querySelector(".log-text mark")?.textContent ===
          "input_air_controlled",
    );
    await fs.mkdir("test-results", { recursive: true });
    await capture("test-results/log-search-screenshot-error.png");
    await input.fill("a.*[b]");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".log-text mark")]
          .map((el) => el.textContent)
          .join("") === "a.*[b]",
    );
    assert.equal(await page.locator(".log-console img").count(), 0);
    await input.fill("中文");
    await page.locator("mark").filter({ hasText: "中文" }).waitFor();
    await input.press("Escape");
    assert.equal(await input.inputValue(), "");
    await page.getByRole("combobox", { name: "日志类型", exact: true }).click();
    await page
      .getByRole("option", { name: "原版引擎日志", exact: true })
      .click();
    await input.fill("noisy-engine");
    await page.waitForFunction(
      () => document.querySelectorAll(".log-line").length === 2000,
    );
    const newestFirst = await page
      .locator(".log-line")
      .first()
      .getAttribute("data-log-id");
    await page.getByRole("button", { name: "更早记录", exact: true }).click();
    await page.waitForFunction(
      (id) => document.querySelector(".log-line")?.dataset.logId !== id,
      newestFirst,
    );
    const middleFirst = await page
      .locator(".log-line")
      .first()
      .getAttribute("data-log-id");
    assert(Number(middleFirst) < Number(newestFirst));
    await page.getByRole("button", { name: "更早记录", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".log-line").length === 505,
    );
    assert(
      await page
        .getByRole("button", { name: "更早记录", exact: true })
        .isDisabled(),
    );
    await page.getByRole("button", { name: "较新记录", exact: true }).click();
    await page.waitForFunction(
      (id) => document.querySelector(".log-line")?.dataset.logId === id,
      middleFirst,
    );
    await page.getByRole("button", { name: "脚本日志", exact: true }).click();
    await page
      .getByRole("button", { name: "展开日志设置", exact: true })
      .click();
    await page.getByRole("combobox", { name: "日志会话", exact: true }).click();
    await page.getByRole("option", { name: /脚本搜索/ }).click();
    await input.fill("script only");
    await page
      .locator(".log-text mark")
      .filter({ hasText: "script only" })
      .waitFor();
    assert.equal(await page.locator(".log-line").count(), 1);
    assert.deepEqual(errors, []);
    console.log(
      "PASS full archive search UI: screenshot errors before tail, highlights, keyboard navigation, literal/Unicode/case search, pagination and channel isolation",
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-log-search-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
