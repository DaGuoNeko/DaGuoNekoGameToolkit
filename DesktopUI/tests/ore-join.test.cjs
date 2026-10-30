const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  vm = require("node:vm");
const {
  OreJoin,
  hostIdentity,
  selectRoom,
  scripts,
} = require("../electron/domains/client/ore-join.cjs");
const { OreCdp } = require("../electron/domains/client/ore-cdp.cjs");
const { checkEngine } = require("../electron/domains/client/ore-native.cjs");
const target = {
  owner: "Host",
  name: "含空格 世界",
  netherNetId: "16965508177096150310",
};
const room = {
  ownerName: target.owner,
  name: target.name,
  address: "UNASSIGNED_SYSTEM_ADDRESS",
  port: 0,
  id:
    target.owner +
    target.name +
    "v" +
    target.netherNetId +
    "UNASSIGNED_SYSTEM_ADDRESSUNASSIGNED_RAKNET_GUID",
};
test("64-bit identity stays a string; duplicate titles, foreign IDs and invalid records cannot select a host", () => {
  assert.equal(
    hostIdentity({ netherNetId: target.netherNetId }),
    target.netherNetId,
  );
  for (const id of [
    Number(target.netherNetId),
    "0",
    "18446744073709551616",
    "1e19",
    null,
  ])
    assert.throws(() => hostIdentity({ netherNetId: id }));
  assert.equal(selectRoom([room], target), room);
  assert.equal(
    selectRoom(
      [
        {
          ...room,
          id: room.id.replace(
            target.netherNetId,
            String(Number(target.netherNetId)),
          ),
        },
      ],
      target,
    ),
    null,
  );
  assert.equal(selectRoom([{ ...room, port: 19132 }], target), null);
  assert.throws(() => selectRoom([room, room], target), /多个/);
  assert.throws(() => selectRoom([null], target), /无效/);
});
test("native facet script invokes exact ID only once, checks current list, and cleans only private subscriptions", () => {
  const handlers = new Map(),
    calls = [];
  const engine = {
    on: (k, f) => handlers.set(k, f),
    off: (k, f) => {
      assert.equal(handlers.get(k), f);
      handlers.delete(k);
    },
    trigger: (...args) => calls.push(args),
  };
  const env = vm.createContext({ window: {}, engine }),
    s = scripts("__test", "lan_test", "join_test");
  vm.runInContext(s.init, env);
  handlers.get("facet:updated:lan_test")({ lanWorlds: [room] });
  handlers.get("facet:updated:join_test")({
    joinLanServer: (id) => calls.push(["join", id]),
    joinLANServerTaskState: 0,
    joinLANServerResult: 0,
  });
  assert.deepEqual(JSON.parse(vm.runInContext(s.read, env)).rows, [room]);
  assert.throws(() => vm.runInContext(s.send("other"), env), /room changed/);
  assert.equal(vm.runInContext(s.send(room.id), env), true);
  assert.throws(() => vm.runInContext(s.send(room.id), env), /already sent/);
  assert.equal(calls.filter((x) => x[0] === "join").length, 1);
  vm.runInContext(s.cleanup, env);
  assert.equal(handlers.size, 0);
  assert.equal(env.window.__test, undefined);
});
test("unsupported executable is rejected before any game process or native initialization", async () => {
  await assert.rejects(
    checkEngine(__filename),
    (error) =>
      /尚未适配/.test(error.message) &&
      error.message.includes("3.10.0.420447") &&
      error.message.includes("3.10.0.436581"),
  );
});
test("CDP owner rejection happens before HTTP access", async () => {
  let fetched = false;
  const c = new OreCdp(40000, 123, () => {}, {
    owner: async () => {
      throw Error("foreign PID");
    },
    fetchImpl: async () => {
      fetched = true;
    },
  });
  await assert.rejects(c.connect(), /foreign PID/);
  assert.equal(fetched, false);
});
class FakeSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  reply(data) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}
const page = [
  {
    id: "7",
    url: "ui://./hbui/index.html",
    webSocketDebuggerUrl: "ws://foreign.invalid/steal",
  },
];

