// Explicit real-game acceptance. Creates only new worlds and independent sources.
// DGN_LIVE_GAME_EXE is required; DGN_GAME_TEST_EXE optionally selects a packaged app.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { _electron: electron } = require("playwright");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const { ModLibrary } = require("../electron/domains/profiles/mod-library.cjs");
const {
  isolatedEngineVersion,
} = require("../electron/host-isolation-support.cjs");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const game = process.env.DGN_LIVE_GAME_EXE || process.env.DGN_MULTIPLAYER_GAME_EXE;
if (!game || !path.isAbsolute(game))
  throw Error("请指定 DGN_LIVE_GAME_EXE；此测试仅使用新建地图");
const { artifactRoot, testResultsRoot } = require("./fixtures/artifacts.cjs");
(async () => {
  const digest = crypto
    .createHash("sha256")
    .update(await fs.readFile(game))
    .digest("hex");
  const version = isolatedEngineVersion(digest);
  assert(version, "Real-game acceptance requires a registered isolated engine");
  const nonce = crypto.randomBytes(4).toString("hex");
  const root = path.join(artifactRoot, "data");
  // Match the game's Python loader path depth; keep MCDK deployment below MAX_PATH.
  const data = path.join(os.homedir(), ".dgv", "live-" + nonce);
  await fs.mkdir(root, { recursive: true });
  const moduleName = "localLive" + nonce + "Scripts",
    packId = crypto.randomUUID(),
    cases = [];
  const store = new WorkspaceStore(data);
  await store.load();
  const profiles = new Profiles(store);
  await profiles.initialize();
  await store.updateSettings({
    GamePath: game,
    IndependentWorlds: true,
    GameWindowSize: { enabled: true, width: 800, height: 500 },
  });
  const worlds = new WorldLibrary(
    store,
    path.join(data, "game-data/MinecraftPE_Netease/minecraftWorlds"),
  );
  for (const [label, value] of [
    ["A", 101],
    ["B", 202],
  ]) {
    const project = path.join(root, "source" + label),
      scripts = path.join(project, "behavior", moduleName);
    await fs.mkdir(scripts, { recursive: true });
    await fs.writeFile(
      path.join(project, "behavior/manifest.json"),
      JSON.stringify({
        format_version: 1,
        header: {
          name: "Local acceptance " + label,
          uuid: packId,
          version: [1, 0, 0],
        },
        modules: [
          { type: "data", uuid: crypto.randomUUID(), version: [1, 0, 0] },
        ],
      }),
    );
    await fs.writeFile(path.join(scripts, "__init__.py"), "");
    await fs.writeFile(
      path.join(scripts, "rules.py"),
      `def value():\n    return ${value}\n`,
    );
    await fs.writeFile(
      path.join(scripts, "modMain.py"),
      `from mod.common.mod import Mod\nimport ${moduleName}.rules as rules\nOWNER='${label}'\nTOKEN=object()\n@Mod.Binding(name='${moduleName}',version='1.0.0')\nclass Probe(object):\n    @Mod.InitServer()\n    def initServer(self):\n        print('LOCAL_LIVE_SERVER_${label}')\n    @Mod.InitClient()\n    def initClient(self):\n        print('LOCAL_LIVE_CLIENT_${label}')\n`,
    );
    const profile =
      label === "A"
        ? await profiles.read(store.value.projects[0].id)
        : await profiles.create("Acceptance B");
    await profiles.save(profile.project.id, profile.revision, {
      user_name: "LiveHost" + label,
      included_mod_dirs: [project],
      auto_hot_reload_mods: false,
    });
    const world = await worlds.create(profile.project.id, {
      name: "Local acceptance " + label + " " + nonce,
      seed: value,
      worldType: 2,
    });
    cases.push({
      label,
      value,
      project,
      scripts,
      worldId: world.id,
      worldName: world.name,
      profileId: profile.project.id,
      guestName: "LiveGuest" + label + "_" + nonce,
    });
  }
  const mods = new ModLibrary(store, profiles);
  let catalog = await mods.list();
  await mods.addDirectories(
    cases.map((c) => c.project),
    catalog.revision,
  );
  catalog = await mods.list();
  const report = {
    root,
    data,
    version,
    digest,
    moduleName,
    packId,
    cases,
    events: [],
    app: process.env.DGN_GAME_TEST_EXE || "source",
    boundary:
      "Real new worlds, two independent hosts and two guests; no remote tunnel or business worlds",
  };
  let app, page, client, call, ipc;
  const record = async (kind, value) => {
    report.events.push({ at: new Date().toISOString(), kind, value });
    await fs.writeFile(
      path.join(root, "progress.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(kind + " " + JSON.stringify(value));
  };
  const readCode = `import sys, os\n_m=sys.modules.get('${moduleName}.modMain')\n_r=sys.modules.get('${moduleName}.rules')\n_result={'loaded':bool(_m and _r),'owner':getattr(_m,'OWNER',None),'value':_r.value() if _r else None,'token':id(_m.TOKEN) if _m else None,'pid':os.getpid(),'appdata':os.environ.get('APPDATA'),'localdata':os.environ.get('LOCALAPPDATA'),'paths':[p for p in sys.path if 'com.netease' in p or 'download_cache' in p]}`;
  const clients = async () => (await call("list_clients")).clients;
  async function ready(id) {
    for (let n = 0; n < 180; n++) {
      const c = (await clients()).find((x) => x.sessionId === id);
      if (c?.capabilities.code) return c;
      if (c && !c.running) throw Error("Owned test process ended: " + id);
      if (n % 20 === 0) await record("waiting-ready", { id, state: c?.state });
      await wait(1000);
    }
    throw Error("Owned test game readiness timeout");
  }
  async function code(id, text, side = "client") {
    const c = await ready(id);
    return call("execute_client_code", {
      sessionId: id,
      generation: c.generation,
      side,
      code: text,
    });
  }
  const read = (id) => code(id, readCode);
  async function joined(c) {
    for (let n = 0; n < 160; n++) {
      const guest = (await clients()).find((x) => x.playerName === c.guestName);
      if (guest) c.guestId = guest.sessionId;
      if (n % 15 === 0)
        await record("guest-" + c.label, {
          id: guest?.sessionId,
          phase: guest?.autoJoin?.phase,
        });
      if (guest?.running && [16, 24].includes(n)) {
        try {
          const tools = (
            await call("list_client_mcdk_tools", {
              sessionId: guest.sessionId,
              generation: guest.generation,
            })
          ).tools;
          if (tools.some((t) => t.name === "capture_game_window")) {
            const capture = await client.callTool(
              {
                name: "call_client_mcdk_tool",
                arguments: {
                  sessionId: guest.sessionId,
                  generation: guest.generation,
                  name: "capture_game_window",
                  arguments: {},
                },
              },
              undefined,
              { timeout: 10000 },
            );
            for (const [i, item] of capture.content.entries())
              if (item.type === "image")
                await fs.writeFile(
                  path.join(root, `guest-${c.label}-${n}-${i}.jpg`),
                  Buffer.from(item.data, "base64"),
                );
          }
        } catch (e) {
          await record("capture-unavailable", e.message);
        }
      }
      if (guest?.autoJoin?.phase === "joined") {
        assert.equal(guest.autoJoin.hostSessionId, c.hostId);
        assert.equal(guest.storageMode, "isolated");
        assert.equal(guest.engineDigest, digest);
        assert.equal(guest.engineVersion, version);
        return;
      }
      if (
        guest &&
        (!guest.running ||
          ["failed", "needs_attention"].includes(guest.autoJoin?.phase))
      )
        throw Error(JSON.stringify(guest.autoJoin));
      if (!guest && n > 2 && (await page.getByRole("alert").count()))
        throw Error(
          (await page.getByRole("alert").allTextContents()).join("\n"),
        );
      await wait(1000);
    }
    throw Error("Guest did not join selected host " + c.label);
  }
  try {
    console.log("Real acceptance " + root);
    app = await electron.launch({
      ...(process.env.DGN_GAME_TEST_EXE
        ? { executablePath: process.env.DGN_GAME_TEST_EXE, args: [] }
        : { args: [process.cwd()] }),
      env: { ...process.env, DGN_GAME_HEADLESS: "1", DGN_GAME_DATA_DIR: data },
    });
    page = await app.firstWindow();
    await page.getByRole("heading", { name: "存档", exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(
        false,
      ),
    );
    ipc = (method, args = {}) =>
      page.evaluate(({ method, args }) => window.toolkit.call(method, args), {
        method,
        args,
      });
    client = new Client({ name: "real-local-multiplayer", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(data, "mcp/server.cjs"), "--data-dir", data],
        stderr: "pipe",
      }),
    );
    call = async (name, args = {}) => {
      const value = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 110000 },
      );
      const text = value.content?.find((c) => c.type === "text")?.text;
      if (value.isError)
        throw Error(
          text || "MCP operation failed; do not replay unknown effects",
        );
      return JSON.parse(text);
    };
    const status = await call("toolbox_status");
    assert.equal((await clients()).length, 0);
    assert.equal((await call("list_worlds")).worlds.length, 2);
    assert(status.capabilities.isolatedHostGameVersions.includes(version));
    assert(status.capabilities.gameVersions.some(profile => profile.digest === digest && profile.isolatedHost && profile.isolatedClient));
    cases[0].hostId = (
      await call("launch_world", {
        instanceId: status.instanceId,
        requestId: "host-A-" + nonce,
        worldId: cases[0].worldId,
      })
    ).client.sessionId;
    await record("host-A-ready", await read(cases[0].hostId));
    const selected = catalog.mods.find(
      (m) =>
        path.resolve(m.path).toLowerCase() === cases[1].project.toLowerCase(),
    );
    assert(selected);
    const quick = await ipc("launch.quick", {
      worldId: cases[1].worldId,
      modIds: [selected.id],
      revision: catalog.revision,
    });
    cases[1].hostId = quick.selectedSession;
    await record("host-B-ready", await read(cases[1].hostId));
    for (const c of cases) {
      const host = await ready(c.hostId);
      assert.equal(host.storageMode, "isolated");
      assert.equal(host.engineDigest, digest);
      const r = await read(c.hostId);
      assert.equal(r.owner, c.label);
      assert.equal(r.value, c.value);
    }
    // A changed global selection must not replace either running host's build.
    const unregistered = path.join(root, "unregistered.exe");
    await fs.writeFile(unregistered, "not executed");
    await ipc("settings.update", {GamePath:unregistered});
    // UI selection for A and the public MCP hostSessionId route for B.
    await page
      .getByRole("button", { name: "启动联机客户端", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "加入哪个主存档", exact: true })
      .click();
    await page
      .getByRole("option", {
        name: new RegExp("^" + cases[0].worldName + " ·"),
      })
      .click();
    await page
      .getByLabel("联机玩家名", { exact: true })
      .fill(cases[0].guestName);
    await page.getByRole("button", { name: "启动并加入", exact: true }).click();
    await joined(cases[0]);
    await record("guest-A-joined", await read(cases[0].guestId));
    cases[1].guestId = (
      await call("launch_joined_client", {
        instanceId: status.instanceId,
        requestId: "guest-B-" + nonce,
        hostSessionId: cases[1].hostId,
        playerName: cases[1].guestName,
      })
    ).client.sessionId;
    await joined(cases[1]);
    await record("guest-B-joined", await read(cases[1].guestId));
    report.initial = [];
    for (const c of cases) {
      const host = await read(c.hostId),
        guest = await read(c.guestId);
      assert.equal(host.owner, c.label);
      assert.equal(guest.owner, c.label);
      assert.equal(guest.value, c.value);
      const players = await code(
        c.hostId,
        "import mod.server.extraServerApi as api\n_result=[api.GetEngineCompFactory().CreateName(p).GetName() for p in api.GetPlayerList()]",
        "server",
      );
      assert(players.includes(c.guestName));
      assert(!players.includes(cases.find((x) => x !== c).guestName));
      report.initial.push({ label: c.label, host, guest, players });
    }
    const runtimes = report.initial.flatMap((c) => [c.host, c.guest]);
    assert.equal(new Set(runtimes.map((r) => r.appdata.toLowerCase())).size, 4);
    assert.equal(
      new Set(runtimes.map((r) => r.localdata.toLowerCase())).size,
      4,
    );
    for (const r of runtimes) {
      assert(
        path
          .resolve(r.appdata)
          .startsWith(
            path.join(os.homedir(), "DgnGameToolkitHosts") + path.sep,
          ),
      );
      const normalize = (x) => x.replaceAll("\\", "/").toLowerCase();
      assert(
        r.paths.some((p) =>
          normalize(p).startsWith(normalize(r.appdata) + "/"),
        ),
      );
      assert(
        r.paths
          .filter((p) => p.includes("download_cache"))
          .every((p) => normalize(p).startsWith(normalize(r.localdata) + "/")),
      );
    }
    await fs.writeFile(
      path.join(cases[0].scripts, "rules.py"),
      "def value():\n    return 1111\n",
    );
    for (const id of [cases[0].hostId, cases[0].guestId]) {
      const c = await ready(id);
      await call("reload_client", {
        sessionId: id,
        generation: c.generation,
        action: "scripts",
      });
    }
    report.afterReload = [];
    for (const c of cases) {
      const host = await read(c.hostId),
        guest = await read(c.guestId);
      assert.equal(host.value, c.label === "A" ? 1111 : 202);
      assert.equal(guest.value, c.label === "A" ? 1111 : 202);
      report.afterReload.push({ label: c.label, host, guest });
    }
    // Closing A's guest and host must leave B's actual connection usable.
    await call("close_client", {
      sessionId: cases[0].guestId,
      confirmed: true,
    });
    await code(
      cases[0].hostId,
      "import serverlevel\n_result=serverlevel.save_game_data()",
      "server",
    );
    await call("close_client", { sessionId: cases[0].hostId, confirmed: true });
    await wait(2000);
    const bGuest = await read(cases[1].guestId);
    assert.equal(bGuest.owner, "B");
    assert.equal(bGuest.value, 202);
    report.survivingBPlayers = await code(
      cases[1].hostId,
      "import mod.server.extraServerApi as api\n_result=[api.GetEngineCompFactory().CreateName(p).GetName() for p in api.GetPlayerList()]",
      "server",
    );
    assert(report.survivingBPlayers.includes(cases[1].guestName));
    await page.screenshot({ path: path.join(root, "toolbox.png") });
    report.passed = true;
    await record(
      "groups-verified",
      report.initial.map((c) => ({ label: c.label, players: c.players })),
    );
  } catch (e) {
    report.error = e.stack;
    if (ipc) report.state = await ipc("launch.state").catch(() => null);
    console.error(e.stack);
  } finally {
    report.cleanupErrors = [];
    if (call) {
      // This test's own app started empty; include any owned in-flight launch.
      const owned = await clients().catch((e) => {
        report.cleanupErrors.push(e.message);
        return [];
      });
      for (const c of owned.filter((c) => c.running && c.role !== "world"))
        await call("close_client", {
          sessionId: c.sessionId,
          confirmed: true,
        }).catch((e) => report.cleanupErrors.push(e.message));
      for (const c of owned.filter((c) => c.running && c.role === "world")) {
        if (c.capabilities.code)
          await code(
            c.sessionId,
            "import serverlevel\n_result=serverlevel.save_game_data()",
            "server",
          ).catch((e) => report.cleanupErrors.push(e.message));
        await call("close_client", {
          sessionId: c.sessionId,
          confirmed: true,
        }).catch((e) => report.cleanupErrors.push(e.message));
      }
      report.finalClients = await clients().catch(() => []);
    }
    if (client) await client.close();
    if (app) await app.close();
    await fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(report, null, 2),
    );
    await fs.mkdir(testResultsRoot, { recursive: true });
    await fs.writeFile(
      path.join(testResultsRoot, "local-multiplayer-live.json"),
      JSON.stringify(report, null, 2),
    );
    if (!report.passed || report.cleanupErrors.length) process.exitCode = 1;
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
