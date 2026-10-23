const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const { GameTitles, titleFor } = require("../electron/game-titles.cjs");
test("game titles identify world/player and never label an unjoined menu as the host world", () => {
  assert.equal(
    titleFor({ role: "world", worldName: "测试地图", userName: "玩家甲" }),
    "Minecraft · 测试地图 · 玩家甲",
  );
  assert.equal(
    titleFor({
      role: "menu",
      userName: "Bob",
      autoJoin: { phase: "joining", worldName: "Host" },
    }),
    "Minecraft · 主菜单 · Bob",
  );
  assert.equal(
    titleFor({
      role: "menu",
      userName: "Bob",
      autoJoin: { phase: "joined", worldName: "Host" },
    }),
    "Minecraft · Host · Bob",
  );
  assert.equal(
    titleFor({ userName: "Bob" }, { world: "Actual", player: "真实玩家" }),
    "Minecraft · Actual · 真实玩家",
  );
  assert.equal(titleFor({ gameReady: true }), "Minecraft · 联机游戏 · 玩家");
  assert.equal(titleFor({}), "Minecraft · 主菜单 · 玩家");
});
test("title controller scopes metadata reads and rejects stale replies after exit/reconnect", async (t) => {
  const messages = [],
    pending = [];
  const child = new EventEmitter();
  child.postMessage = (v) => messages.push(v);
  child.kill = () => {};
  const workers = [1, 2].map((n) => ({
    session: {
      id: "s" + n,
      role: "world",
      running: true,
      bridgeRegistrationId: "r" + n,
      pid: n,
      runDirectory: "C:/runs/" + n,
      userName: "p" + n,
    },
    sourceSnapshot: {
      config: { world_name: "world" + n, game_executable_path: "C:/game.exe" },
    },
  }));
  let bridges = workers.map((w, i) => ({
    connected: true,
    id: "b" + i,
    registrationId: w.session.bridgeRegistrationId,
    mcdkPid: w.session.pid,
    minecraftPid: 11 + i,
    projectRoot: w.session.runDirectory,
    connectionGeneration: 1,
    stateSequence: 1,
    state: "game_ready",
    gameIpcConnected: true,
    debugCapabilityEnabled: true,
  }));
  const debug = {
    snapshot: () => ({ sessions: bridges }),
    code: (id, gen, code, side, guard) =>
      new Promise((resolve) => pending.push({ resolve, guard })),
  };
  const titles = new GameTitles({ workers }, debug, "runtime", {
    createWorker: () => child,
    interval: 999999,
  });
  t.after(() => titles.dispose());
  titles.refresh();
  child.emit("spawn");
  titles.refresh();
  assert.equal(pending.length, 2);
  assert.deepEqual(
    messages.at(-1).targets.map((t) => t.title),
    ["Minecraft · world1 · p1", "Minecraft · world2 · p2"],
  );
  workers[0].session.running = false;
  titles.refresh();
  assert.throws(pending[0].guard, /会话已变化/);
  pending[0].resolve({ world: "wrong", player: "wrong" });
  pending[1].resolve({ world: "实际地图", player: "玩家乙" });
  await new Promise((r) => setImmediate(r));
  assert.equal(messages.at(-1).targets.length, 1);
  assert.equal(messages.at(-1).targets[0].title, "Minecraft · 实际地图 · 玩家乙");
  bridges = [{ ...bridges[1], mcdkPid: 999 }];
  titles.refresh();
  assert.deepEqual(messages.at(-1).targets, []);
});
