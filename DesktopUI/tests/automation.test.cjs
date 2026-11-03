const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  net = require("node:net");
const { AutomationRouter } = require("../electron/domains/automation/automation-router.cjs");
const { AutomationBridge } = require("../electron/domains/automation/automation-bridge.cjs");
const {
  allocateMcp,
  ownedEndpoint,
  parseListeners,
  withMcdk,
} = require("../electron/domains/automation/mcp-endpoint.cjs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
function fixture() {
  const calls = [],
    workers = [1, 2].map((i) => ({
      session: {
        id: "client" + i,
        pid: 100 + i,
        running: true,
        bridgeRegistrationId: "reg" + i,
        userName: "player" + i,
      },
      logs: [{ id: 1, text: "only-" + i }],
      sourceSnapshot: {
        config: {
          mcp_server_config: { enabled: true, server_port: 19132 + i },
        },
      },
    }));
  const bridges = workers.map((w, i) => ({
    id: "bridge" + (i + 1),
    registrationId: w.session.bridgeRegistrationId,
    mcdkPid: w.session.pid,
    connected: true,
    connectionGeneration: 4,
    stateSequence: 1,
    minecraftPid: 200 + i,
    state: "game_ready",
    gameIpcConnected: true,
    debugCapabilityEnabled: true,
  }));
  const sessions = {
    workers,
    async start(...args) {
      calls.push(["start", ...args]);
      await new Promise((r) => setTimeout(r, 10));
      return { selectedSession: "client2" };
    },
    async stop(id) {
      calls.push(["stop", id]);
    },
    async remove(id) {
      calls.push(["remove", id]);
    },
  };
  const debug = {
    snapshot: () => ({ sessions: bridges }),
    session(id, generation) {
      const b = bridges.find((b) => b.id === id);
      if (generation !== b.connectionGeneration)
        throw Error("stale generation");
      return b;
    },
    async code(...args) {
      calls.push(["code", ...args]);
      if (String(args[2]).includes("DGN_AUTOMATION_READINESS"))
        return { world: "fixture-world", playerId: "123", position:[0,4,0],topUI:"hud_screen" };
      return "ok";
    },
    async reload(args) {
      calls.push(["reload", args]);
      return "accepted";
    },
  };
  const router = new AutomationRouter({
    sessions,
    debug,
    worlds: {
      list: async () => ({
        worlds: [{ id: "world", profileId: "profile", name: "world" }],
      }),
      importWorld: async (profileId, name, source, mode) => ({
        id: "w_imported",
        profileId,
        name,
        source,
        mode,
      }),
    },
    store: {
      value: {
        settings: { IndependentWorlds: true, AutomationEnabled: true },
        projects: [{ id: "profile", name: "fixture", secret: "not exposed" }],
      },
      async updateSettings(patch) {
        this.value.settings = { ...this.value.settings, ...patch };
        return this.value;
      },
      async settingsRevision() { return "settings-rev"; },
    },
    profiles: {
      async read(id) {
        return {
          project: { id, name: "fixture", root: "C:/fixture" },
          revision: "rev",
          raw: '{"user_name":"fixture"}',
          config: { user_name: "fixture" },
        };
      },
      async save(id, revision, patch, raw) {
        return {
          project: { id, name: "fixture", root: "C:/fixture" },
          revision: "next",
          raw: raw || JSON.stringify(patch),
          config: patch || { user_name: "fixture" },
        };
      },
    },
    gameOptions: {
      async snapshot() {
        return { revision: "options-rev", overrides: {}, current: {} };
      },
      async save(revision, overrides) {
        return { revision: "options-next", overrides, current: {} };
      },
    },
    inspectWindow: async () => ({pid:200,processCreatedAt:"123",window:{hwnd:12,width:800,height:500,visible:true,minimized:false},assertions:[]}),
    captureWindow: async () => ({data:Buffer.from("image"),width:800,height:500,backend:"fixture",frameTimestamp:null}),
    proxy: async (worker, check, action) => {
      check();
      calls.push(["proxy", worker.session.id, action]);
      return {
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      };
    },
  });
  return { router, workers, bridges, calls };
}
const json = (value) => JSON.parse(value.content[0].text);
test("MCP accepts int32 custom dimension IDs such as 818555435", () => {
  const { validate } = require("../electron/domains/automation/automation-tools.cjs");
  validate("probe_dimension_runtime", { sessionId: "client1", generation: 1, instanceId: "instance", requestId: "dimension", confirmed: true, dimension: 818555435 });
  assert.throws(() => validate("probe_dimension_runtime", { sessionId: "client1", generation: 1, instanceId: "instance", requestId: "dimension-overflow", confirmed: true, dimension: 2147483648 }));
});
test("asset preflight report mode requires explicit confirmation and retains its findings", async () => {
  const {router,calls}=fixture();
  router.worlds.validateAssets=async()=>({ok:false,digest:"fixture-digest",errors:[{type:"fixture_warning"}]});
  const args={instanceId:router.instanceId,worldId:"world"};
  await assert.rejects(router.call("launch_world",{...args,requestId:"strict"}),/PREFLIGHT_FAILED/);
  await assert.rejects(router.call("launch_world",{...args,requestId:"unconfirmed",assetPreflight:"report"}),/确认/);
  assert.equal(calls.length,0);
  const result=json(await router.call("launch_world",{...args,requestId:"confirmed",assetPreflight:"report",confirmed:true}));
  assert.equal(calls.length,1);assert.equal(result.assetPreflight.errorCount,1);assert.equal(result.assetPreflight.ok,false);
});
test("MCP reports isolated engine versions and the actual running compatibility reason", async () => {
  const { router, workers } = fixture();
  router.sessions.isolation = {};
  router.store.value.settings = { IndependentWorlds: true };
  const status = json(await router.call("toolbox_status", {}));
  assert.deepEqual(status.capabilities.isolatedHostGameVersions, [
    "3.10.0.436581",
    "3.10.0.448891",
  ]);
  assert.equal(status.capabilities.terrainAutomation.buildHeightProbe, "isolated_only");
  const largeDimension = await router.call("toolbox_status", {});
  assert.equal(JSON.parse(largeDimension.content[0].text).online, true);
  workers[0].session.storageMode = "shared";
  workers[0].session.isolationReason = "当前游戏程序尚未适配独立主机";
  const clients = json(await router.call("list_clients", {})).clients;
  assert.equal(clients[0].storageMode, "shared");
  assert.equal(clients[0].isolationReason, workers[0].session.isolationReason);
  assert.equal(clients[1].isolationReason, null);
});

test("automation publishes the same registered capabilities and immutable session identity", async () => {
  const { router, workers } = fixture();
  router.sessions.isolation = {};
  router.store.value.settings = { IndependentWorlds: true };
  const { profilesForDiscovery } = require("../electron/domains/client/engine-profiles.cjs");
  const profiles = profilesForDiscovery();
  workers[0].session.engineDigest = profiles[0].digest;
  workers[0].session.engineVersion = profiles[0].version;
  workers[0].session.engineProfile = profiles[0];
  const status = json(await router.call("toolbox_status"));
  assert.deepEqual(status.capabilities.gameVersions, profiles);
  assert.deepEqual(status.capabilities.isolatedHostGameVersions, profiles.filter(p => p.isolatedHost).map(p => p.version));
  assert.equal(status.clients[0].engineDigest, profiles[0].digest);
  assert.equal(status.clients[0].engineProfile.isolatedHost, false);
});

test("control-plane MCP observes clients and routes project, settings, import and scene operations", async () => {
  const { router } = fixture();
  const ready = json(
    await router.call("client_readiness", {
      sessionId: "client1",
      generation: 4,
    }),
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.world, "fixture-world");
  assert.equal(ready.playerLoaded, true);
  const waited = json(
    await router.call("wait_client_ready", {
      sessionId: "client1",
      generation: 4,
      timeoutMs: 100,
      pollMs: 100,
    }),
  );
  assert.equal(waited.timedOut, false);
  assert.deepEqual(
    json(await router.call("list_client_assertions", { sessionId: "client1", generation:4 })).assertions,
    [],
  );
  assert.equal(json(await router.call("list_projects")).projects[0].id, "profile");
  assert.equal(
    json(await router.call("read_project", { projectId: "profile" })).revision,
    "rev",
  );
  assert.equal(
    json(
      await router.call("update_project", {
        projectId: "profile",
        revision: "rev",
        patch: { user_name: "next" },
      }),
    ).revision,
    "next",
  );
  assert.equal(json(await router.call("read_settings")).settings.IndependentWorlds, true);
  assert.equal(
    json(await router.call("update_settings", { revision:"settings-rev", patch: { IndependentWorlds: false } })).settings
      .IndependentWorlds,
    false,
  );
  assert.equal(json(await router.call("read_game_options")).revision, "options-rev");
  assert.equal(
    json(
      await router.call("update_game_options", {
        revision: "options-rev",
        overrides: { gfx_max_framerate: "30" },
      }),
    ).revision,
    "options-next",
  );
  const imported = json(
    await router.call("import_world", {
      instanceId: router.instanceId,
      requestId: "import-one",
      name: "fixture world",
      source: "C:/fixture-world",
      confirmed: true,
    }),
  );
  assert.equal(imported.world.mode, "copy");
  const screenshot = await router.call("capture_client_window", {
    sessionId: "client1",
    generation: 4,
  });
  assert.equal(screenshot.content[0].type, "image");
  await assert.rejects(router.call("capture_scene", {
    sessionId: "client1",
    generation: 4,
    confirmed: true,
    instanceId:router.instanceId,requestId:"scene",settings:{},
  }), /SCENE_HOST_REQUIRED/);
});

test("automation routes logs/code/MCDK/stop to explicit client and rejects stale/foreign session", async () => {
  const { router, calls, bridges } = fixture();
  assert.equal(
    json(await router.call("client_logs", { sessionId: "client2" })).logs[0]
      .text,
    "only-2",
  );
  await router.call("execute_client_code", {
    sessionId: "client2",
    generation: 4,
    code: "print(2)",
    side: "client",
  });
  assert.deepEqual(calls[0], ["code", "bridge2", 4, "print(2)", true]);
  const image = await router.call("call_client_mcdk_tool", {
    sessionId: "client2",
    generation: 4,
    name: "capture_game_window",
    arguments: {},
  });
  assert.equal(image.content[0].type, "image");
  assert.equal(calls[1][1], "client2");
  await assert.rejects(
    router.call("execute_client_code", {
      sessionId: "client2",
      generation: 3,
      code: "print(2)",
      side: "client",
    }),
    /stale/,
  );
  bridges[1].mcdkPid = 999;
  await assert.rejects(
    router.call("execute_client_code", {
      sessionId: "client2",
      generation: 4,
      code: "print(2)",
      side: "client",
    }),
    /Host Bridge/,
  );
  await assert.rejects(
    router.call("close_client", { confirmed: true }),
    /参数无效/,
  );
  await router.call("close_client", { sessionId: "client1", confirmed: true });
  assert.deepEqual(calls.at(-1), ["stop", "client1"]);
  await assert.rejects(
    router.call("call_client_mcdk_tool", {
      sessionId: "client1",
      generation: 4,
      name: "reload_game",
      arguments: {},
    }),
    /reload_client/,
  );
  assert(
    !JSON.stringify(await router.call("list_launch_profiles", {})).includes(
      "secret",
    ),
  );
});
test("launch retries deduplicate, preserve names, serialize starts and reject reused or old instance IDs", async () => {
  const { router, calls } = fixture();
  const args = {
    instanceId: router.instanceId,
    requestId: "same",
    playerName: "a",
    mode: "debug",
  };
  const values = await Promise.all([
    router.call("launch_client", args),
    router.call("launch_client", args),
    router.call("launch_client", {
      ...args,
      requestId: "second",
      playerName: "b",
    }),
  ]);
  assert.deepEqual(values[0], values[1]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [
    "start",
    null,
    null,
    { userName: "a" },
    { debug: true, playerName: "a" },
  ]);
  await assert.rejects(
    router.call("launch_client", { ...args, playerName: "changed" }),
    /requestId/,
  );
  await assert.rejects(
    router.call("launch_client", { ...args, instanceId: "old" }),
    /instanceId/,
  );
  await router.call("launch_world", {
    instanceId: router.instanceId,
    requestId: "world-start",
    worldId: "world",
  });
  assert.deepEqual(calls.at(-1), [
    "start",
    "profile",
    "world",
    null,
    { debug: true },
  ]);
});
test("port selection avoids conflicts and proxy refuses ports owned by another process", async (t) => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const original = {
    enabled: true,
    server_ip: "127.0.0.1",
    server_port: server.address().port,
  };
  const selected = await allocateMcp(original);
  assert.notEqual(selected.server_port, original.server_port);
  const rows = parseListeners(
    `  TCP    127.0.0.1:${selected.server_port}   0.0.0.0:0  LISTENING  888\n TCP [::1]:19133 [::]:0 LISTENING 999`,
  );
  await assert.rejects(
    ownedEndpoint(selected, 777, async () => rows),
    /不属于/,
  );
  assert.equal(
    await ownedEndpoint(selected, 888, async () => rows),
    `http://127.0.0.1:${selected.server_port}/mcp`,
  );
  await assert.rejects(
    ownedEndpoint(
      { ...selected, server_ip: "example.com" },
      888,
      async () => rows,
    ),
    /回环/,
  );
});

