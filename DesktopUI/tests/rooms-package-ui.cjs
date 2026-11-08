const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  crypto = require("node:crypto"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  if (!process.env.DGN_GAME_TEST_EXE)
    throw Error("DGN_GAME_TEST_EXE is required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-rooms-package-"));
  let app;
  try {
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE,
      args: [],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root },
    });
    let page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const profiles = await page.evaluate(() =>
      window.toolkit.call("profiles.list"),
    );
    await page.evaluate(
      (id) =>
        window.toolkit.call("worlds.create", {
          projectId: id,
          name: "安装包联机测试",
        }),
      profiles[0].id,
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "联机房间", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "联机房间", exact: true })
      .waitFor();
    await page.getByRole("combobox", { name: "存档", exact: true }).click();
    await page
      .getByRole("option", { name: "安装包联机测试", exact: true })
      .click();
    await page
      .getByLabel("樱花公网入口", { exact: true })
      .fill("example.test:36559");
    await page.getByLabel("自定义邀请码", { exact: true }).fill("固定朋友房间");
    await page
      .getByRole("button", { name: "创建联机房间", exact: true })
      .click();
    await page
      .getByText("请先在设置中选择游戏程序，或在启动配置中指定游戏程序", {
        exact: true,
      })
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
    assert.equal(
      await page
        .getByRole("combobox", { name: "本地启动配置", exact: true })
        .count(),
      0,
    );
    const p = require("../electron/network/protocol.cjs"),
      hostIp = p.subnet();
    const invitation = p.encodeInvite({
      version: 1,
      roomId: crypto.randomUUID(),
      inviteId: crypto.randomUUID(),
      network: "dgn-" + crypto.randomBytes(16).toString("hex"),
      hostIp,
      guestIp: hostIp.replace(/\.1$/, ".2"),
      controlPort: 30001,
      expires: Date.now() + 3600000,
      endpoint: "tcp://example.test:32000",
      authKey: p.randomKey(),
      credential: p.randomKey(),
      hostPublicKey: p.randomKey(),
    });
    await page.getByLabel("完整邀请文本").fill(invitation);
    await page.getByLabel("联机玩家名").fill("NoProfileGuest");
    assert.equal(
      await page
        .getByRole("button", { name: "加入朋友房间", exact: true })
        .isEnabled(),
      true,
    );
    await page
      .getByRole("button", { name: "加入朋友房间", exact: true })
      .click();
    await page
      .getByText(
        "请先在“设置 → 全局游戏程序”选择开发版 Minecraft.Windows.exe，再粘贴邀请加入",
        { exact: true },
      )
      .waitFor();
    await page.getByRole("button", { name: "离开房间", exact: true }).click();
    await page
      .getByRole("button", { name: "确认结束联机", exact: true })
      .click();
    assert.equal(
      await fs.stat(path.join(root, "network-components")).then(
        () => true,
        (e) => (e.code === "ENOENT" ? false : Promise.reject(e)),
      ),
      false,
    );
    assert.deepEqual(errors, []);
    // A real application restart must restore inputs, including a failed join.
    assert.equal(
      await page.getByLabel("完整邀请文本").inputValue(),
      invitation,
    );
    const saved = await page.evaluate(() => window.toolkit.call("rooms.draft"));
    assert.equal(saved.roomCode, "固定朋友房间");
    const stored = await fs.readFile(
      path.join(root, "room-preferences.json"),
      "utf8",
    );
    assert(!stored.includes("NoProfileGuest"));
    assert(!stored.includes(invitation));
    await app.close();
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE,
      args: [],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: root },
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "联机房间", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.querySelector("textarea")?.value.startsWith("DGNROOM1:"),
    );
    assert.equal(
      await page.getByLabel("完整邀请文本").inputValue(),
      invitation,
    );
    assert.equal(
      await page.getByLabel("联机玩家名").inputValue(),
      "NoProfileGuest",
    );
    assert.equal(
      await page.getByLabel("自定义邀请码", { exact: true }).inputValue(),
      "固定朋友房间",
    );
    await page
      .getByRole("button", { name: "清除已保存的加入信息", exact: true })
      .click();
    await page.evaluate(() => window.toolkit.call("rooms.draft"));
    await page.reload();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "联机房间", exact: true })
      .click();
    await page.getByLabel("完整邀请文本").waitFor();
    assert.equal(await page.getByLabel("完整邀请文本").inputValue(), "");
    assert.equal(await page.getByLabel("联机玩家名").inputValue(), "");
    await fs.mkdir(testResultsRoot, { recursive: true });
    await fs.writeFile(
      path.join(testResultsRoot, "rooms-package-ui.json"),
      JSON.stringify(
        {
          ok: true,
          exe: process.env.DGN_GAME_TEST_EXE,
          checks: [
            "actual packaged EXE navigation",
            "real room preflight failure",
            "real close cleanup",
            "invitation and player name only; no profile selector",
            "missing global game fails before network creation",
            "no network/driver/game started",
            "custom room code and join inputs restored after full application restart",
            "join data encrypted at rest and explicit clear persists",
          ],
          errors,
        },
        null,
        2,
      ),
    );
    console.log("rooms-package-ui passed");
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
