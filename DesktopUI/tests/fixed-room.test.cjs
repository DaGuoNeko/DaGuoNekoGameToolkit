const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const fixed = require("../electron/network/fixed-room.cjs"),
  p = require("../electron/network/protocol.cjs"),
  { Rooms } = require("../electron/network/rooms.cjs");
test("closing and recreating Rooms with the same code reproduces the complete invitation", async (t) => {
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
    s.listen = async () => {};
    s.monitor = () => {};
    return s;
  }
  let text;
  for (let pass = 0; pass < 2; pass++) {
    const s = service();
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
    if (pass) assert.equal(invitation.text, text);
    else text = invitation.text;
    await s.close();
    assert.equal(worker.session.running, true);
  }
  assert.equal(starts[0].fixedCredential, starts[1].fixedCredential);
  assert.equal(starts[0].privateKey, starts[1].privateKey);
  assert.notEqual(starts[0].instance, starts[1].instance);
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
    await b.identity("朋友地图", "tcp://example.test:30000", () => {
      throw Error("must not reallocate");
    }),
    original,
  );
  assert.equal(
    fixed.encode(await b.identity("朋友地图", original.endpoint, () => {})),
    text,
  );
  const moved = await b.identity("朋友地图", "tcp://new.test:32000", () => {});
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
