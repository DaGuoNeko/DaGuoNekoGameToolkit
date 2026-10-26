const { test } = require("node:test"),
  assert = require("node:assert/strict");
const {
  locateMenu,
} = require("../electron/domains/client/client-join-menu.cjs");
const { ClientJoiner } = require("../electron/domains/client/client-join.cjs");
const { OreJoin } = require("../electron/domains/client/ore-join.cjs");
const {
  proofCode,
} = require("../electron/domains/client/client-join-proof.cjs");
function frame(lines) {
  return {
    hwnd: 88,
    width: 1920,
    height: 1080,
    lines: lines.map(([text, x, y]) => ({
      text,
      words: [{ text, x, y, width: 0.08, height: 0.02 }],
    })),
  };
}
test("menu recognition separates LAN cards from local saves, requires unique identity and never clicks unknown prompts", () => {
  const f = frame([
    ["开始游戏", 0.4, 0.5],
    ["设置", 0.4, 0.6],
  ]);
  assert.equal(locateMenu(f, "room", "Host").kind, "play");
  const cards = frame([
    ["创建新世界", 0.5, 0.2],
    ["局域网世界", 0.02, 0.28],
    ["room", 0.03, 0.52],
    ["Host's World", 0.03, 0.56],
    ["room", 0.3, 0.52],
  ]);
  const choice = locateMenu(cards, "room", "Host");
  assert.equal(choice.kind, "room");
  assert.equal(choice.box.x, 0.03);
  const fallback = frame([
    ["局域网世界", 0.02, 0.28],
    ["dsaS8", 0.03, 0.52],
    ["大 果 喵 的 世 界", 0.03, 0.56],
  ]);
  assert.equal(locateMenu(fallback, "dsa88", "大果喵").kind, "waiting");
  const ambiguous = frame([
    ["局域网世界", 0.02, 0.28],
    ["room", 0.03, 0.52],
    ["局域网世界", 0.3, 0.28],
    ["room", 0.31, 0.52],
  ]);
  assert.equal(locateMenu(ambiguous, "room", "Host").kind, "error");
  assert.equal(
    locateMenu(
      frame([
        ["创建新世界", 0.5, 0.2],
        ["room", 0.03, 0.52],
      ]),
      "room",
      "Host",
    ).kind,
    "waiting",
  );
  assert.equal(
    locateMenu(frame([["下载并加入", 0.3, 0.5]]), "room", "Host", false).kind,
    "waiting",
  );
  assert.equal(
    locateMenu(frame([["下载并加入", 0.3, 0.5]]), "room", "Host", true).kind,
    "download",
  );
});
function fixture(t, mutate = {}) {
  const host = {
    session: {
      id: "host",
      projectId: "p",
      role: "world",
      worldId: "w",
      running: true,
      pid: 10,
      userName: "Host",
      bridgeRegistrationId: "hr",
    },
    sourceSnapshot: {
      config: {
        world_name: "Room",
        game_executable_path: "C:/game.exe",
        included_mod_dirs: [],
      },
    },
  };
  const child = {
    session: {
      id: "child",
      running: true,
      pid: 20,
      userName: "Joined",
      bridgeRegistrationId: "cr",
    },
    log: (...v) => logs.push(v),
  };
  const hb = {
    id: "h",
    connected: true,
    state: "game_ready",
    gameIpcConnected: true,
    debugCapabilityEnabled: true,
    registrationId: "hr",
    mcdkPid: 10,
    minecraftPid: 11,
    connectionGeneration: 1,
    stateSequence: 2,
  };
  const cb = {
    ...hb,
    id: "c",
    registrationId: "cr",
    mcdkPid: 20,
    minecraftPid: 21,
    state: "process_started",
  };
  const logs = [],
    stops = [],
    clicks = [];
  let captures = 0,
    ackReads = 0,
    prepared = 0;
  const sessions = {
    workers: [host],
    publish() {},
    async start(p, w, b, a) {
      assert.equal(p, null);
      assert.equal(w, null);
      assert.deepEqual(b, { userName: "Joined" });
      assert.equal(a.localJoin, true);
      assert.equal(a.runtimeConfig.world_name, "Room");
      this.workers.push(child);
      await a.prepareClient(child, cb);
      return { selectedSession: "child" };
    },
    async stop(id) {
      stops.push(id);
      child.session.running = false;
    },
  };
  const debug = {
    snapshot: () => ({ sessions: [hb, cb] }),
    session(id, g, ready = false) {
      const b = id === "h" ? hb : cb;
      if (b.connectionGeneration !== g) throw Error("stale");
      if (ready && b.state !== "game_ready") throw Error("尚未进入世界");
      return b;
    },
    async code(id, g, code, client) {
      if (code.includes("netherNetId"))
        return {
          netherNetId: mutate.numericId
            ? 16965508177096150310
            : "16965508177096150310",
        };
      if (code.includes("class DgnJoinProof")) {
        prepared++;
        return true;
      }
      if (code.includes("s.NotifyToServer")) return { playerId: "player-21" };
      if (code.includes("o.seen[:]")) {
        ackReads++;
        return { players: ackReads > 1 && !mutate.noAck ? ["player-21"] : [] };
      }
      return true;
    },
  };
  const transport = {
    async create() {
      if (mutate.unsupported) throw Error("unsupported engine");
      return { engine: { version: "test" } };
    },
    async prepare(c, w, b) {
      Object.assign(c, {
        pid: b.minecraftPid,
        registration: b.id,
        generation: b.connectionGeneration,
      });
      if (mutate.prepareGate) await mutate.prepareGate;
    },
    async open(c, check, progress, deadline, onAssertion) {
      Object.assign(c, { check, deadline, onAssertion });
      await new Promise((r) => setTimeout(r, 1));
      check();
    },
    async inspect() {},
    async discover(c, target) {
      captures++;
      assert.equal(target.netherNetId, "16965508177096150310");
      if (mutate.hostReload) hb.stateSequence++;
      if (mutate.generation) cb.connectionGeneration++;
      return { id: "native-room" };
    },
    async dispatch(c, row) {
      clicks.push(row);
      if (mutate.dispatchTimeout) throw Error("result unknown");
      cb.state = "game_ready";
    },
    async status() {},
    async close(c) {
      if (mutate.sealFailure && child.session.running)
        throw Error("seal failed");
      c.closed = true;
    },
  };
  const joiner = new ClientJoiner(sessions, debug, "unused", {
    transport,
    roomName: async () => {
      if (mutate.invalidRoom) throw Error("invalid LevelName");
      return { name: "RPG10.3回来后", source: "level.dat/LevelName" };
    },
    wait: () => new Promise((r) => setTimeout(r, 1)),
    timeoutMs: 200,
  });
  t.after(() => joiner.shutdown());
  return {
    joiner,
    host,
    child,
    sessions,
    stops,
    clicks,
    hb,
    logs,
    cb,
    transport,
    stats: () => ({ captures, ackReads, prepared }),
  };
}
test("isolated host discovery is scoped to the owned pair and always released", async (t) => {
  const f = fixture(t);
  f.host.session.storageMode = "isolated";
  let closed = 0,
    checked = 0;
  f.joiner.discovery = {
    async open(host, hb, guest, gb, identity, check) {
      assert.equal(host, f.host);
      assert.equal(guest, f.child);
      assert.equal(hb.minecraftPid, 11);
      assert.equal(gb.minecraftPid, 21);
      assert.equal(identity, "16965508177096150310");
      check();
      return {
        close() {
          closed++;
        },
        assert() {
          checked++;
        },
      };
    },
  };
  await f.joiner.launch("host", "Joined");
  await f.joiner.jobs.get("child").promise;
  assert.equal(f.child.session.autoJoin.phase, "joined");
  assert.equal(closed, 1);
  assert(checked > 0);
});
test("native join dispatches once and waits for host receipt instead of game_ready alone", async (t) => {
  const f = fixture(t);
  const id = await f.joiner.launch("host", "Joined");
  assert.equal(id, "child");
  await f.joiner.jobs.get(id).promise;
  assert.equal(f.child.session.autoJoin.phase, "joined");
  assert.equal(f.child.session.autoJoin.worldName, "RPG10.3回来后");
  assert.equal(f.child.session.autoJoin.libraryWorldName, "Room");
  assert.equal(f.host.sourceSnapshot.config.world_name, "Room");
  assert.equal(f.child.session.autoJoin.playerId, "player-21");
  assert.equal(f.clicks.length, 1);
  assert.equal(f.stats().ackReads, 2);
  assert.deepEqual(f.stops, []);
  assert(f.host.session.running);
});
test("local host picker lists only owned running hosts and reports readiness without executing game code", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.joiner.hosts().map((h) => [h.sessionId, h.worldName, h.ready]),
    [["host", "Room", true]],
  );
  f.sessions.workers.push(f.child);
  assert.equal(f.joiner.hosts().length, 1);
  f.hb.state = "game_unavailable";
  assert.equal(f.joiner.hosts()[0].ready, false);
  f.host.stopping = true;
  assert.deepEqual(f.joiner.hosts(), []);
  assert.equal(f.stats().prepared, 0);
});
test("concurrent starts reserve the player name before async host preparation", async (t) => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const f = fixture(t, { prepareGate: gate });
  const first = f.joiner.launch("host", "Joined");
  await assert.rejects(f.joiner.launch("host", "Joined"), /同名客户端正在启动/);
  release();
  const id = await first;
  await f.joiner.jobs.get(id).promise;
  assert.equal(f.child.session.autoJoin.phase, "joined");
  assert.equal(f.joiner.pendingNames.size, 0);
});
test("two guest groups retain the selected host snapshot, exact room identity and host-specific proof", async (t) => {
  const bridges = new Map(),
    workers = [],
    dispatched = [],
    proofReads = [],
    stops = [];
  for (const key of ["A", "B"]) {
    const session = {
      id: "host-" + key,
      projectId: "quick-" + key,
      role: "world",
      worldId: "world-" + key,
      worldName: "World " + key,
      running: true,
      pid: workers.length + 10,
      userName: "Host" + key,
      bridgeRegistrationId: "reg-" + key,
    };
    workers.push({
      session,
      sourceSnapshot: {
        config: {
          world_name: "World " + key,
          game_executable_path: "C:/Game.exe",
          included_mod_dirs: ["C:/mods/" + key],
        },
      },
      log() {},
    });
    bridges.set("bridge-" + key, {
      id: "bridge-" + key,
      registrationId: session.bridgeRegistrationId,
      mcdkPid: session.pid,
      minecraftPid: session.pid + 100,
      connected: true,
      connectionGeneration: 1,
      stateSequence: 1,
      state: "game_ready",
      gameIpcConnected: true,
      debugCapabilityEnabled: true,
    });
  }
  const sessions = {
    workers,
    publish() {},
    async start(profile, world, blank, options) {
      assert.equal(profile, null);
      assert.equal(world, null);
      const key = options.runtimeConfig.world_name.slice(-1),
        id = "guest-" + key,
        b = {
          id: "client-" + key,
          registrationId: "guest-reg-" + key,
          mcdkPid: workers.length + 30,
          minecraftPid: workers.length + 130,
          connected: true,
          connectionGeneration: 1,
          stateSequence: 1,
          state: "process_started",
          gameIpcConnected: true,
          debugCapabilityEnabled: true,
        };
      const w = {
        session: {
          id,
          running: true,
          pid: b.mcdkPid,
          userName: blank.userName,
          bridgeRegistrationId: b.registrationId,
        },
        sourceSnapshot: { config: structuredClone(options.runtimeConfig) },
        log() {},
      };
      workers.push(w);
      bridges.set(b.id, b);
      await options.prepareClient(w, b);
      return { selectedSession: id };
    },
    async stop(id) {
      stops.push(id);
      workers.find((w) => w.session.id === id).session.running = false;
    },
  };
  const debug = {
    snapshot: () => ({ sessions: [...bridges.values()] }),
    session: (id, g, ready) => {
      const b = bridges.get(id);
      assert.equal(b.connectionGeneration, g);
      if (ready) assert.equal(b.state, "game_ready");
      return b;
    },
    async code(id, g, code) {
      if (code.includes("netherNetId"))
        return { netherNetId: id.endsWith("A") ? "101" : "202" };
      if (code.includes("s.NotifyToServer"))
        return { playerId: "player-" + id.slice(-1) };
      if (code.includes("o.seen[:]")) {
        proofReads.push(id);
        return { players: ["player-" + id.slice(-1)] };
      }
      return true;
    },
  };
  const transport = {
    async create(config) {
      return { key: config.world_name.slice(-1) };
    },
    async prepare(c, w, b) {
      Object.assign(c, {
        pid: b.minecraftPid,
        registration: b.id,
        generation: b.connectionGeneration,
      });
    },
    async open() {
      await new Promise((r) => setTimeout(r, 2));
    },
    async inspect() {},
    async discover(c, target) {
      assert.equal(target.name, "World " + c.key);
      assert.equal(target.owner, "Host" + c.key);
      assert.equal(target.netherNetId, c.key === "A" ? "101" : "202");
      return { id: c.key };
    },
    async dispatch(c, row) {
      dispatched.push(row.id);
      bridges.get(c.registration).state = "game_ready";
    },
    async status() {},
    async close() {},
  };
  const joiner = new ClientJoiner(sessions, debug, "unused", {
    transport,
    roomName: async (t) => ({
      name: t.worker.session.worldName,
      source: "fixture",
    }),
    wait: () => new Promise((r) => setTimeout(r, 1)),
    timeoutMs: 500,
  });
  t.after(() => joiner.shutdown());
  for (const key of ["A", "B"]) {
    const id = await joiner.launch("host-" + key, "Guest" + key);
    await joiner.jobs.get(id).promise;
    const w = workers.find((w) => w.session.id === id);
    assert.equal(w.session.autoJoin.phase, "joined");
    assert.equal(w.session.autoJoin.hostSessionId, "host-" + key);
    assert.deepEqual(w.sourceSnapshot.config.included_mod_dirs, [
      "C:/mods/" + key,
    ]);
  }
  assert.deepEqual(dispatched, ["A", "B"]);
  assert.deepEqual(proofReads, ["bridge-A", "bridge-B"]);
  await sessions.stop("guest-A");
  assert(workers.find((w) => w.session.id === "guest-B").session.running);
  assert(workers.slice(0, 2).every((w) => w.session.running));
  assert.deepEqual(stops, ["guest-A"]);
});
test("missing host proof stops only the new client; reloaded host aborts further menu actions", async (t) => {
  const f = fixture(t, { noAck: true });
  const id = await f.joiner.launch("host", "Joined");
  await f.joiner.jobs.get(id).promise;
  assert.equal(f.child.session.autoJoin.phase, "failed");
  assert.deepEqual(f.stops, ["child"]);
  assert(f.host.session.running);
  const g = fixture(t, { hostReload: true });
  const other = await g.joiner.launch("host", "Joined");
  await g.joiner.jobs.get(other).promise;
  assert.equal(g.clicks.length, 0);
  assert.match(g.child.session.autoJoin.message, /重载|变化/);
  assert.deepEqual(g.stops, ["child"]);
});
test("join rejects non-host/duplicate names before creating games and cancellation releases the owned attempt", async (t) => {
  const bad = fixture(t, { invalidRoom: true });
  await assert.rejects(bad.joiner.launch("host", "Joined"), /LevelName/);
  assert.equal(bad.sessions.workers.length, 1);
  assert.equal(bad.stats().prepared, 0);
  const f = fixture(t);
  await assert.rejects(f.joiner.launch("missing", "X"), /主机/);
  await assert.rejects(f.joiner.launch("host", "Host"), /同名/);
  const id = await f.joiner.launch("host", "Joined");
  f.joiner.cancel(id);
  await f.joiner.jobs.get(id).promise;
  assert.equal(f.child.session.autoJoin.phase, "failed");
  assert.deepEqual(f.stops, ["child"]);
  assert.throws(() => proofCode("bad';escape", "prepare"), /令牌/);
});

