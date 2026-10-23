const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { Rooms } = require("../electron/network/rooms.cjs"),
  p = require("../electron/network/protocol.cjs");
const version = "room-resume-v1";
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const bridge = (id, pid, seq = 1) => ({
  id,
  minecraftPid: pid,
  mcdkPid: pid + 1,
  registrationId: id,
  connectionGeneration: 1,
  stateSequence: seq,
  connected: true,
  state: "game_ready",
  gameIpcConnected: true,
  debugCapabilityEnabled: true,
});
function setup() {
  let summaries = [];
  const calls = { stops: 0, starts: 0 };
  const s = new Rooms(
    {
      sessions: {
        workers: [],
        start: async () => {
          calls.starts++;
        },
        stop: async () => {
          calls.stops++;
        },
      },
      debug: {
        snapshot: () => ({ sessions: summaries }),
        session: (id) => summaries.find((b) => b.id === id),
      },
      worlds: {},
      profiles: {},
      runtime: "unused",
      dataRoot: "unused",
    },
    {
      makeNetwork: () => ({
        stop: async () => {
          calls.stops++;
        },
      }),
      checkEngine: async () => ({ digest: "engine" }),
    },
  );
  return {
    s,
    calls,
    setBridges: (rows) => {
      summaries = rows;
    },
  };
}
const worker = (b, worldId = "w_" + "a".repeat(32)) => ({
  session: {
    id: b.id,
    worldId,
    running: true,
    pid: b.mcdkPid,
    bridgeRegistrationId: b.id,
    userName: "Host",
    runDirectory: "C:/test/run",
  },
  sourceSnapshot: {
    config: { game_executable_path: "C:/test/Game.exe", included_mod_dirs: [] },
  },
  log() {},
});
test("host game absence retains network/invite and only a verified replacement world advances the epoch", async () => {
  const { s, calls, setBridges } = setup(),
    r = s.reserve("host"),
    b = bridge("old", 10),
    w = worker(b);
  Object.assign(r, {
    phase: "hosting",
    reconnectEnabled: true,
    epoch: crypto.randomUUID(),
    worldId: w.session.worldId,
    worker: w,
    bridge: b,
    engine: { digest: "engine" },
  });
  s.sessions.workers = [w];
  setBridges([b]);
  const secret = p.randomKey(),
    auth = p.randomKey(),
    i = {
      phase: "joined",
      proof: "x",
      resumeKey: secret,
      authKey: auth,
      playerId: "1",
    };
  r.invites.set("i", i);
  await s.recoverHost(r);
  const epoch = r.epoch;
  w.session.running = false;
  await s.recoverHost(r);
  assert.equal(r.phase, "waiting_host");
  assert.equal(calls.stops, 0);
  assert.equal(i.resumeKey, secret);
  const next = bridge("new", 20),
    nw = worker(next);
  s.sessions.workers.push(nw);
  setBridges([next]);
  s.verifyWorld = async () => {
    throw Error("wrong actual path");
  };
  await s.recoverHost(r);
  assert.equal(r.epoch, epoch);
  assert.match(r.message, /wrong actual path/);
  s.verifyWorld = async () => ({
    name: "same map",
    owner: "Host",
    netherNetId: "123",
  });
  await s.recoverHost(r);
  assert.equal(r.phase, "hosting");
  assert.notEqual(r.epoch, epoch);
  assert.equal(i.proof, undefined);
  assert.equal(i.authKey, auth);
  assert.equal(i.resumeKey, secret);
  assert.equal(calls.stops, 0);
  r.scriptSync.close();
});
test("same invitation resumes only with its bound secret; stale epochs cannot prove entry or sync scripts", async () => {
  const { s } = setup(),
    r = s.reserve("host");
  Object.assign(r, {
    phase: "hosting",
    reconnectEnabled: true,
    epoch: crypto.randomUUID(),
    game: { owner: "Host" },
    engine: { digest: "engine" },
  });
  let preparations = 0;
  s.hostCode = async (_r, code) => {
    if (code.includes("class DgnJoinProof")) preparations++;
    return { players: ["7"] };
  };
  const i = { phase: "invited" };
  r.invites.set("i", i);
  const data = {
    playerName: "Guest",
    engine: "engine",
    reconnect: version,
    resumeKey: p.randomKey(),
    epoch: r.epoch,
    attemptId: crypto.randomUUID(),
  };
  await assert.rejects(
    s.command(r, i, "prepare", { ...data, engine: "wrong" }),
    /版本不一致/,
  );
  assert.equal(i.resumeKey, undefined);
  const first = await s.command(r, i, "prepare", data);
  assert.deepEqual(await s.command(r, i, "prepare", data), first);
  assert.equal(preparations, 1);
  await assert.rejects(
    s.command(r, i, "prepare", {
      ...data,
      resumeKey: p.randomKey(),
      attemptId: crypto.randomUUID(),
    }),
    /其他客户端/,
  );
  const old = r.epoch;
  r.epoch = crypto.randomUUID();
  delete i.proof;
  await assert.rejects(
    s.command(r, i, "proof", {
      epoch: old,
      attemptId: data.attemptId,
      playerId: "7",
    }),
    /旧代次/,
  );
  await assert.rejects(s.command(r, i, "scripts.list", { epoch: old }), /代次/);
  const next = { ...data, epoch: r.epoch, attemptId: crypto.randomUUID() };
  const resumed = await s.command(r, i, "prepare", next);
  assert.notEqual(resumed.token, first.token);
  assert.deepEqual(
    await s.command(r, i, "proof", {
      epoch: r.epoch,
      attemptId: next.attemptId,
      playerId: "7",
    }),
    { verified: true },
  );
  assert.equal(i.phase, "joined");
});
test("waiting guests preserve their process and a new epoch uses a fresh proof on that same worker", async () => {
  const { s, calls, setBridges } = setup(),
    r = s.reserve("guest"),
    b = bridge("guest", 30),
    w = worker(b, null);
  setBridges([b]);
  let resumes = 0;
  const old = crypto.randomUUID(),
    newEpoch = crypto.randomUUID();
  Object.assign(r, {
    phase: "joined",
    worker: w,
    clientBridge: { ...b },
    epoch: old,
    playerName: "Guest",
    resumeKey: p.randomKey(),
    clientPort: 40000,
    engine: { digest: "engine" },
    invite: { roomId: "room", expires: Date.now() + 60000 },
  });
  s.request = async (_invite, action, data) => {
    if (action === "health")
      return {
        roomId: "room",
        reconnect: version,
        epoch: newEpoch,
        hostReady: false,
      };
    throw Error(action);
  };
  await s.recoverGuest(r);
  assert.equal(r.phase, "waiting_host");
  assert.equal(calls.stops, 0);
  b.state = "game_unavailable";
  b.gameIpcConnected = false;
  b.stateSequence = 2;
  s.request = async (_invite, action, data) =>
    action === "health"
      ? { roomId: "room", reconnect: version, epoch: newEpoch, hostReady: true }
      : { token: "a".repeat(32), epoch: newEpoch, game: { name: "map" } };
  s.transport = {
    resume: async (config, proof, existing, menu, port) => {
      resumes++;
      assert.equal(existing, w);
      assert.equal(port, 40000);
      return { pid: 30 };
    },
    close: async () => {},
  };
  s.enter = async () => {
    b.state = "game_ready";
    b.gameIpcConnected = true;
    b.stateSequence = 3;
  };
  await s.recoverGuest(r);
  assert.equal(r.phase, "joined");
  assert.equal(r.worker, w);
  assert.equal(r.clientBridge.minecraftPid, 30);
  assert.equal(r.epoch, newEpoch);
  assert.equal(resumes, 1);
  assert.equal(calls.starts, 0);
  assert.equal(calls.stops, 0);
  await s.recoverGuest(r);
  assert.equal(resumes, 1);
});
test("uncertain native reconnect is paused without closing the client, and explicit retry is available", async () => {
  const { s, calls, setBridges } = setup(),
    r = s.reserve("guest"),
    b = bridge("guest", 40),
    w = worker(b, null);
  b.state = "game_unavailable";
  b.gameIpcConnected = false;
  setBridges([b]);
  const epoch = crypto.randomUUID();
  Object.assign(r, {
    phase: "waiting_host",
    worker: w,
    epoch,
    playerName: "Guest",
    resumeKey: p.randomKey(),
    clientPort: 40000,
    engine: { digest: "engine" },
    invite: { roomId: "room", expires: Date.now() + 60000 },
  });
  s.request = async (_i, action) =>
    action === "health"
      ? { roomId: "room", reconnect: version, epoch, hostReady: true }
      : { token: "a".repeat(32), epoch, game: { name: "map" } };
  s.transport = {
    resume: async () => {
      throw Error("uncertain native response");
    },
  };
  await s.recoverGuest(r);
  assert.equal(r.phase, "reconnect_blocked");
  assert.equal(r.canRetry, true);
  assert.equal(calls.stops, 0);
  s.retry();
  assert.equal(r.phase, "waiting_host");
});

test("actual engine world path must resolve to the bound save, including owned directory aliases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-reconnect-world-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-reconnect-world-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const first = path.join(root, "first"),
    other = path.join(root, "other"),
    alias = path.join(root, "alias");
  await fs.mkdir(first);
  await fs.mkdir(other);
  await fs.symlink(first, alias, "junction");
  const { s, setBridges } = setup(),
    r = s.reserve("host"),
    b = bridge("owned", 50),
    w = worker(b);
  r.worldPath = first;
  setBridges([b]);
  s.debug.code = async () => ({
    path: other,
    name: "same title",
    netherNetId: "123",
  });
  await assert.rejects(s.verifyWorld(r, w, b), /不是该房间绑定的存档/);
  s.debug.code = async () => ({
    path: alias,
    name: "same title",
    netherNetId: "123",
  });
  assert.equal((await s.verifyWorld(r, w, b)).netherNetId, "123");
});