test("native-menu null page list is distinguishable from malformed responses", async () => {
  const c = new OreCdp(40000, 123, () => {}, {
    owner: async () => {},
    fetchImpl: async () => new Response("null"),
  });
  await assert.rejects(c.connect(), (e) => e.code === "ORE_MENU_NOT_PRESENT");
  c.close();
  const malformed = new OreCdp(40000, 123, () => {}, {
    owner: async () => {},
    fetchImpl: async () => new Response("{}"),
  });
  await assert.rejects(malformed.connect(), /页面列表无效/);
  malformed.close();
});
test("CDP ignores supplied URLs, bounds frames, checks owner and never replays timed-out evaluation", async () => {
  let checks = 0;
  const c = new OreCdp(40000, 123, () => {}, {
    owner: async () => checks++,
    Socket: FakeSocket,
    timeoutMs: 20,
    fetchImpl: async () => new Response(JSON.stringify(page)),
  });
  await c.connect();
  assert.equal(c.socket.url, "ws://127.0.0.1:40000/devtools/page/7");
  await assert.rejects(c.evaluate("write_once()"), /结果未知/);
  assert.equal(c.socket.sent.length, 1);
  assert(checks >= 3);
  c.receive("x".repeat(1024 * 1024 + 1));
  assert.equal(c.closed, true);
});
test("CDP propagates native exceptions and cancellation rejects outstanding requests", async () => {
  const c = new OreCdp(40000, 123, () => {}, {
    owner: async () => {},
    Socket: FakeSocket,
    fetchImpl: async () => new Response(JSON.stringify(page)),
  });
  await c.connect();
  const a = c.evaluate("error");
  await new Promise((r) => setImmediate(r));
  c.socket.reply({
    id: 1,
    result: {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "bad native target" },
      },
    },
  });
  await assert.rejects(a, /bad native target/);
  const b = c.evaluate("pending");
  await new Promise((r) => setImmediate(r));
  c.close();
  await assert.rejects(b, /关闭/);
});
test("an uncertain facet setup is never retried and native cleanup seals the private port", async () => {
  let connections = 0,
    initializations = 0,
    seals = 0,
    play = 0;
  class Cdp {
    async connect() {
      connections++;
    }
    async evaluate(code) {
      if (code.includes("duplicate setup")) {
        initializations++;
        throw Error("unknown result");
      }
    }
    close() {}
  }
  const transport = new OreJoin("unused", {
    Cdp,
    menuDelay: 0,
    window: async (r, w, p, mode) => {
      if (mode === "play") play++;
    },
    call: async () => {
      seals++;
    },
    sleep: async () => {},
  });
  const c = {
    attempted: true,
    pid: 1,
    port: 40000,
    worker: { session: { running: true }, log() {} },
    preparedAt: Date.now(),
    release: async () => {},
    script: scripts("__test", "lan", "join"),
  };
  await assert.rejects(
    transport.open(
      c,
      () => {},
      () => {},
      Date.now() + 1000,
    ),
    /unknown result/,
  );
  await transport.close(c);
  await transport.close(c);
  assert.equal(connections, 1);
  assert.equal(initializations, 1);
  assert.equal(play, 1);
  assert.equal(seals, 1);
});

test("reconnect reuses the owned process and original port, then seals it again", async () => {
  const calls = [],
    worker = { session: { running: true }, log() {} };
  const transport = new OreJoin("runtime", {
    checkEngine: async () => ({ digest: "test" }),
    call: async (...args) => calls.push(args[3]),
  });
  const context = await transport.resume(
    { game_executable_path: "C:/game.exe" },
    "a".repeat(32),
    worker,
    { id: "b", minecraftPid: 123, connectionGeneration: 2 },
    40000,
    () => {},
  );
  assert.equal(context.pid, 123);
  assert.equal(context.port, 40000);
  assert.equal(context.reconnecting, true);
  assert.equal(context.worker, worker);
  await transport.close(context);
  assert.deepEqual(calls, ["resume:40000", "seal"]);
});

test("menu assertion waits without sending Enter, then initializes once after dismissal", async () => {
  const calls = [],
    notices = [];
  let polls = 0;
  class Cdp {
    async connect() {
      calls.push("connect");
    }
    async evaluate() {
      calls.push("evaluate");
    }
    close() {}
  }
  const transport = new OreJoin("unused", {
    Cdp,
    menuDelay: 0,
    window: async (r, w, p, mode) => {
      if (mode === "play") calls.push("play");
      else if (++polls <= 2) {
        assert.deepEqual(calls, []);
        throw Object.assign(Error("GAME_ASSERT_DIALOG: fixture"), {
          code: "GAME_ASSERT_DIALOG",
        });
      }
    },
    sleep: async () => {},
  });
  const c = {
    attempted: true,
    pid: 1,
    preparedAt: Date.now(),
    script: scripts("k", "l", "j"),
  };
  await transport.open(
    c,
    () => {},
    () => {},
    Date.now() + 1000,
    (message) => notices.push(message),
  );
  assert.deepEqual(calls, ["play", "connect", "evaluate"]);
  assert.equal(notices.at(-1), null);
  assert.equal(c.assertionPending, false);
});
test("slow startup waits for readiness before its one menu action and expires without input", async () => {
  let ready = false, waits = 0, plays = 0;
  const transport = new OreJoin("unused", {
    menuDelay: 0,
    startupReady: () => ready,
    window: async (r, w, p, mode) => { if (mode === "play") { assert(ready); plays++; } },
    sleep: async () => { assert.equal(plays, 0); if (++waits === 3) ready = true; },
    Cdp: class { async connect() {} async evaluate() {} close() {} },
  });
  const context = () => ({ attempted: true, pid: 1, preparedAt: Date.now(), script: scripts("k", "l", "j") });
  await transport.open(context(), () => {}, () => {}, Date.now() + 1000);
  assert.equal(plays, 1);
  assert.equal(waits, 3);
  ready = false;
  await assert.rejects(transport.open(context(), () => {}, () => {}, Date.now() - 1), /初始化完成超时/);
  assert.equal(plays, 1);
});