test("native startup rejects unsupported builds and numeric IDs before creating clients", async (t) => {
  for (const mutate of [{ unsupported: true }, { numericId: true }]) {
    const f = fixture(t, mutate);
    await assert.rejects(f.joiner.launch("host", "Joined"));
    assert.equal(f.sessions.workers.length, 1);
    assert.equal(f.stats().prepared, 0);
  }
});
test("generation changes, unknown dispatch result and sealing failures stop only the new client", async (t) => {
  for (const mutate of [
    { generation: true },
    { dispatchTimeout: true },
    { sealFailure: true },
  ]) {
    const f = fixture(t, mutate);
    const id = await f.joiner.launch("host", "Joined");
    await f.joiner.jobs.get(id).promise;
    assert.equal(f.child.session.autoJoin.phase, "failed");
    assert.deepEqual(f.stops, ["child"]);
    assert(f.host.session.running);
    assert(f.clicks.length <= 1);
  }
});
test("shutdown waits for startup preparation and stops the new child", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fixture(t, { prepareGate: gate });
  const starting = f.joiner.launch("host", "Joined");
  starting.catch(() => {});
  while (f.sessions.workers.length < 2)
    await new Promise((r) => setTimeout(r, 1));
  const shutdown = f.joiner.shutdown();
  release();
  await assert.rejects(starting, /关闭/);
  await shutdown;
  assert.deepEqual(f.stops, ["child"]);
  assert(f.host.session.running);
});

