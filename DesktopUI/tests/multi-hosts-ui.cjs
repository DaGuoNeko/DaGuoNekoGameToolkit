const { _electron: electron } = require("playwright"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs"),
  { Profiles } = require("../electron/domains/profiles/profiles.cjs"),
  { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-multi-ui-"));
  let app;
  try {
    const data = path.join(root, "data"),
      source = path.join(root, "source"),
      game = path.join(root, "Game.exe"),
      launcher = path.join(root, "Launcher.exe");
    await fs.mkdir(source);
    await fs.writeFile(game, "not executed");
    const file = path.join(root, "Fixture.cs");
    await fs.writeFile(
      file,
      `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/debug-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Console.Error.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();}}`,
    );
    const c = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + launcher, file],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(c.status, 0, c.stdout + c.stderr);
    const store = new WorkspaceStore(data);
    await store.load();
    const profiles = new Profiles(store);
    await profiles.initialize();
    await store.updateSettings({ GamePath: game, LauncherPath: launcher });
    const p = await profiles.read(store.value.projects[0].id);
    await profiles.save(p.project.id, p.revision, {
      included_mod_dirs: [source],
    });
    const worlds = new WorldLibrary(
      store,
      path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"),
    );
    const a = await worlds.create(p.project.id, { name: "World A" }),
      b = await worlds.create(p.project.id, { name: "World B" });
    if (process.env.DGN_TEST_RELOAD_SOURCES)
      for (const w of [a, b]) {
        await fs.mkdir(worlds.location(w.id), { recursive: true });
        await fs.writeFile(
          path.join(worlds.location(w.id), "level.dat"),
          "fixture",
        );
      }
    const orphan = await worlds.create(p.project.id, {
      name: "Missing profile",
    });
    const index = await worlds.read();
    index.worlds.find((w) => w.id === orphan.id).profileId = "removed-profile";
    await worlds.write(index);
    app = await electron.launch({
      args: ["tests/fixtures/multi-hosts-ui-entry.cjs"],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const card = (name) =>
      page.getByRole("article", { name: "存档 " + name, exact: true });
    await card("Missing profile")
      .getByText("原启动配置已不存在；可重新选择，或使用快速测试。", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await card("Missing profile")
        .getByRole("button", { name: "启动此存档", exact: true })
        .isDisabled(),
      true,
    );
    await card("Missing profile")
      .getByRole("button", { name: "打开存档控制台", exact: true })
      .click();
    await page.getByRole("button", { name: "选择启动配置", exact: true }).click();
    await page.getByRole("button", { name: "编辑存档设置", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByRole("button", { name: "返回存档列表", exact: true }).click();
    const profilesBefore = await page.evaluate(() =>
      window.toolkit.call("profiles.list"),
    );
    await card("Missing profile")
      .getByRole("button", { name: "快速测试", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "测试模组 source", exact: true })
      .check();
    await fs.mkdir(testResultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(testResultsRoot, "quick-test-ui.png") });
    await page.getByRole("button", { name: "开始测试", exact: true }).click();
    try {
      await page.getByText("调试已就绪", { exact: true }).waitFor();
    } catch (e) {
      console.error(await page.locator("body").innerText());
      console.error(
        await page.evaluate(() => window.toolkit.call("launch.state")),
      );
      throw e;
    }
    const quickState = await page.evaluate(() =>
      window.toolkit.call("launch.state"),
    );
    const quickSession = quickState.sessions.find(
      (s) => s.worldId === orphan.id,
    );
    assert.equal(quickSession.quickTest, true);
    assert.equal(quickSession.profileName, "快速测试（默认参数）");
    const quickConfig = JSON.parse(
      await fs.readFile(
        path.join(quickSession.runDirectory, ".mcdev.json"),
        "utf8",
      ),
    );
    assert.deepEqual(quickConfig.included_mod_dirs, [
      { path: source, enabled: true, hot_reload: true },
    ]);
    assert.equal(quickConfig.include_debug_mod, true);
    assert.deepEqual(
      await page.evaluate(() => window.toolkit.call("profiles.list")),
      profilesBefore,
    );
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("未运行", { exact: true }).waitFor();
    await page.getByRole("button", { name: "快速测试", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="测试模组 source"]')?.checked,
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("button", { name: "返回存档列表", exact: true })
      .click();
    await card("World A")
      .getByRole("button", { name: "启动此存档", exact: true })
      .click();
    await page.getByText("调试已就绪", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "返回存档列表", exact: true })
      .click();
    assert.equal(
      await card("World B")
        .getByRole("button", { name: "启动此存档", exact: true })
        .isEnabled(),
      true,
    );
    await card("World B")
      .getByRole("button", { name: "启动此存档", exact: true })
      .click();
    await page.getByText("调试已就绪", { exact: true }).waitFor();
    const switches = page.getByLabel("运行中的存档主机", { exact: true });
    await switches
      .getByRole("button", { name: "World A", exact: true })
      .waitFor();
    await page.getByText(/此主机与其他会话共用源码目录/).waitFor();
    const run = async (name) => {
      await switches.getByRole("button", { name, exact: true }).click();
      await page
        .locator(".world-context")
        .getByRole("heading", { name, exact: true })
        .waitFor();
      await page.getByRole("button", { name: "查看会话控制台", exact: true }).click();
      await page.getByRole("button", { name: "执行指令", exact: true }).click();
      await page.getByLabel("游戏指令", { exact: true }).fill("/say " + name);
      await page.getByRole("button", { name: "立即执行", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await require("./fixtures/navigation.cjs").navigate(page, "存档");
    };
    await run("World A");
    await run("World B");
    const state = await page.evaluate(() =>
      window.toolkit.call("launch.state"),
    );
    assert.equal(state.sessions.filter((s) => s.running).length, 2);
    const records = (
      await fs.readFile(path.join(source, "actions.fixture"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      records.map((x) => x.command),
      ["/say World A", "/say World B"],
    );
    await switches.getByRole("button", { name: "World A", exact: true }).click();
    await page.locator(".world-context").getByRole("heading", { name: "World A", exact: true }).waitFor();
    await require("./fixtures/navigation.cjs").navigate(page, "控制台");
    await page.getByRole("heading", { name: "World B", exact: true }).waitFor();
    await page.getByRole("button", { name: "打开关联存档", exact: true }).click();
    await page.locator(".world-context").getByRole("heading", { name: "World B", exact: true }).waitFor();
    if (process.env.DGN_TEST_RELOAD_SOURCES) {
      await switches
        .getByRole("button", { name: "World A", exact: true })
        .click();
      await page.getByRole("button", { name: "查看会话控制台", exact: true }).click();
      const next = path.join(root, "worktree");
      await fs.mkdir(next);
      const original = await profiles.read(p.project.id);
      await profiles.save(p.project.id, original.revision, {
        included_mod_dirs: [next],
      });
      const restart = page.getByRole("button", {
        name: "按最新配置重启",
        exact: true,
      });
      await restart.waitFor();
      await page
        .getByText(/已保存的模组来源或热更新设置与本次运行不同/)
        .waitFor();
      await page.getByText("查看本次运行的模组来源", { exact: true }).click();
      await page
        .locator(".reload-sources code")
        .filter({ hasText: source })
        .first()
        .waitFor();
      await page
        .getByRole("button", { name: "热更新脚本", exact: true })
        .click();
      await page.getByText(/当前来源：/).waitFor();
      const oldA = state.sessions.find((s) => s.worldId === a.id),
        oldB = state.sessions.find((s) => s.worldId === b.id);
      await restart.click();
      const dialog = page.getByRole("dialog");
      assert(
        await dialog
          .getByRole("button", { name: "确认重启", exact: true })
          .isDisabled(),
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(
        (
          await page.evaluate(() => window.toolkit.call("launch.state"))
        ).sessions.find((s) => s.id === oldA.id).running,
        true,
      );
      await page.screenshot({ path: path.join(testResultsRoot, "reload-sources-ui.png") });
      await restart.click();
      await page.getByLabel("我已保存游戏进度").check();
      await page.getByRole("button", { name: "确认重启", exact: true }).click();
      let completed = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const s = await page.evaluate(() =>
          window.toolkit.call("launch.state"),
        );
        if (
          !s.sessions.find((x) => x.id === oldA.id)?.running &&
          s.sessions.some(
            (x) =>
              x.running &&
              x.worldId === a.id &&
              x.id !== oldA.id &&
              x.sourceRoots?.includes(next),
          )
        ) {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert(completed, "Target restart did not finish with the new source");
      await require("./fixtures/navigation.cjs").navigate(page, "存档");
      await page.getByText("调试已就绪", { exact: true }).waitFor();
      const after = await page.evaluate(() =>
          window.toolkit.call("launch.state"),
        ),
        newA = after.sessions.findLast((s) => s.worldId === a.id);
      await fs.writeFile(
        path.join(testResultsRoot, "reload-sources-ui-state.json"),
        JSON.stringify(
          {
            oldA: oldA.id,
            oldB: oldB.id,
            a: a.id,
            b: b.id,
            after: after.sessions.map((s) => ({
              id: s.id,
              worldId: s.worldId,
              running: s.running,
              sourceRoots: s.sourceRoots,
            })),
            text: (await page.locator(".world-console").count())
              ? await page.locator(".world-console").innerText()
              : await page.locator("body").innerText(),
          },
          null,
          2,
        ),
      );
      assert.equal(after.sessions.find((s) => s.id === oldA.id).running, false);
      assert.equal(after.sessions.find((s) => s.id === oldB.id).running, true);
      assert.deepEqual(newA.sourceRoots, [next]);
      const cfg = JSON.parse(
        await fs.readFile(path.join(newA.runDirectory, ".mcdev.json"), "utf8"),
      );
      assert.deepEqual(cfg.included_mod_dirs, [next]);
      assert.deepEqual(errors, []);
      await fs.writeFile(
        path.join(testResultsRoot, "reload-sources-ui.json"),
        JSON.stringify(
          {
            passed: true,
            boundary:
              "real UI/Sessions/Host Bridge with test Launcher; no Minecraft",
            checks: [
              "saved source change detected",
              "active and saved paths visible",
              "reload blocked on source mismatch",
              "confirmation cancel preserves game",
              "explicit saved confirmation",
              "same world new runtime reads new source",
              "other host stays running",
            ],
          },
          null,
          2,
        ),
      );
      console.log("PASS reload-sources UI");
      return;
    }
    // Stop B while A is the globally selected/log session; the dashboard must
    // remain scoped to B and clear its readiness/PID immediately.
    await page.evaluate(
      (id) => window.toolkit.call("launch.select", { sessionId: id }),
      state.sessions.find((s) => s.worldId === a.id).id,
    );
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("未运行", { exact: true }).waitFor();
    // Ending B must not switch the controls under the user's pointer to A.
    await page
      .locator(".world-context")
      .getByRole("heading", { name: "World B", exact: true })
      .waitFor();
    const remaining = await page.evaluate(() =>
      window.toolkit.call("launch.state"),
    );
    assert.equal(
      remaining.sessions.find((s) => s.worldId === a.id).running,
      true,
    );
    assert.equal(
      remaining.sessions.find((s) => s.worldId === b.id).running,
      false,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "启动此存档", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await page.locator(".world-summary .action-status.ready").count(),
      0,
    );
    assert.equal(
      await page
        .locator(".world-summary")
        .getByText(/启动器 PID/)
        .count(),
      0,
    );
    await page
      .getByLabel("运行中的存档主机", { exact: true })
      .getByRole("button", { name: "World A", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "返回存档列表", exact: true })
      .click();
    assert.equal(
      await card("World A")
        .getByRole("button", { name: "删除存档", exact: true })
        .isDisabled(),
      true,
    );
    const denied = await page.evaluate(async (worldId) => {
      try {
        await window.toolkit.call("worlds.recycle", {
          worldId,
          confirmed: true,
        });
        return "unexpected success";
      } catch (e) {
        return e.message;
      }
    }, a.id);
    assert.match(denied, /正在运行/);
    await card("World B")
      .getByRole("button", { name: "删除存档", exact: true })
      .click();
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();
    await card("World B").waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "回收站", exact: true }).click();
    await card("World B")
      .getByRole("button", { name: "恢复存档", exact: true })
      .click();
    await page.getByRole("button", { name: "确认恢复", exact: true }).click();
    await card("World B").waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "存档", exact: true }).click();
    await card("World B")
      .getByRole("button", { name: "删除存档", exact: true })
      .click();
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();
    await card("World B").waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "回收站", exact: true }).click();
    await page.getByRole("button", { name: "清空回收站", exact: true }).click();
    await page
      .getByRole("button", { name: "确认清空回收站", exact: true })
      .click();
    await page.getByText("回收站为空", { exact: true }).waitFor();
    const finalState = await page.evaluate(() =>
      window.toolkit.call("launch.state"),
    );
    assert.equal(
      finalState.sessions.find((s) => s.worldId === a.id).running,
      true,
    );
    await page.getByRole("tab", { name: "存档", exact: true }).click();
    await card("World A")
      .getByRole("button", { name: "打开存档控制台", exact: true })
      .click();
    await page.getByRole("button", { name: "停止会话", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await page.getByText("未运行", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".world-summary .action-status.ready").count(),
      0,
    );
    assert.equal(
      await page
        .locator(".world-summary")
        .getByText(/启动器 PID/)
        .count(),
      0,
    );
    await fs.mkdir(testResultsRoot, { recursive: true });
    await page.screenshot({ path: path.join(testResultsRoot, "world-management-ui.png") });
    await fs.writeFile(
      path.join(testResultsRoot, "world-management-ui.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "missing-profile-explanation",
            "target-delete-protection",
            "recycle-restore-purge-other-world-with-live-host",
            "stop-nonselected-host",
            "stop-selected-host",
            "readiness-and-pid-cleared",
            "remaining-host-switch",
          ],
        },
        null,
        2,
      ),
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByLabel("启用独立主机", { exact: true }).uncheck();
    await page.waitForFunction(
      async () =>
        !(await window.toolkit.call("bootstrap")).settings.IndependentWorlds,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS multi-host UI: independent hosts, missing profile, target-scoped recycle/restore/purge, selected/nonselected stop refresh, compatibility setting",
    );
  } finally {
    if (app) await app.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-multi-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