test("new-build cold-start wait retains the original deadline, cancellation and single-input boundary", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  async function open(
    version,
    {
      reconnecting = false,
      deadline = 120000,
      cancelAt = Infinity,
      preparedAt = 0,
      inspectDelay = 0,
      connectDelay = 0,
      absentMenu = false,
    } = {},
  ) {
    now = 0;
    const keys = [];
    class Cdp {
      async connect() {
        now += connectDelay;
        if (absentMenu)
          throw Object.assign(Error("no menu"), {
            code: "ORE_MENU_NOT_PRESENT",
          });
      }
      async evaluate() {}
      close() {}
    }
    const transport = new OreJoin("unused", {
      Cdp,
      sleep: async (ms) => {
        now += ms;
      },
      window: async (r, w, p, mode) => {
        if (mode === "play") keys.push(now);
        else now += inspectDelay;
      },
    });
    const context = {
      attempted: true,
      pid: 1,
      preparedAt,
      reconnecting,
      engine: { version },
      script: scripts("cold", "l", "j"),
    };
    const promise = transport.open(
      context,
      () => {
        if (now >= cancelAt) throw Error("cancelled");
      },
      () => {},
      deadline,
    );
    return { promise, keys, context, transport };
  }
  for (const [version, reconnecting, expected] of [
    ["3.10.0.436581", false, 10000],
    ["3.10.0.448891", false, 25000],
    ["3.10.0.448891", true, 10000],
  ]) {
    const result = await open(version, { reconnecting });
    await result.promise;
    assert.deepEqual(result.keys, [expected]);
    assert.equal(result.context.deadline, 120000);
  }
  const expired = await open("3.10.0.448891", { deadline: 10000 });
  await assert.rejects(expired.promise, /等待菜单超时/);
  assert.deepEqual(expired.keys, []);
  const cancelled = await open("3.10.0.448891", { cancelAt: 1000 });
  await assert.rejects(cancelled.promise, /cancelled/);
  assert.deepEqual(cancelled.keys, []);
  for (const options of [
    { deadline: 25000 },
    { deadline: -1, preparedAt: -30000 },
    { deadline: 26000, inspectDelay: 2000 },
  ]) {
    const late = await open("3.10.0.448891", options);
    await assert.rejects(late.promise, /等待菜单超时/);
    assert.deepEqual(late.keys, []);
  }
  const reconnect = await open("3.10.0.448891", {
    reconnecting: true,
    deadline: 20000,
    connectDelay: 4000,
    absentMenu: true,
  });
  await assert.rejects(reconnect.promise, /等待菜单超时/);
  assert.deepEqual(reconnect.keys, [10000]);
  const dispatch = await open("3.10.0.448891");
  await dispatch.promise;
  now = dispatch.context.deadline;
  await assert.rejects(
    dispatch.transport.dispatch(dispatch.context, { id: "unused" }),
    /未发送入房请求/,
  );
  assert.equal(dispatch.context.sent, undefined);
});

test("pending assertion cleanup skips blocked page code but seals the private native channel", async () => {
  const calls = [];
  const transport = new OreJoin("unused", {
    call: async (r, w, p, mode) => calls.push(mode),
  });
  const c = {
    assertionPending: true,
    setup: true,
    attempted: true,
    pid: 1,
    worker: { session: { running: true }, log() {} },
    release: async () => calls.push("release"),
    cdp: {
      evaluate: async () => assert.fail("must not call paused game"),
      close: () => calls.push("close"),
    },
  };
  await transport.close(c);
  await transport.close(c);
  assert.deepEqual(calls, ["release", "close", "seal"]);
  assert(c.sealed);
});
