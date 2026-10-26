const { _electron: electron } = require("playwright"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict"),
  { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs"),
  { Profiles } = require("../electron/domains/profiles/profiles.cjs"),
  { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs"),
  { levelData } = require("./fixtures/zip.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-local-join-ui-"));
  let app;
  try {
    const data = path.join(root, "data"),
      game = path.join(root, "Game.exe"),
      launcher = path.join(root, "Launcher.exe"),
      probe = path.join(root, "selected-host.json");
    await fs.writeFile(game, "fixture only");
    const cs = path.join(root, "Fixture.cs");
    await fs.writeFile(
      cs,
      `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/debug-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.Start();p.WaitForExit();}}`,
    );
    const compiled = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + launcher, cs],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const store = new WorkspaceStore(data);
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    await store.updateSettings({ GamePath: game, LauncherPath: launcher });
    const profile = await profiles.read(store.value.projects[0].id);
    await profiles.save(profile.project.id, profile.revision, {
      included_mod_dirs: [],
    });
    const worlds = new WorldLibrary(
        store,
        path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"),
      ),
      worldIds = [];
    for (const name of ["World A", "World B"]) {
      const w = await worlds.create(profile.project.id, { name });
      worldIds.push(w.id);
      await fs.mkdir(worlds.location(w.id), { recursive: true });
      await fs.writeFile(
        path.join(worlds.location(w.id), "level.dat"),
        levelData("Same native room"),
      );
    }
    app = await electron.launch({
      args: ["tests/fixtures/multi-hosts-ui-entry.cjs"],
      env: {
        ...process.env,
        DGN_GAME_HEADLESS: "1",
        DGN_GAME_DATA_DIR: data,
        DGN_LOCAL_JOIN_PROBE: probe,
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const call = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.toolkit.call(method, args), {
        method,
        args,
      });
    await page
      .getByRole("button", { name: "启动联机客户端", exact: true })
      .click();
    await page
      .getByText("请先启动一个主存档，并进入世界等待调试就绪。", {
        exact: true,
      })
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "启动并加入", exact: true })
        .isDisabled(),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    for (const worldId of worldIds)
      await call("launch.start", { profileId: profile.project.id, worldId });
    let hosts = [];
    for (let n = 0; n < 100; n++) {
      hosts = await call("launch.hosts");
      if (hosts.length === 2 && hosts.every((h) => h.ready)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(hosts.filter((h) => h.ready).length, 2);
    await page
      .getByRole("button", { name: "启动联机客户端", exact: true })
      .click();
    const select = page.getByRole("combobox", {
      name: "加入哪个主存档",
      exact: true,
    });
    assert(
      await page
        .getByRole("button", { name: "启动并加入", exact: true })
        .isDisabled(),
    );
    await select.click();
    await page.getByRole("option", { name: /^World B ·/ }).click();
    assert.match(await page.getByRole("combobox", { name: "本次联机游戏版本", exact: true }).innerText(), /3\.10\.0\.436581/);
    assert(await page.getByRole("combobox", { name: "本次联机游戏版本", exact: true }).isDisabled());
    await page.getByLabel("联机玩家名", { exact: true }).fill("GuestB");
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/local-join-picker.png" });
    await page.getByRole("button", { name: "启动并加入", exact: true }).click();
    await page.getByText("测试已确认目标：World B", { exact: true }).waitFor();
    assert.equal(JSON.parse(await fs.readFile(probe, "utf8")).world, "World B");
    await select.click();
    await page.getByRole("option", { name: /^World A ·/ }).click();
    await call("launch.stop", {
      sessionId: hosts.find((h) => h.worldName === "World A").sessionId,
    });
    await page
      .getByText("所选主机已退出，请重新选择；不会自动改为其他存档。", {
        exact: true,
      })
      .waitFor();
    assert(
      await page
        .getByRole("button", { name: "启动并加入", exact: true })
        .isDisabled(),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page
      .getByRole("article", { name: "存档 World B", exact: true })
      .getByRole("button", { name: "打开控制台", exact: true })
      .click();
    await page
      .getByRole("button", { name: "加入此存档测试", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "加入哪个主存档", exact: true })
      .filter({ hasText: /World B/ })
      .waitFor();
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await app.evaluate(() => {
      const sessions = globalThis.dgnFixtureSessions;
      const stopped = sessions.workers.find(w => !w.session.running);
      stopped.session.autoJoin = { phase: "failed", worldName: "Failed target", message: "fixture join failure" };
      sessions.publish();
    });
    await page.locator(".sidebar").getByRole("button", { name: "运行日志", exact: true }).click();
    const failed = page.getByText(/目标：Failed target · 加入失败/);
    await failed.waitFor();
    assert.match(await failed.locator("..").getAttribute("title"), /fixture join failure/);
    assert.deepEqual(errors, []);
    await fs.writeFile(
      "test-results/local-join-ui.json",
      JSON.stringify(
        {
          passed: true,
          boundary:
            "Product UI/IPC/ClientJoiner host selection with fake launcher; native join intentionally stops at transport.create",
          checks: [
            "no host disables join",
            "multiple hosts require explicit selection",
            "selected B runtime reaches native boundary",
            "stopped A does not switch to B",
            "world console preselects its own host",
            "guest version is locked to host snapshot",
            "stopped failure retains target, result and error detail",
          ],
        },
        null,
        2,
      ),
    );
    console.log("PASS local join picker UI");
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-local-join-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
