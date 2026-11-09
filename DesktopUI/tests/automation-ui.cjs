const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-automation-ui-")),
    data = path.join(root, "data");
  let app, client;
  try {
    const game = path.join(root, "Game.exe"),
      runtime = path.join(root, "BridgeFixture.exe"),
      cs = path.join(root, "Fixture.cs");
    await fs.writeFile(game, "fixture not executed");
    await fs.writeFile(
      cs,
      `using System;using System.Diagnostics;class Fixture{static void Main(){var p=new Process();p.StartInfo=new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify('"' + path.resolve("tests/fixtures/debug-runtime.cjs") + '"')});p.StartInfo.UseShellExecute=false;p.StartInfo.CreateNoWindow=true;p.StartInfo.RedirectStandardOutput=true;p.StartInfo.RedirectStandardError=true;p.OutputDataReceived+=(s,e)=>{if(e.Data!=null)Console.WriteLine(e.Data);};p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null)Console.Error.WriteLine(e.Data);};p.Start();p.BeginOutputReadLine();p.BeginErrorReadLine();p.WaitForExit();}}`,
    );
    const compile = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + runtime, cs],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const store = new WorkspaceStore(data);
    await store.load();
    await store.updateSettings({ LauncherPath: runtime, GamePath: game });
    app = await electron.launch({
      executablePath: process.env.DGN_GAME_TEST_EXE || undefined,
      args: process.env.DGN_GAME_TEST_EXE ? [] : ["."],
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data },
    });
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await require("./fixtures/mock-menu-name.cjs")(app);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("button", { name: "关闭 AI MCP", exact: true })
      .waitFor();
    client = new Client({ name: "automation-ui", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(data, "mcp/server.cjs"), "--data-dir", data],
        stderr: "pipe",
      }),
    );
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 60000,
      });
      assert(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    const status = await call("toolbox_status");
    assert(status.online);
    const operation = {instanceId:status.instanceId,confirmed:true};
    const created = await call("create_project", {...operation,requestId:"ui-profile",name:"AI 配置"});
    await call("update_project", {projectId:created.project.id,revision:created.revision,patch:{user_name:"AIPlayer"}});
    const loaded = await page.evaluate(id=>window.toolkit.call("project.read",{id}),created.project.id);
    assert.equal(loaded.config.user_name,"AIPlayer");
    const staleProfile = await client.callTool({name:"update_project",arguments:{projectId:created.project.id,revision:created.revision,patch:{user_name:"stale"}}});
    assert(staleProfile.isError);
    const preferences = await call("read_settings");
    await call("update_settings", {revision:preferences.revision,patch:{AppearanceMode:"Dark"}});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
    const source = path.join(root,"source-world");
    await fs.mkdir(path.join(source,"db"),{recursive:true});
    await fs.writeFile(path.join(source,"level.dat"),require("./fixtures/zip.cjs").levelData());
    const imported = await call("import_world", {...operation,requestId:"ui-import",source,name:"AI 导入副本"});
    const duplicate = await call("clone_world", {...operation,requestId:"ui-clone",worldId:imported.world.id,name:"AI 克隆副本"});
    assert.notEqual(imported.world.id,duplicate.world.id);
    assert.equal((await page.evaluate(()=>window.toolkit.call("worlds.list"))).worlds.length,2);
    const template = await call("read_game_options");
    await call("update_game_options",{revision:template.revision,overrides:{gfx_max_framerate:"30"}});
    assert.equal((await page.evaluate(()=>window.toolkit.call("game-options.read"))).overrides.gfx_max_framerate,"30");
    const updatedTemplate = await call("read_game_options");
    await call("update_game_options",{revision:updatedTemplate.revision,overrides:{}});
    assert.equal(status.capabilities.autoJoin, true);
    assert.equal(status.capabilities.autoJoinAssertionPolicy, "pause_preserve");
    assert(
      (await client.listTools()).tools.some(
        (t) => t.name === "launch_joined_client",
      ),
    );
    await fs.access(
      path.join(
        process.env.DGN_GAME_TEST_EXE
          ? path.dirname(process.env.DGN_GAME_TEST_EXE) + "/resources"
          : process.cwd(),
        "runtime/automation/ore-window.ps1",
      ),
    );
    const args = {
      instanceId: status.instanceId,
      requestId: "a",
      mode: "debug",
      playerName: "Alpha",
    };
    const a = (await call("launch_client", args)).client;
    const repeat = (await call("launch_client", args)).client;
    assert.equal(a.sessionId, repeat.sessionId);
    const b = (
      await call("launch_client", {
        ...args,
        requestId: "b",
        playerName: "Beta",
      })
    ).client;
    const clients = (await call("list_clients")).clients;
    assert.equal(clients.length, 2);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.mcdkPort, b.mcdkPort);
    assert(clients.every((c) => c.capabilities.code));
    for (const target of [a, b]) {
      await require("./fixtures/navigation.cjs").navigate(page, "运行日志");
      const picker = page.getByRole("combobox", { name: "当前运行会话", exact: true });
      await picker.click();
      await page.getByRole("option").filter({ hasText: target.sessionId === a.sessionId ? "Alpha" : "Beta" }).click();
      await require("./fixtures/navigation.cjs").navigate(page, "游戏调试");
      await page.waitForFunction(async id => {
        const runtime = await window.toolkit.call("launch.state"), debug = await window.toolkit.call("debug.state"), selected = await window.toolkit.call("inspector.state");
        const bridge = debug.sessions.find(s => s.id === selected.selected);
        return runtime.session?.id === id && bridge?.registrationId === runtime.session.bridgeRegistrationId && bridge?.mcdkPid === runtime.session.pid;
      }, target.sessionId);
    }
    const rejectedJoin = await client.callTool({
      name: "launch_joined_client",
      arguments: {
        instanceId: status.instanceId,
        requestId: "reject-menu-as-host",
        hostSessionId: a.sessionId,
        playerName: "JoinInvalid",
      },
    });
    assert(rejectedJoin.isError);
    assert.equal((await call("list_clients")).clients.length, 2);
    for (const c of clients) {
      const answer = await call("execute_client_code", {
        sessionId: c.sessionId,
        generation: c.generation,
        code: "# DGN_MCP_ROUTE_PROBE",
        side: "client",
      });
      assert.equal(answer, c.playerName);
      const logs = await call("client_logs", { sessionId: c.sessionId });
      assert(logs.logs.some((l) => l.text.includes(c.playerName)));
    }
    const snapshots = await fs.readdir(path.join(data, "runs"));
    assert.equal(snapshots.length, 2);
    for (const id of snapshots) {
      const config = JSON.parse(
        await fs.readFile(path.join(data, "runs", id, ".mcdev.json"), "utf8"),
      );
      assert.equal(config.auto_join_game, false);
      assert.equal(config.include_debug_mod, true);
      assert.equal(config.mcp_server_config.enabled, true);
      assert.deepEqual(config.included_mod_dirs, []);
    }
    const stale = await client.callTool({
      name: "execute_client_code",
      arguments: {
        sessionId: b.sessionId,
        generation: 999,
        code: "print(1)",
        side: "client",
      },
    });
    assert(stale.isError);
    await require("./fixtures/navigation.cjs").navigate(page, "设置");
    await page
      .getByRole("button", { name: "关闭 AI MCP", exact: true })
      .click();
    await page
      .getByRole("button", { name: "开启 AI MCP", exact: true })
      .waitFor();
    assert.equal((await call("toolbox_status")).online, false);
    await page
      .getByRole("button", { name: "开启 AI MCP", exact: true })
      .click();
    await page
      .getByRole("button", { name: "关闭 AI MCP", exact: true })
      .waitFor();
    assert.equal((await call("list_clients")).clients.length, 2);
    await call("close_client", { sessionId: b.sessionId, confirmed: true });
    assert(
      (await call("list_clients")).clients.find(
        (c) => c.sessionId === a.sessionId,
      ).running,
    );
    await call("remove_client", { sessionId: b.sessionId });
    await call("close_client", { sessionId: a.sessionId, confirmed: true });
    await page
      .getByRole("button", { name: "刷新 MCP 状态", exact: true })
      .click();
    await fs.mkdir(testResultsRoot, { recursive: true });
    await page.screenshot({
      path: path.join(testResultsRoot, "automation-settings.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS automation UI/stdio: installed bundle, SDK initialize/list/call, two clients, port isolation, code/name/log routing, retry dedup, toggle, targeted stop, clean renderer",
    );
  } finally {
    await client?.close();
    if (app) {
      await app.evaluate(({ app }) => app.quit());
      await app.close();
    }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-automation-ui-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
