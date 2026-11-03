const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { spawnSync } = require("node:child_process");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-options-select-"));
  let app;
  try {
    const file = path.join(
      root,
      "game-data/MinecraftPE_Netease/minecraftpe/options.txt",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original =
      "dev_connection_quality:0\r\ngfx_fullscreen:0\r\ngfx_fancyskies:1\r\ndev_show_latency_graph:0\r\nunknown:preserve\r\n";
    await fs.writeFile(file, original);
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    async function nav(name) {
      await page
        .locator(".sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.waitForFunction(
        () => !document.documentElement.dataset.pageAnimating,
      );
    }
    async function choose(name, label) {
      const control = page.getByRole("combobox", { name, exact: true });
      await control.click();
      await page
        .getByRole("listbox", { name, exact: true })
        .getByRole("option", { name: label, exact: true })
        .click();
      assert.deepEqual(errors, [], "select must not throw a renderer error");
      assert.equal(
        (await control.innerText()).trim(),
        label,
        "selected label should update immediately",
      );
    }
    const read = () =>
      page.evaluate(() => window.toolkit.call("game-options.read"));
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await nav("游戏设置");
    assert.equal(
      await page.getByLabel("亮度", { exact: true }).isEnabled(),
      true,
      "numeric settings must be editable before enabling overrides",
    );
    await choose("网络调节器", "4G：100 ms 延迟 / 1% 丢包");
    await choose("显示网络延迟图", "开启");
    await choose("全屏", "开启");
    await choose("精美天空", "关闭");
    await nav("存档");
    await nav("游戏设置");
    assert.match(
      await page
        .getByRole("combobox", { name: "网络调节器", exact: true })
        .innerText(),
      /4G/,
    );
    await page
      .getByRole("button", { name: "保存游戏设置", exact: true })
      .click();
    await page
      .getByText("已保存，将在下一次启动游戏前应用。", { exact: true })
      .waitFor();
    assert.deepEqual((await read()).overrides, {
      dev_connection_quality: "2",
      dev_show_latency_graph: "1",
      gfx_fullscreen: "1",
      gfx_fancyskies: "0",
    });
    assert.equal(
      await fs.readFile(file, "utf8"),
      original,
      "saving template must not overwrite the live game file",
    );
    await page
      .getByRole("button", { name: "重新读取游戏设置", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("fieldset.workspace-fieldset[disabled]"),
    );
    assert.match(
      await page
        .getByRole("combobox", { name: "全屏", exact: true })
        .innerText(),
      /开启/,
    );
    // The empty string is an actual Select value: it must remove the override.
    await choose("显示网络延迟图", "不覆盖（沿用游戏设置）");
    await choose("网络调节器", "完整网络堆栈（无限制）");
    await page
      .getByRole("button", { name: "保存游戏设置", exact: true })
      .click();
    await page.waitForFunction(async () => {
      const s = await window.toolkit.call("game-options.read");
      return (
        s.overrides.dev_connection_quality === "1" &&
        !Object.hasOwn(s.overrides, "dev_show_latency_graph")
      );
    });
    await page.reload();
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await nav("游戏设置");
    assert.equal(
      (
        await page
          .getByRole("combobox", { name: "网络调节器", exact: true })
          .innerText()
      ).trim(),
      "完整网络堆栈（无限制）",
    );
    assert.equal(
      (
        await page
          .getByRole("combobox", { name: "显示网络延迟图", exact: true })
          .innerText()
      ).trim(),
      "不覆盖（沿用游戏设置）",
    );
    // Also choose a boolean option using the keyboard's Enter key.
    await page.getByRole("combobox", { name: "全屏", exact: true }).click();
    const popup = page.locator(".select-menu:popover-open");
    await popup.getByRole("searchbox").fill("关闭");
    await popup.getByRole("searchbox").press("Enter");
    assert.equal(
      (
        await page
          .getByRole("combobox", { name: "全屏", exact: true })
          .innerText()
      ).trim(),
      "关闭",
    );
    const brightness = page.getByRole("textbox", { name: "亮度", exact: true });
    await brightness.fill("");
    await brightness.pressSequentially("0.");
    assert.equal(
      await brightness.inputValue(),
      "0.",
      "typing a decimal separator must not reset the input",
    );
    assert.equal(
      await page.getByLabel("覆盖亮度", { exact: true }).isChecked(),
      true,
    );
    await nav("存档");
    await nav("游戏设置");
    assert.equal(
      await brightness.inputValue(),
      "0.",
      "unfinished numeric text survives navigation",
    );
    await brightness.press("End");
    await brightness.pressSequentially("65");
    assert.equal(await brightness.inputValue(), "0.65");
    const numeric = [
      ["HTTP 额外延迟（秒）", "2", "dev_add_http_delay_seconds", "2"],
      ["渲染距离（区块）", "19", "gfx_viewdistance", "304"],
      ["帧率上限", "120", "gfx_max_framerate", "120"],
      ["主音量", "0.8", "audio_main", "0.8"],
      ["音效音量", "0.7", "audio_sound", "0.7"],
      ["音乐音量", "0.25", "audio_music", "0.25"],
      ["鼠标灵敏度", "0.6", "ctrl_sensitivity2_mouse", "0.6"],
    ];
    for (const [label, value] of numeric) {
      const input = page.getByRole("textbox", { name: label, exact: true });
      assert.equal(await input.isEnabled(), true);
      await input.fill(value);
      assert.equal(await input.inputValue(), value);
      assert.equal(
        await page.getByLabel("覆盖" + label, { exact: true }).isChecked(),
        true,
      );
    }
    const save = () =>
      page.getByRole("button", { name: "保存游戏设置", exact: true }).click();
    await save();
    await page.waitForFunction(
      async () =>
        (await window.toolkit.call("game-options.read")).overrides.gfx_gamma ===
        "0.65",
    );
    const saved = await read();
    for (const [, , key, value] of numeric)
      assert.equal(saved.overrides[key], value);
    await brightness.fill("");
    await save();
    await page.getByText("亮度的值无效", { exact: true }).waitFor();
    assert.equal(await brightness.inputValue(), "");
    assert.equal(
      (await read()).revision,
      saved.revision,
      "invalid empty input must not save as zero",
    );
    await brightness.fill("1.2");
    await save();
    await page.getByText("亮度超出允许范围", { exact: true }).waitFor();
    assert.equal((await read()).revision, saved.revision);
    await brightness.fill("0.45");
    await save();
    await page.waitForFunction(
      async () =>
        (await window.toolkit.call("game-options.read")).overrides.gfx_gamma ===
        "0.45",
    );
    await page.reload();
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await nav("游戏设置");
    assert.equal(await brightness.inputValue(), "0.45");
    assert.equal(
      await page
        .getByRole("textbox", { name: "渲染距离（区块）", exact: true })
        .inputValue(),
      "19",
    );
    await page.getByLabel("覆盖亮度", { exact: true }).uncheck();
    assert.equal(
      await brightness.inputValue(),
      "0.5",
      "unchecking reverts the displayed draft to game value/default",
    );
    assert.equal(await brightness.isEnabled(), true);
    await brightness.fill("0.");
    await page
      .getByRole("button", { name: "全部改为不覆盖", exact: true })
      .click();
    assert.equal(
      await brightness.inputValue(),
      "0.5",
      "reset removes unfinished numeric drafts",
    );
    await save();
    await page.waitForFunction(
      async () =>
        Object.keys((await window.toolkit.call("game-options.read")).overrides)
          .length === 0,
    );
    assert.equal(await fs.readFile(file, "utf8"), original);
    await page.getByLabel("搜索游戏设置", { exact: true }).fill("音量");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
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
    await fs.mkdir(testResultsRoot, { recursive: true });
    await fs.writeFile(
      path.join(testResultsRoot, "game-options-input.png"),
      Buffer.from(shot, "base64"),
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
              () => reject(Error("options UI exit timeout")),
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
    assert(path.basename(root).startsWith("dgn-options-select-"));
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(
    "PASS game settings UI: dropdowns, editable numeric inputs, fractional typing, invalid drafts, unit conversion, automatic overrides, save/reload, reset and unchanged game file; clean exit",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
