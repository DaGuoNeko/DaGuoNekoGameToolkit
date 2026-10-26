// 显式指定已安装游戏，仅启动本测试新建的存档；通过真实 MCP/IPC 验证本机入房。
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto"),
  { _electron: electron } = require("playwright");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const {
  inspectEngine,
} = require("../electron/domains/client/engine-profiles.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect(root) {
  const c = JSON.parse(
    await fs.readFile(path.join(root, "mcp/connection.json"), "utf8"),
  );
  assert(Number.isInteger(c.port) && c.port > 0 && c.port < 65536);
  assert(/^[a-f0-9]{64}$/.test(c.token));
  return async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${c.port}/call`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(110000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + c.token,
      },
      body: JSON.stringify({ name, arguments: args, instanceId: c.instanceId }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "MCP request failed");
    if (name === "call_client_mcdk_tool") return result;
    return JSON.parse(result.content[0].text);
  };
}
(async () => {
  const engine = await inspectEngine(process.env.DGN_MULTIPLAYER_GAME_EXE);
  assert(
    engine.profile?.autoJoin &&
      engine.profile.isolatedHost &&
      engine.profile.isolatedClient,
    "此测试要求已登记独立主机和来宾能力的构建",
  );
  let baseline,
    baselineClients = [];
  try {
    baseline = await connect(
      path.join(process.env.LOCALAPPDATA, "DaGuoNeko_GameToolkit"),
    );
    await baseline("toolbox_status");
    baselineClients = (await baseline("list_clients")).clients
      .filter((c) => c.running)
      .map((c) => c.sessionId);
    await baseline("list_worlds");
    console.log(
      "Existing toolbox inspected; active sessions preserved: " +
        baselineClients.length,
    );
  } catch (error) {
    if (error.code !== "ENOENT" && error.cause?.code !== "ECONNREFUSED")
      throw error;
    baseline = null;
    console.log(
      "No active default toolbox connection; using new test instance",
    );
  }
  const root = path.resolve("../.miao/test-data/multiplayer-" + Date.now());
  const store = new WorkspaceStore(root);
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  await store.updateSettings({
    GamePath: engine.file,
    IndependentWorlds: true,
    AutomationEnabled: true,
    GameWindowSize: { enabled: true, width: 800, height: 600 },
  });
  const profile = await profiles.read(store.value.projects[0].id);
  await profiles.save(profile.project.id, profile.revision, {
    included_mod_dirs: [],
    user_name: "VersionHost",
    auto_hot_reload_mods: false,
  });
  const worlds = new WorldLibrary(
    store,
    path.join(root, "game-data/MinecraftPE_Netease/minecraftWorlds"),
  );
  const world = await worlds.create(profile.project.id, {
    name: "Version acceptance",
  });
  const options = path.join(
    root,
    "game-data/MinecraftPE_Netease/minecraftpe/options.txt",
  );
  await fs.mkdir(path.dirname(options), { recursive: true });
  await fs.writeFile(
    options,
    "gfx_max_framerate:30\ngfx_viewdistance:64\naudio_main:0\n",
  );
  let app, call, ipc, hostId, guestId;
  const report = { version: engine.version, passed: false, checks: [] };
  try {
    app = await electron.launch({
      args: [process.cwd()],
      env: { ...process.env, DGN_GAME_DATA_DIR: root, DGN_GAME_HEADLESS: "1" },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.toolkit);
    ipc = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.toolkit.call(method, args), {
        method,
        args,
      });
    call = await connect(root);
    const status = await call("toolbox_status");
    assert.equal((await call("list_clients")).clients.length, 0);
    assert((await call("list_worlds")).worlds.some((w) => w.id === world.id));
    assert(
      status.capabilities.gameVersions.some((p) => p.digest === engine.digest),
    );
    const discovered = await ipc("games.discover");
    assert(
      discovered.games.some(
        (g) => g.engineVersion === engine.version && g.engineProfile?.autoJoin,
      ),
    );
    hostId = (
      await call("launch_world", {
        worldId: world.id,
        instanceId: status.instanceId,
        requestId: randomUUID(),
      })
    ).client.sessionId;
    assert(hostId);
    async function until(label, fn, timeout = 150000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const result = await fn();
        if (result) return result;
        await sleep(1000);
      }
      throw Error(label + " timeout");
    }
    const host = await until("host ready", async () => {
      const c = (await call("list_clients")).clients.find(
        (c) => c.sessionId === hostId,
      );
      if (!c?.running) throw Error("Host stopped before ready");
      return c.state === "game_ready" && c.capabilities.code && c;
    });
    assert.equal(host.storageMode, "isolated");
    assert.equal(host.engineDigest, engine.digest);
    console.log("Host ready: " + host.engineVersion);
    // 改全局版本后，来宾仍必须跟随运行房主，而非使用新全局值。
    const other = path.join(root, "unregistered.exe");
    await fs.writeFile(other, "not executed");
    await ipc("settings.update", { GamePath: other });
    guestId = (
      await call("launch_joined_client", {
        hostSessionId: hostId,
        playerName: "VersionGuest",
        instanceId: status.instanceId,
        requestId: randomUUID(),
      })
    ).client.sessionId;
    assert(guestId);
    const guest = await until("guest join", async () => {
      const c = (await call("list_clients")).clients.find(
        (c) => c.sessionId === guestId,
      );
      if (["failed", "needs_attention"].includes(c?.autoJoin?.phase))
        throw Error(c.autoJoin.message);
      return c?.autoJoin?.phase === "joined" && c;
    });
    assert.equal(guest.engineDigest, host.engineDigest);
    assert.equal(guest.engineVersion, engine.version);
    assert.equal(guest.storageMode, "isolated");
    assert.equal(guest.autoJoin.hostSessionId, hostId);
    const state = await ipc("launch.state"),
      sessions = state.sessions.filter((s) => [hostId, guestId].includes(s.id));
    assert.equal(new Set(sessions.map((s) => s.isolationRoot)).size, 2);
    const result = await call("execute_client_code", {
      sessionId: hostId,
      generation: host.generation,
      side: "server",
      code: "import mod.server.extraServerApi as api\n_result={'players':[str(p) for p in api.GetPlayerList()]}",
    });
    assert(result.players.includes(guest.autoJoin.playerId));
    assert.equal(result.players.length, 2);
    report.checks.push(
      "real host/guest joined and server receipt",
      "same build despite changed global selection",
      "separate host/guest data roots",
    );
    await call("close_client", { sessionId: guestId, confirmed: true });
    guestId = null;
    assert(
      (await call("list_clients")).clients.find((c) => c.sessionId === hostId)
        .running,
    );
    report.checks.push("stopping guest preserves host");
    report.passed = true;
    console.log("PASS real local multiplayer " + engine.version);
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try {
      if (call) {
        const owned = (await call("list_clients")).clients
          .filter((c) => c.running)
          .reverse();
        for (const client of owned)
          await call("close_client", {
            sessionId: client.sessionId,
            confirmed: true,
          });
        assert.equal(
          (await call("list_clients")).clients.filter((c) => c.running).length,
          0,
        );
      }
    } finally {
      if (app) await app.close();
    }
    if (baseline) {
      const after = (await baseline("list_clients")).clients
        .filter((c) => c.running)
        .map((c) => c.sessionId);
      for (const id of baselineClients)
        assert(after.includes(id), "Existing user session no longer running");
    }
    await fs.mkdir("test-results", { recursive: true });
    await fs.writeFile(
      "test-results/local-multiplayer-live.json",
      JSON.stringify(report, null, 2),
    );
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