function assertionDialog(f, onPoll) {
  let polls = 0;
  const inspection = new OreJoin("unused", {
    window: async () => {
      // The assertion is raised by resource loading after the one join call.
      if (f.clicks.length && onPoll(++polls))
        throw Object.assign(Error("GAME_ASSERT_DIALOG: TexCoord0"), {
          code: "GAME_ASSERT_DIALOG",
        });
    },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  f.transport.inspect = inspection.inspect.bind(inspection);
}

test("assertion pauses even at game_ready; dismiss resumes proof without replaying join or flooding logs", async (t) => {
  const f = fixture(t);
  assertionDialog(f, (poll) => {
    if (poll <= 3) {
      assert.equal(f.stats().ackReads, 0);
      assert.deepEqual(f.stops, []);
      if (poll > 1)
        assert.equal(f.child.session.autoJoin.phase, "waiting_assertion");
      return true;
    }
    return false;
  });
  const id = await f.joiner.launch("host", "Joined");
  await f.joiner.jobs.get(id).promise;
  assert.equal(f.child.session.autoJoin.phase, "joined");
  assert.equal(f.child.session.autoJoin.assertion, null);
  assert.equal(f.clicks.length, 1);
  assert.equal(
    f.logs.filter(([, text]) => text.includes("已暂停自动加入")).length,
    1,
  );
  assert.deepEqual(f.stops, []);
});

test("unhandled assertion times out into needs_attention, seals and preserves client without claiming joined", async (t) => {
  const f = fixture(t);
  assertionDialog(f, () => true);
  const id = await f.joiner.launch("host", "Joined");
  const job = f.joiner.jobs.get(id);
  await job.promise;
  assert.equal(f.child.session.autoJoin.phase, "needs_attention");
  assert.match(f.child.session.autoJoin.assertion, /TexCoord0/);
  assert.equal(f.child.session.autoJoin.playerId, undefined);
  assert.equal(f.stats().ackReads, 0);
  assert(f.child.session.running);
  assert(job.context.closed);
  assert.equal(f.clicks.length, 1);
  assert.deepEqual(f.stops, []);
});

test("cancellation, host reload, generation change and seal failure retain cleanup protections during assertion", async (t) => {
  for (const action of [
    "cancel",
    "hostReload",
    "generation",
    "sealFailure",
    "ownership",
  ]) {
    const f = fixture(t, { sealFailure: action === "sealFailure" });
    assertionDialog(f, (poll) => {
      if (poll === 2) {
        if (action === "cancel") f.joiner.cancel("child");
        if (action === "hostReload") f.hb.stateSequence++;
        if (action === "generation") f.cb.connectionGeneration++;
        if (action === "ownership") throw Error("GAME_OWNERSHIP_CHANGED");
      }
      return true;
    });
    const id = await f.joiner.launch("host", "Joined");
    await f.joiner.jobs.get(id).promise;
    assert.equal(f.child.session.autoJoin.phase, "failed", action);
    assert.deepEqual(f.stops, ["child"], action);
    assert(f.host.session.running);
    assert.equal(f.clicks.length, 1);
  }
});

test("shutdown during assertion waiting promptly cancels the owned client", async (t) => {
  const f = fixture(t);
  assertionDialog(f, () => true);
  await f.joiner.launch("host", "Joined");
  while (f.child.session.autoJoin.phase !== "waiting_assertion")
    await new Promise((r) => setTimeout(r, 1));
  await f.joiner.shutdown();
  assert.deepEqual(f.stops, ["child"]);
  assert.equal(f.child.session.autoJoin.phase, "failed");
});
