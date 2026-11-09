const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-rooms-ui-"));
  let app;
  try {
    const store = new WorkspaceStore(root);
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    const profile = store.value.projects[0];
    const worlds = new WorldLibrary(
      store,
      path.join(root, "game-data/MinecraftPE_Netease/minecraftWorlds"),
    );
    await worlds.create(profile.id, { name: "联机测试地图" });
    app = await electron.launch({
      args: ["tests/fixtures/rooms-ui-entry.cjs"],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await require("./fixtures/navigation.cjs").navigate(page, "联机房间");
    await page
      .getByRole("heading", { name: "联机房间", exact: true })
      .waitFor();
    await page.getByRole("combobox", { name: "存档", exact: true }).click();
    await page
      .getByRole("option", { name: "联机测试地图", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("樱花公网入口", { exact: true }).inputValue(),
      "frp.example.test:36559",
    );
    await page
      .getByRole("button", { name: "创建联机房间", exact: true })
      .click();
    await page.getByRole("button", { name: "复制固定邀请", exact: true }).click();
    await page.getByText(/邀请已复制到剪贴板/).waitFor();
    await page
      .getByText("脚本同步：已开启联机 Python 热更新", { exact: true })
      .waitFor();
    await page
      .getByText("脚本同步：已同步 1 个文件，热更新 1 个已加载模块", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "DGNROOM2:UI-FIXTURE",
    );
    assert.equal(await page.getByRole("button",{name:"撤销邀请",exact:true}).count(),0);
    assert.equal(await page.getByText(/到期/).count(),0);
    await page.getByText(/不限时/).waitFor();
    await page
      .getByRole("button", { name: "关闭联机分享", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page
      .getByRole("button", { name: "复制固定邀请", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "关闭联机分享", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认结束联机", exact: true })
      .click();
    await page
      .getByRole("button", { name: "创建联机房间", exact: true })
      .waitFor();
    await page.getByLabel("完整邀请文本").fill("DGNROOM1:UI-FIXTURE");
    assert.equal(
      await page
        .getByRole("combobox", { name: "本地启动配置", exact: true })
        .count(),
      0,
    );
    await page.getByLabel("联机玩家名").fill("Friend");
    await page
      .getByRole("button", { name: "加入朋友房间", exact: true })
      .click();
    await page.getByText("测试：游戏版本不一致", { exact: true }).waitFor();
    await page.getByLabel("联机玩家名").fill("RetryGuest");
    await page
      .getByRole("button", { name: "加入朋友房间", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "联机需要处理", exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("需要处理游戏弹窗", { exact: true }).count(),
      0,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("button", { name: "离开房间", exact: true }).click();
      await page
        .getByRole("button", { name: "确认结束联机", exact: true })
        .click();
      if (!attempt)
        await page
          .getByText("测试：客户端已退出，清理需要再次重试", { exact: true })
          .waitFor();
    }
    await page
      .getByRole("button", { name: "创建联机房间", exact: true })
      .waitFor();
    await fs.mkdir(testResultsRoot, { recursive: true });
    await page.getByLabel("完整邀请文本").fill("DGNROOM1:UI-FIXTURE");
    await page.getByLabel("联机玩家名").fill("ReconnectGuest");
    await page
      .getByRole("button", { name: "加入朋友房间", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "重连需要处理", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "重试重连", exact: true }).click();
    await page
      .getByRole("heading", { name: "等待房主恢复", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "已进入游戏", exact: true })
      .waitFor();
    await page
      .getByText("脚本同步：重连后脚本同步已恢复", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "重试重连", exact: true }).count(),
      0,
    );
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
    await fs.writeFile(path.join(testResultsRoot, "rooms-ui.png"), Buffer.from(png, "base64"));
    assert.deepEqual(errors, []);
    await fs.writeFile(
      path.join(testResultsRoot, "rooms-ui.json"),
      JSON.stringify(
        {
          ok: true,
          boundary: "UI IPC fixture; no game or network started",
          checks: [
            "create",
            "invite clipboard",
            "fixed invite has no expiry or one-time revocation UI",
            "cancel close",
            "close",
            "join version error",
            "leave retries after cleanup failure",
            "retained client reconnect waiting and restored script sync",
          ],
          errors,
        },
        null,
        2,
      ),
    );
    console.log("rooms-ui passed");
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
