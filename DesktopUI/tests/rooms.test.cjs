const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const p = require("../electron/network/protocol.cjs");
const { Rooms } = require("../electron/network/rooms.cjs");
const { fingerprint } = require("../electron/network/mod-fingerprint.cjs");
test("missing Packet.dll is rejected before attempting elevation or starting either EXE", async () => {
  const { EasyTier } = require("../electron/network/easytier.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-net-deps-"));
  try {
    await fs.mkdir(path.join(root, "network"));
    const names = [
      "easytier-core.exe",
      "easytier-cli.exe",
      "wintun.dll",
      "WinDivert64.sys",
      "Packet.dll",
      "network-helper.exe",
    ];
    const digest = crypto.createHash("sha256").update("fixture").digest("hex");
    const files = Object.fromEntries(names.map((n) => [n, digest]));
    for (const name of names.filter((n) => n !== "Packet.dll"))
      await fs.writeFile(path.join(root, "network", name), "fixture");
    await fs.writeFile(
      path.join(root, "network/manifest.json"),
      JSON.stringify({ version: "2.7.0-8b7f1f01", files }),
    );
    await assert.rejects(new EasyTier(root).verify(), /Packet.dll/);
    delete files["Packet.dll"];
    await fs.writeFile(
      path.join(root, "network/manifest.json"),
      JSON.stringify({ version: "2.7.0-8b7f1f01", files }),
    );
    await assert.rejects(new EasyTier(root).verify(), /清单不完整/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
function invitation() {
  return {
    version: 1,
    roomId: crypto.randomUUID(),
    inviteId: crypto.randomUUID(),
    network: "dgn-" + crypto.randomBytes(16).toString("hex"),
    hostIp: "10.230.240.1",
    guestIp: "10.230.240.2",
    controlPort: 30001,
    expires: Date.now() + 3600000,
    endpoint: "tcp://example.test:32000",
    authKey: p.randomKey(),
    credential: p.randomKey(),
    hostPublicKey: p.randomKey(),
  };
}
test("invitation validates version, expiry, address and endpoint without accepting extra fields", () => {
  const v = invitation(),
    text = p.encodeInvite({ ...v, localPath: "secret-local-path" });
  assert.deepEqual(p.parseInvite(text), v);
  const encode = (x) =>
    "DGNROOM1:" +
    Buffer.from(JSON.stringify({ ...v, ...x })).toString("base64url");
  for (const x of [
    { version: 2 },
    { expires: Date.now() - 1 },
    { expires: Date.now() + 172800000 },
    { hostIp: "10.999.1.1" },
    { guestIp: "10.230.241.2" },
    { guestIp: v.hostIp },
    { credential: "bad" },
    { controlPort: 80 },
    { endpoint: "http://example.test:3000" },
    { endpoint: "tcp://a:b@example.test:3000" },
    { endpoint: "tcp://example.test:3000/path" },
  ])
    assert.throws(() => p.parseInvite(encode(x)));
});
test("room messages authenticate direction and invite identity, and reject tampering", () => {
  const v = invitation(),
    msg = { id: crypto.randomUUID(), value: "中文房间" },
    box = p.seal(msg, v.authKey, p.aad(v, "request"));
  assert.deepEqual(p.open(box, v.authKey, p.aad(v, "request")), msg);
  assert.throws(() => p.open(box, v.authKey, p.aad(v, "response")));
  assert.throws(() => p.open(box, p.randomKey(), p.aad(v, "request")));
  const b = Buffer.from(box, "base64");
  b[14] ^= 1;
  assert.throws(() =>
    p.open(b.toString("base64"), v.authKey, p.aad(v, "request")),
  );
});
test("subnet conflict detection accounts for wide local prefixes", () => {
  const a = {
    nic: [
      {
        family: "IPv4",
        address: "10.4.2.3",
        netmask: "255.255.0.0",
        internal: false,
      },
    ],
  };
  assert.equal(p.subnetConflict("10.4.99.1", a), true);
  assert.equal(p.subnetConflict("10.5.99.1", a), false);
});
test("mod fingerprints include resource bytes and ignore disabled entries and bytecode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mod-hash-"));
  try {
    const dir = path.join(root, "pack");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        header: { uuid: "abc", version: [1, 0, 0] },
        modules: [{ type: "resources" }],
      }),
    );
    await fs.writeFile(path.join(dir, "image.png"), Buffer.from([0, 1, 2]));
    const cfg = {
      included_mod_dirs: [root, { path: "missing", enabled: false }],
    };
    const a = await fingerprint(cfg);
    await fs.writeFile(path.join(dir, "ignored.pyc"), "ignored");
    assert.deepEqual(await fingerprint(cfg), a);
    await fs.writeFile(path.join(dir, "image.png"), Buffer.from([0, 1, 3]));
    assert.notEqual((await fingerprint(cfg))[0].hash, a[0].hash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
function service() {
  const r = new Rooms(
    {
      sessions: {},
      debug: {},
      profiles: {},
      worlds: {},
      runtime: "unused",
      dataRoot: "unused",
    },
    { makeNetwork: () => ({ stop: async () => {}, revoke: async () => {} }) },
  );
  r.hostCheck = () => true;
  return r;
}
test("snapshot never exposes invite secrets, master keys or proof tokens", () => {
  const s = service(),
    r = s.reserve("host"),
    i = { ...invitation(), proof: "private-proof", seen: new Map() };
  r.invites.set(i.inviteId, i);
  r.privateKey = "private-key";
  const data = JSON.stringify(s.snapshot());
  for (const value of [i.authKey, i.credential, i.proof, r.privateKey])
    assert.ok(!data.includes(value));
});
test("revocation rejects application access before network request completes", async () => {
  const s = service(),
    r = s.reserve("host"),
    i = invitation();
  r.invites.set(i.inviteId, i);
  let called = false;
  r.network.revoke = async (id) => {
    called = true;
    assert.equal(id, i.inviteId);
    assert.equal(i.phase, "revoking");
  };
  await s.revoke(i.inviteId);
  assert.equal(called, true);
  assert.equal(i.phase, "revoked");
});
test("host command rejects version mismatches and unknown remote operations", async () => {
  const s = service(),
    r = s.reserve("host"),
    i = invitation();
  r.engine = { digest: "engine" };
  r.mods = [];
  r.game = { owner: "Host" };
  await assert.rejects(
    s.command(r, i, "prepare", {
      playerName: "Guest",
      engine: "other",
      mods: [],
    }),
    /版本不一致/,
  );
  await assert.rejects(s.command(r, i, "execute", { code: "bad" }), /不支持/);
});
test("proof requires engine-sourced player match; does not accept game-ready alone", async () => {
  const s = service(),
    r = s.reserve("host"),
    i = { ...invitation(), proof: "a".repeat(32) };
  s.hostCode = async () => ({ players: ["123"] });
  assert.deepEqual(await s.command(r, i, "proof", { playerId: "124" }), {
    verified: false,
  });
  assert.notEqual(i.phase, "joined");
  assert.deepEqual(await s.command(r, i, "proof", { playerId: "123" }), {
    verified: true,
  });
  assert.equal(i.phase, "joined");
});

test("host admits a guest without its packs, preserving player-name and one-shot checks", async () => {
  const s = service(),
    r = s.reserve("host"),
    i = invitation();
  r.engine = { digest: "engine" };
  r.mods = [{ uuid: "host-only" }];
  r.game = { owner: "Host" };
  r.invites.set(i.inviteId, i);
  s.hostCode = async () => true;
  const result = await s.command(r, i, "prepare", {
    playerName: "Guest",
    engine: "engine",
    mods: [],
  });
  assert.match(result.token, /^[a-f0-9]{32}$/);
  await assert.rejects(
    s.command(r, i, "prepare", { playerName: "Guest", engine: "engine" }),
    /已发起/,
  );
  await assert.rejects(
    s.command(r, invitation(), "prepare", {
      playerName: "Guest",
      engine: "engine",
    }),
    /同名/,
  );
});
test("close waits for pending startup and cleans network once", async () => {
  const s = service(),
    r = s.reserve("host");
  let release,
    stops = 0;
  r.network.stop = async () => stops++;
  s.run(r, async () => {
    await new Promise((resolve) => (release = resolve));
    s.check(r);
  });
  const pending = s.close();
  assert.equal(s.snapshot().phase, "preparing");
  release();
  await pending;
  assert.equal(stops, 1);
  assert.equal(s.snapshot().phase, "idle");
});
test("failed invitation allocation stays reserved to prevent IP reuse races", async () => {
  const s = service(),
    r = s.reserve("host");
  r.phase = "hosting";
  r.networkName = "dgn-" + "a".repeat(32);
  r.ip = "10.20.30.1";
  r.endpoint = "tcp://example.test:3000";
  r.controlPort = 30001;
  r.hostPublicKey = p.randomKey();
  r.network.invite = async () => {
    throw Error("unavailable");
  };
  await assert.rejects(s.invite(), /unavailable/);
  assert.equal(r.invites.size, 1);
  assert.equal([...r.invites.values()][0].phase, "failed");
});
test("real HTTP coordinator authenticates messages, rejects replay and revoked invites", async () => {
  const { freePort } = require("../electron/network/easytier.cjs");
  const s = service(),
    r = s.reserve("host");
  r.ip = "127.0.0.1";
  r.controlPort = await freePort();
  r.engine = { digest: "abc" };
  r.mods = [];
  r.game = { name: "地图", owner: "Host", netherNetId: "18446744073709551615" };
  const i = {
    ...invitation(),
    roomId: r.id,
    hostIp: r.ip,
    controlPort: r.controlPort,
    phase: "invited",
    seen: new Map(),
  };
  r.invites.set(i.inviteId, i);
  await s.listen(r);
  try {
    const hello = await p.request(i, "hello");
    assert.equal(hello.game.netherNetId, "18446744073709551615");
    assert.deepEqual(await p.request(i, "health"), { roomId: r.id });
    await assert.rejects(p.request(i, "scripts.list"), /已验证入房/);
    i.phase = "joined";
    i.playerId = "-123";
    i.scriptSyncSupported = true;
    r.scriptSync = {
      list: async () => ({ revision: "a".repeat(64), entries: [] }),
      close: () => {},
    };
    assert.equal((await p.request(i, "scripts.list")).revision, "a".repeat(64));
    await assert.rejects(
      p.request(i, "scripts.ack", {
        phase: "synced",
        message: "invalid",
        files: -1,
        updated: 1,
      }),
      /数量无效/,
    );
    await p.request(i, "scripts.ack", {
      phase: "synced",
      revision: "a".repeat(64),
      message: "已更新",
      files: 1,
      updated: 1,
    });
    assert.equal(s.snapshot().members[0].scriptSync.updated, 1);
    const message = {
      requestId: crypto.randomUUID(),
      time: Date.now(),
      action: "health",
      data: {},
    };
    const encoded = JSON.stringify({
      inviteId: i.inviteId,
      box: p.seal(message, i.authKey, p.aad(i, "request")),
    });
    const send = () =>
      fetch(`http://127.0.0.1:${r.controlPort}/room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: encoded,
      });
    const a = p.open(
      (await (await send()).json()).box,
      i.authKey,
      p.aad(i, "response"),
    );
    assert.equal(a.ok, true);
    const b = p.open(
      (await (await send()).json()).box,
      i.authKey,
      p.aad(i, "response"),
    );
    assert.equal(b.ok, false);
    assert.match(b.error, /重复/);
    i.phase = "revoked";
    await assert.rejects(p.request(i, "health"), /拒绝/);
  } finally {
    await s.close();
  }
});
for (const localJoin of [false, true])
  test(`guest lifecycle ${localJoin ? "local" : "remote"} requires discovery, dispatch and player proof`, async () => {
    const worker = {
        session: {
          id: "owned-guest",
          running: true,
          bridgeRegistrationId: "reg",
          pid: 123,
        },
      },
      b = {
        id: "bridge",
        connected: true,
        registrationId: "reg",
        mcdkPid: 123,
        minecraftPid: 456,
        connectionGeneration: 1,
        stateSequence: 1,
        state: "menu_ready",
        gameIpcConnected: true,
        debugCapabilityEnabled: true,
      };
    let stopped = 0,
      dispatched = 0,
      proofs = 0,
      networkStops = 0,
      networkStarts = 0;
    const sessions = {
      store: { value: { settings: { GamePath: path.resolve("fixture.exe") } } },
      workers: [worker],
      start: async (_p, _w, _b, opt) => {
        assert.equal(_p, null);
        assert.equal(_w, null);
        assert.deepEqual(_b, { userName: "Friend" });
        assert.equal(opt.roomGuest, true);
        assert.equal(
          opt.runtimeConfig.game_executable_path,
          path.resolve("fixture.exe"),
        );
        assert.deepEqual(opt.runtimeConfig.included_mod_dirs, []);
        assert.equal(opt.runtimeConfig.auto_hot_reload_mods, false);
        await opt.prepareClient(worker, b);
        return { selectedSession: worker.session.id };
      },
      stop: async () => {
        stopped++;
        worker.session.running = false;
      },
    };
    const debug = {
      snapshot: () => ({ sessions: [b] }),
      session: () => b,
      code: async () => ({ playerId: "4567" }),
    };
    const transport = {
      create: async () => ({}),
      prepare: async (c) =>
        Object.assign(c, { pid: 456, registration: "bridge", generation: 1 }),
      open: async () => {},
      inspect: async () => {},
      discover: async () => ({ id: "room" }),
      dispatch: async () => {
        dispatched++;
        b.state = "game_ready";
      },
      status: async () => {},
      close: async () => {},
    };
    const request = async (_i, action) => {
      if (action === "hello")
        return {
          roomId: _i.roomId,
          game: { name: "test" },
          engine: "engine",
          packTransfer: "native-v1",
          mods: [{ uuid: "host-only-pack", hash: "not-on-guest" }],
        };
      if (action === "prepare")
        return { token: "a".repeat(32), game: { name: "test" } };
      if (action === "proof") {
        proofs++;
        return { verified: true };
      }
      return true;
    };
    const s = new Rooms(
      {
        sessions,
        debug,
        profiles: {},
        worlds: {},
        runtime: "unused",
        dataRoot: "unused",
      },
      {
        transport,
        request,
        localHostAddress: () => localJoin,
        wait: async () => {},
        checkEngine: async () => ({ digest: "engine" }),
        fingerprint: async () => {
          throw Error("must not scan guest mods");
        },
        makeNetwork: () => ({
          start: async () => {
            networkStarts++;
          },
          status: async () => ({ peers: [] }),
          stop: async () => networkStops++,
        }),
      },
    );
    s.profile = async () => {
      throw Error("join must not read any profile");
    };
    const v = invitation();
    s.join({
      invitation: p.encodeInvite(v),
      playerName: "Friend",
    });
    await s.job;
    assert.equal(s.snapshot().phase, "joined");
    assert.equal(dispatched, 1);
    assert.equal(proofs, 1);
    assert.equal(stopped, 0);
    assert.equal(networkStarts, localJoin ? 0 : 1);
    if (localJoin)
      assert.equal(s.snapshot().network.transport, "本机共享房主网络");
    await s.close();
    assert.equal(stopped, 1);
    assert.equal(networkStops, 1);
  });
test("local host matching requires the exact local interface address, not a matching subnet", () => {
  const interfaces = {
    test: [
      {
        family: "IPv4",
        address: "10.30.40.1",
        netmask: "255.255.255.0",
        internal: false,
      },
    ],
  };
  assert.equal(p.localHostAddress("10.30.40.1", interfaces), true);
  assert.equal(p.localHostAddress("10.30.40.2", interfaces), false);
  assert.equal(p.subnetConflict("10.30.40.2", interfaces), true);
});
test("a stopped game fails readiness immediately instead of waiting the full deadline", async () => {
  const s = service(),
    r = s.reserve("host");
  await assert.rejects(
    s.ready(r, { session: { running: false } }),
    /游戏启动进程已结束/,
  );
});
test("local interface matching does not bypass invitation room authentication", async () => {
  let launches = 0;
  const s = new Rooms(
    {
      sessions: {
        store: {
          value: { settings: { GamePath: path.resolve("fixture.exe") } },
        },
        start: async () => {
          launches++;
        },
      },
      debug: {},
      profiles: {},
      worlds: {},
      runtime: "unused",
      dataRoot: "unused",
    },
    {
      localHostAddress: () => true,
      checkEngine: async () => ({ digest: "engine" }),
      fingerprint: async () => [],
      request: async () => ({
        roomId: crypto.randomUUID(),
        engine: "engine",
        mods: [],
        game: { name: "wrong" },
      }),
      makeNetwork: () => ({
        start: async () => {
          throw Error("must not create a local TUN");
        },
        stop: async () => {},
      }),
    },
  );
  s.profile = async () => ({ game_executable_path: "fixture" });
  s.join({
    invitation: p.encodeInvite(invitation()),
    playerName: "Guest",
    profileId: "profile",
  });
  await s.job;
  assert.equal(s.snapshot().phase, "failed");
  assert.match(s.snapshot().error, /房间身份/);
  assert.equal(launches, 0);
});

for (const legacy of [false, true])
  test(`guest rejects ${legacy ? "legacy pack policy" : "different engine"} before launching`, async () => {
    let launches = 0;
    const s = new Rooms(
      {
        sessions: {
          store: {
            value: { settings: { GamePath: path.resolve("fixture.exe") } },
          },
          start: async () => {
            launches++;
          },
        },
        debug: {},
        profiles: {},
        worlds: {},
        runtime: "unused",
        dataRoot: "unused",
      },
      {
        localHostAddress: () => true,
        checkEngine: async () => ({ digest: "engine" }),
        request: async (i) => ({
          roomId: i.roomId,
          game: { name: "room" },
          engine: legacy ? "engine" : "other",
          packTransfer: legacy ? undefined : "native-v1",
        }),
        makeNetwork: () => ({ stop: async () => {} }),
      },
    );
    const profile = {
      game_executable_path: "fixture",
      included_mod_dirs: ["untouched"],
    };
    s.profile = async () => profile;
    s.join({
      invitation: p.encodeInvite(invitation()),
      profileId: "p",
      playerName: "Guest",
    });
    await s.job;
    assert.equal(s.snapshot().phase, "failed");
    assert.match(s.snapshot().error, legacy ? /房主工具箱/ : /游戏版本不一致/);
    assert.equal(launches, 0);
    assert.deepEqual(profile.included_mod_dirs, ["untouched"]);
  });
test("network display understands pinned 2.7.0 CLI rows and excludes local node", () => {
  const s = service(),
    r = s.reserve("host");
  s.networkSummary(r, {
    peers: [
      { cost: "Local", lat_ms: "-" },
      { cost: "P2P", lat_ms: "12.5" },
    ],
  });
  assert.equal(s.snapshot().network.peers, 1);
  assert.equal(s.snapshot().network.latencyMs, 12.5);
});

for (const [gamePath, engineError, expected] of [
  ["", null, /全局游戏程序/],
  ["relative.exe", null, /路径无效/],
  [path.resolve("missing.exe"), "ENOENT", /不存在或无法读取/],
])
  test(`guest preflight rejects invalid global game before networking: ${gamePath || "unset"}`, async () => {
    let networkStarts = 0,
      launches = 0;
    const s = new Rooms(
      {
        sessions: {
          store: { value: { settings: { GamePath: gamePath } } },
          start: async () => {
            launches++;
          },
        },
        debug: {},
        profiles: {
          read: async () => {
            throw Error("must not read profiles");
          },
        },
        worlds: {},
        runtime: "unused",
        dataRoot: "unused",
      },
      {
        localHostAddress: () => false,
        checkEngine: async () => {
          throw Object.assign(Error("fixture failure"), { code: engineError });
        },
        makeNetwork: () => ({
          start: async () => {
            networkStarts++;
          },
          stop: async () => {},
        }),
      },
    );
    s.join({ invitation: p.encodeInvite(invitation()), playerName: "Guest" });
    await s.job;
    assert.equal(s.snapshot().phase, "failed");
    assert.match(s.snapshot().error, expected);
    assert.equal(networkStarts, 0);
    assert.equal(launches, 0);
  });
test("cleanup failure is visible and cannot be silently dismissed as idle", async () => {
  const s = service(),
    r = s.reserve("host");
  r.network.stop = async () => {
    throw Error("rule cleanup failed");
  };
  await assert.rejects(s.close(), /rule cleanup failed/);
  assert.equal(s.snapshot().phase, "needs_attention");
  assert.match(s.snapshot().error, /rule cleanup failed/);
});

test("failed cleanup retries only unfinished steps after the game has exited", async () => {
  const s = service(),
    r = s.reserve("guest");
  let stops = 0,
    networkStops = 0,
    closes = 0;
  r.worker = { session: { id: "own", running: true } };
  r.context = {};
  s.transport = {
    close: async () => {
      closes++;
    },
  };
  s.sessions.stop = async () => {
    stops++;
    throw Error("taskkill failed");
  };
  r.network.stop = async () => {
    networkStops++;
  };
  await assert.rejects(s.close(), /taskkill failed/);
  assert.equal(s.snapshot().phase, "needs_attention");
  assert.match(s.snapshot().message, /再次点击离开重试/);
  r.worker.session.running = false;
  await Promise.all([s.close(), s.close()]);
  assert.equal(s.snapshot().phase, "idle");
  assert.deepEqual([stops, networkStops, closes], [1, 1, 1]);
  assert.doesNotThrow(() => s.reserve("host"));
  await s.close();
});

test("explicit leave stops an assertion-preserved guest and clears an obsolete native seal failure", async () => {
  const s = service(),
    r = s.reserve("guest");
  r.worker = { session: { id: "own", running: true } };
  r.preserveClient = true;
  r.context = {};
  s.transport = { close: async () => {} };
  let stops = 0;
  s.sessions.stop = async () => {
    stops++;
    r.worker.session.running = false;
  };
  await s.cleanup(r);
  assert.equal(stops, 0);
  await s.close();
  assert.equal(stops, 1);
  assert.equal(s.snapshot().phase, "idle");

  const r2 = s.reserve("guest");
  r2.worker = { session: { id: "own2", running: true } };
  r2.context = {};
  s.transport.close = async () => {
    if (r2.worker.session.running) throw Error("not game_ready");
  };
  s.sessions.stop = async () => {
    r2.worker.session.running = false;
  };
  await s.close();
  assert.equal(s.snapshot().phase, "idle");
});

test("a persistent cleanup failure remains actionable and a later successful retry clears it", async () => {
  const s = service(),
    r = s.reserve("host");
  let count = 0;
  r.network.stop = async () => {
    if (++count < 3) throw Error("rule denied");
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(s.close(), /rule denied/);
    assert.equal(s.snapshot().phase, "needs_attention");
    assert.equal(s.snapshot().error.match(/rule denied/g).length, 1);
  }
  await s.close();
  assert.equal(count, 3);
  assert.equal(s.snapshot().phase, "idle");
});

test("EasyTier retains the helper on a failed stop and requires a cleanup receipt", async () => {
  const { EasyTier } = require("../electron/network/easytier.cjs");
  const n = new EasyTier("unused");
  let ended = 0,
    attempts = 0;
  n.socket = {
    destroyed: false,
    end() {
      ended++;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  n.helperConnected = true;
  n.call = async () => {
    if (++attempts === 1) throw Error("rule denied");
    return true;
  };
  await assert.rejects(n.stop(), /rule denied/);
  assert.equal(n.socket.destroyed, false);
  await n.stop();
  await n.stop();
  assert.deepEqual([attempts, ended], [2, 1]);
  const disconnected = new EasyTier("unused");
  disconnected.helperConnected = true;
  await assert.rejects(disconnected.stop(), /未收到清理完成回执/);
});
test("failed credential revocation is not displayed as successful", async () => {
  const s = service(),
    r = s.reserve("host"),
    i = invitation();
  r.invites.set(i.inviteId, i);
  r.network.revoke = async () => {
    throw Error("offline");
  };
  await assert.rejects(s.revoke(i.inviteId), /offline/);
  assert.equal(s.snapshot().members[0].phase, "revoke_failed");
});
test("cancelled component preparation stops before filesystem or network work", async () => {
  const { prepareComponents } = require("../electron/network/components.cjs");
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareComponents("missing", "missing", abort.signal), {
    name: "AbortError",
  });
});
