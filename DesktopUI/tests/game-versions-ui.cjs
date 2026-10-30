const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { WorkspaceStore } = require("../electron/services.cjs");
const { profilesForDiscovery } = require("../electron/domains/client/engine-profiles.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-versions-ui-"));
  let app;
  try {
    const games = [];
    for (const version of ["3.10.0.436581", "3.10.0.420447"]) {
      const exe = path.join(root, "games", version, "Minecraft.Windows.exe");
      await fs.mkdir(path.dirname(exe), { recursive: true });
      await fs.writeFile(exe, "fixture unknown build " + version);
      games.push(exe);
    }
    const data = path.join(root, "data"),
      store = new WorkspaceStore(data);
    await store.load();
    await store.updateSettings({ GamePath: games[0] });
    app = await electron.launch({
      args: ["tests/fixtures/game-versions-ui-entry.cjs"],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: data,
        DGN_GAME_VERSIONS_ROOT: path.join(root, "games"),
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page
      .getByText("已发现的程序尚未通过自动联机验证，可切换到“手动启动”选择。", {
        exact: true,
      })
      .waitFor();
    await page.getByText("查看已登记游戏版本的能力", { exact: true }).click();
    const registered = profilesForDiscovery();
    const rows = page.locator(".engine-capabilities tbody tr");
    assert.equal(await rows.count(), registered.length);
    for (const profile of registered) {
      const row = rows.filter({
        has: page.getByRole("cell", { name: profile.version, exact: true }),
      });
      assert.equal(await row.count(), 1);
      assert.deepEqual(await row.locator("td").allTextContents(), [
        profile.version,
        profile.autoJoin ? "已验证" : "待验证",
        profile.isolatedHost ? "已验证" : "待验证",
        profile.isolatedClient ? "已验证" : "待验证",
      ]);
    }
    await page
      .getByRole("combobox", { name: "游戏版本用途", exact: true })
      .click();
    await page
      .getByRole("option", {
        name: "手动启动 · 显示所有已发现版本",
        exact: true,
      })
      .click();
    await page
      .getByRole("combobox", { name: "已发现的游戏版本", exact: true })
      .click();
    await page
      .getByRole("option", { name: /^3\.10\.0\.420447 · 未验证/ })
      .click();
    await page.waitForFunction(
      (p) =>
        [...document.querySelectorAll("input")].some(
          (input) => input.value === p,
        ),
      games[1],
    );
    assert.match(await page.getByText(/^当前程序：/).innerText(), /未验证构建/);
    const unsupported = await page.evaluate(
      (p) => window.toolkit.call("games.inspect", { path: p }),
      games[1],
    );
    assert.equal(unsupported.profile, null);
    assert.equal(unsupported.version, null);
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/game-versions.png" });
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "存档", exact: true })
      .click();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "全局游戏程序", exact: true })
        .inputValue(),
      games[1],
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS game version UI/IPC: matrix, unverified filter, manual selection and persistence",
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
