const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  net = require("node:net");
const fixed = require("../electron/network/fixed-room.cjs"),
  p = require("../electron/network/protocol.cjs"),
  { Rooms } = require("../electron/network/rooms.cjs");
test("recreating a fixed room keeps its invitation unless the saved port becomes unavailable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-fixed-create-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const str = (s) => {
    const bytes = Buffer.from(s),
      len = Buffer.alloc(2);
    len.writeUInt16LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const body = Buffer.concat([
    Buffer.from([10, 0, 0, 8]),
    str("LevelName"),
    str("FixedWorld"),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10);
  header.writeUInt32LE(body.length, 4);
  await fs.writeFile(
    path.join(root, "level.dat"),
    Buffer.concat([header, body]),
  );
  const world = { id: "test", name: "World", path: root },
    config = {
      game_executable_path: path.join(root, "Game.exe"),
      included_mod_dirs: [],
    };
  const worker = {
    session: {
      running: true,
      worldId: "test",
      userName: "Host",
      runDirectory: root,
    },
    sourceSnapshot: { config },
  };
  const starts = [];
  function service() {
    const s = new Rooms(
      {
        dataRoot: root,
        runtime: "unused",
        profiles: {},
        debug: {},
        sessions: { workers: [worker] },
        worlds: {
          list: async () => ({ worlds: [world] }),
          read: async () => ({}),
          find: () => world,
          inspect: async () => ({ ...world, present: true }),
        },
      },
      {
        makeNetwork: () => ({
          start: async (c) => {
            starts.push(c);
            return { peers: [] };
          },
          stop: async () => {},
        }),
        checkEngine: async () => ({ digest: "test" }),
      },
    );
    // Game/network boundaries are fixtures; persistence and room orchestration are real.
    s.ready = async () => ({});
    s.hostCheck = () => ({});
    s.hostCode = async () => ({ netherNetId: "123" });
    s.verifyWorld = async () => ({});
    s.listen = async (r) => {
      assert.equal(r.controlPort, starts.at(-1).controlPort);
      assert.equal(r.fixedIdentity.controlPort, r.controlPort);
    };
    s.monitor = () => {};
    return s;
  }
  let text, original;
  for (let pass = 0; pass < 4; pass++) {
    const s = service();
    t.after(() => s.close());
    let occupied;
    if (pass === 2) {
      occupied = net.createServer();
      t.after(() => new Promise((resolve) => occupied.close(resolve)));
      await new Promise((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(original.controlPort, "127.0.0.1", resolve);
      });
    }
    s.create({
      worldId: "test",
      endpoint: "example.test:30000",
      localPort: 11010,
      roomCode: "我和朋友的地图",
    });
    await s.job;
    assert.equal(s.snapshot().phase, "hosting", s.snapshot().error);
    const invitation = await s.invite();
    assert.equal(invitation.fixed, true);
    const parsed = p.parseInvite(invitation.text),
      saved = (await new fixed.RoomPreferences(root).read()).host;
    assert.equal(parsed.controlPort, starts[pass].controlPort);
    assert.equal(saved.controlPort, parsed.controlPort);
    if (pass === 2) {
      assert.notEqual(parsed.controlPort, original.controlPort);
      assert.notEqual(invitation.text, text);
      assert.deepEqual(saved, { ...original, controlPort: parsed.controlPort });
      assert.match(s.snapshot().message, /连接端口已更新.*重新复制完整邀请/);
      assert.equal(occupied.listening, true);
      text = invitation.text;
    } else if (pass) assert.equal(invitation.text, text);
    else {
      text = invitation.text;
      original = saved;
    }
    await s.close();
    assert.equal(worker.session.running, true);
    if (occupied)
      await new Promise((resolve) => occupied.close(resolve));
  }
  for (const next of starts.slice(1)) {
    assert.equal(starts[0].fixedCredential, next.fixedCredential);
    assert.equal(starts[0].privateKey, next.privateKey);
    assert.notEqual(starts[0].instance, next.instance);
  }
});
test("fixed invitation survives reopening the store, has no product expiry and rotates only on changed code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-fixed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new fixed.RoomPreferences(root);
  const original = await a.identity(
    "朋友地图",
    "tcp://example.test:30000",
    async () => 33001,
  );
  const text = fixed.encode(original),
    invite = p.parseInvite(text);
  assert.equal(invite.fixed, true);
  assert.equal(invite.expires, fixed.NEVER);
  assert.equal(
    p.parseInvite(text, Date.now() + 100 * 365 * 86400000).fixed,
    true,
  );
  assert.equal(
    JSON.parse(Buffer.from(text.slice(9), "base64url")).expires,
    undefined,
  );
  const b = new fixed.RoomPreferences(root);
  assert.deepEqual(
    await b.identity("朋友地图", "tcp://example.test:30000", (port) => {
      assert.equal(port, original.controlPort);
      return port;
    }),
    original,
  );
  assert.equal(
    fixed.encode(await b.identity("朋友地图", original.endpoint, (port) => port)),
    text,
  );
  const moved = await b.identity("朋友地图", "tcp://new.test:32000", (port) => port);
  assert.equal(moved.roomId, original.roomId);
  assert.notEqual(fixed.encode(moved), text);
  const changed = await b.identity(
    "新码",
    original.endpoint,
    async () => 33002,
  );
  assert.notEqual(changed.roomId, original.roomId);
  assert.notEqual(changed.credential, original.credential);
  assert(!text.includes(original.privateKey));
  assert(!text.includes(original.secret));
});
test("fixed port repair preserves identity and an allocation failure leaves persisted settings intact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-fixed-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new fixed.RoomPreferences(root),
    original = await a.identity("朋友地图", "tcp://example.test:30000", () => 33001);
  const repaired = await a.identity(original.code, original.endpoint, (port) => {
    assert.equal(port, original.controlPort);
    return 33002;
  });
  assert.deepEqual(repaired, { ...original, controlPort: 33002 });
  const reopened = new fixed.RoomPreferences(root);
  assert.deepEqual(
    await reopened.identity(original.code, original.endpoint, (port) => port),
    repaired,
  );
  const before = await fs.readFile(reopened.file);
  await assert.rejects(
    reopened.identity(original.code, "tcp://new.test:32000", () => {
      throw Object.assign(Error("fixture bind failure"), { code: "EADDRNOTAVAIL" });
    }),
    { code: "EADDRNOTAVAIL" },
  );
  assert.deepEqual(await fs.readFile(reopened.file), before);
});
test("draft autosaves merge serialized updates, clear persists and invalid input cannot replace secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-draft-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new fixed.RoomPreferences(root),
    client = await a.client();
  await Promise.all([
    a.saveDraft({ invitation: "DGNROOM2:test" }),
    a.saveDraft({ playerName: "Friend", roomCode: "1234" }),
  ]);
  const b = new fixed.RoomPreferences(root);
  assert.deepEqual(await b.draft(), {
    invitation: "DGNROOM2:test",
    playerName: "Friend",
    roomCode: "1234",
  });
  assert.deepEqual(await b.client(), client);
  assert.throws(() => b.saveDraft({ playerName: "x".repeat(33) }));
  await b.saveDraft({ invitation: "", playerName: "", host: { bad: true } });
  assert.equal((await a.draft()).invitation, "");
  assert.equal((await a.read()).host, undefined);
});
test("fixed coordinator accepts independent clients and rejects wrong credentials across room recreation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-fixed-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s = new Rooms(
    {
      sessions: {},
      debug: {},
      profiles: {},
      worlds: {},
      runtime: "unused",
      dataRoot: root,
    },
    { makeNetwork: () => ({}) },
  );
  const id = crypto.randomUUID(),
    credential = p.randomKey();
  async function start() {
    const r = s.reserve("host");
    Object.assign(r, {
      id,
      fixed: true,
      phase: "hosting",
      ip: "127.0.0.1",
      controlPort: 0,
      fixedIdentity: { credential },
      engine: { digest: "engine" },
      game: { name: "World" },
      epoch: crypto.randomUUID(),
      reconnectEnabled: true,
    });
    s.availableBridge = () => null;
    await s.listen(r);
    r.controlPort = r.server.address().port;
    return r;
  }
  let r = await start();
  const clients = [crypto.randomUUID(), crypto.randomUUID()].map(
    (inviteId) => ({
      roomId: id,
      inviteId,
      hostIp: r.ip,
      controlPort: r.controlPort,
      authKey: fixed.authKey(credential, inviteId),
    }),
  );
  for (const c of clients)
    assert.equal((await p.request(c, "hello")).roomId, id);
  assert.equal(r.invites.size, 2);
  const member = r.invites.get(clients[0].inviteId);
  member.resumeKey = p.randomKey();
  member.phase = "joined";
  member.playerName = "Friend";
  await assert.rejects(
    p.request(clients[0], "leave", { resumeKey: p.randomKey() }),
    /身份不匹配/,
  );
  await p.request(clients[0], "leave", { resumeKey: member.resumeKey });
  assert.equal(member.phase, "left");
  assert.equal(member.playerName, undefined);
  assert.equal(r.invites.get(clients[0].inviteId).expires, fixed.NEVER);
  const wrong = {
    ...clients[0],
    inviteId: crypto.randomUUID(),
    authKey: p.randomKey(),
  };
  await assert.rejects(p.request(wrong, "hello"), /拒绝/);
  assert.equal(r.invites.size, 2);
  await new Promise((resolve) => r.server.close(resolve));
  s.room = null;
  r = await start();
  try {
    for (const c of clients)
      assert.equal(
        (await p.request({ ...c, controlPort: r.controlPort }, "health"))
          .roomId,
        id,
      );
  } finally {
    await new Promise((resolve) => r.server.close(resolve));
  }
});