test("real IPv6 loopback listener is discovered and foreign PID is refused", async (t) => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "::1", resolve);
  });
  t.after(() => new Promise((r) => server.close(r)));
  const config = {
    enabled: true,
    server_ip: "localhost",
    server_port: server.address().port,
  };
  assert.equal(
    await ownedEndpoint(config, process.pid),
    `http://[::1]:${config.server_port}/mcp`,
  );
  await assert.rejects(ownedEndpoint(config, process.pid + 100000), /不属于/);
});

test("joined-client MCP deduplicates startup and exposes background join state", async () => {
  const { router, workers } = fixture();
  let starts = 0;
  router.joiner = {
    async launch(host, name) {
      starts++;
      assert.equal(host, "client1");
      assert.equal(name, "Guest");
      workers[1].session.autoJoin = {
        phase: "waiting_menu",
        hostSessionId: host,
      };
      return "client2";
    },
  };
  const args = {
    instanceId: router.instanceId,
    requestId: "joined-once",
    hostSessionId: "client1",
    playerName: "Guest",
  };
  const [a, b] = await Promise.all([
    router.call("launch_joined_client", args),
    router.call("launch_joined_client", args),
  ]);
  assert.equal(starts, 1);
  assert.deepEqual(a, b);
  assert.equal(json(a).client.autoJoin.phase, "waiting_menu");
  workers[1].session.autoJoin.phase = "joined";
  assert.equal(
    json(await router.call("list_clients")).clients[1].autoJoin.phase,
    "joined",
  );
});
test("authenticated loopback bridge + real SDK stdio client supports offline tools, blocks browser and foreign token", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-automation-"));
  const { router } = fixture(),
    bridge = new AutomationBridge(root, router);
  t.after(async () => {
    await bridge.setEnabled(false);
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  });
  await bridge.setEnabled(true);
  const c = JSON.parse(
    await fs.readFile(path.join(root, "mcp/connection.json"), "utf8"),
  );
  const url = `http://127.0.0.1:${c.port}/call`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + c.token,
  };
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, Origin: "https://example.com" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert(!JSON.stringify(bridge.status()).includes(c.token));
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve("electron/domains/automation/automation-stdio.cjs"),
      "--data-dir",
      root,
    ],
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.match(
    client.getInstructions(),
    /本地多人测试默认使用存档房主 \+ 多开客户端/,
  );
  assert.match(client.getInstructions(), /只有用户明确要求远程联机/);
  const guidance = json(
    await client.callTool({ name: "toolbox_status", arguments: {} }),
  ).localMultiplayer;
  assert.equal(guidance.scope, "local_host_and_clients");
  assert.ok(guidance.steps.includes("launch_joined_client"));
  assert.equal((await client.listTools()).tools.length, 42);
  assert.equal(
    json(await client.callTool({ name: "toolbox_status", arguments: {} }))
      .online,
    true,
  );
  assert.equal(
    json(
      await client.callTool({
        name: "client_logs",
        arguments: { sessionId: "client2" },
      }),
    ).logs[0].text,
    "only-2",
  );
  await bridge.setEnabled(false);
  assert.equal(
    json(await client.callTool({ name: "toolbox_status", arguments: {} }))
      .online,
    false,
  );
  assert.equal((await client.listTools()).tools.length, 42);
});
test("MCDK proxy performs real HTTP initialize/list/call and preserves image content", async (t) => {
  const http = require("node:http");
  const transports = new Set();
  const httpServer = http.createServer(async (req, res) => {
    const server = new Server(
      { name: "fake-mcdk", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "capture_game_window",
          description: "fixture",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    transports.add(transport);
    res.on("close", () => {
      transport.close();
      transports.delete(transport);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const tr of transports) await tr.close();
    httpServer.closeAllConnections();
    await new Promise((r) => httpServer.close(r));
  });
  const port = httpServer.address().port;
  const worker = {
    session: { pid: 123 },
    sourceSnapshot: {
      config: {
        mcp_server_config: {
          enabled: true,
          server_ip: "127.0.0.1",
          server_port: port,
        },
      },
    },
  };
  let checked = 0;
  const response = await withMcdk(
    worker,
    () => {
      checked++;
    },
    { name: "capture_game_window", arguments: {} },
    async () => [{ host: "127.0.0.1", port, pid: 123 }],
  );
  assert.equal(response.content[0].type, "image");
  assert(checked >= 4);
});
