const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertWorldMutation } = require("../electron/domains/worlds/world-mutation.cjs");

function fixture() {
  const game = "C:\\dgn-fixture\\Minecraft.Windows.exe";
  const workers = [1, 2].map((n) => ({
    session: {
      running: true,
      worldId: "world" + n,
      storageMode: "isolated",
      pid: 100 + n,
      bridgeRegistrationId: "reg" + n,
    },
    sourceSnapshot: { config: { game_executable_path: game } },
  }));
  const sessions = {
    workers,
    bridge: {
      snapshot: () => ({
        sessions: workers.map((w, i) => ({
          connected: true,
          registrationId: w.session.bridgeRegistrationId,
          mcdkPid: w.session.pid,
          minecraftPid: 201 + i,
        })),
      }),
    },
  };
  const processes = [201, 202].map((pid) => ({ pid, path: game }));
  return {
    sessions,
    processes,
    inventory: { conflicts: async () => processes },
  };
}

test("world mutation permits other isolated hosts but rejects any active target", async () => {
  const { sessions, inventory } = fixture();
  await assertWorldMutation(sessions, inventory, ["idle"]);
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle", "world2"]),
    /正在运行/,
  );
  sessions.workers[1].session.running = false;
  inventory.conflicts = async () => [
    { pid: 201, path: "C:\\dgn-fixture\\Minecraft.Windows.exe" },
  ];
  await assertWorldMutation(sessions, inventory, ["world2"]);
});

test("world mutation retains shared/menu and unknown process protection", async () => {
  const { sessions, inventory, processes } = fixture();
  sessions.workers[0].session.storageMode = "shared";
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle"]),
    /共享模式/,
  );
  sessions.workers[0].session.storageMode = "isolated";
  processes.push({ pid: 999, path: processes[0].path });
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle"]),
    /未由当前工具箱/,
  );
  processes.pop();
  processes[0].path = "C:\\another\\Minecraft.Windows.exe";
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle"]),
    /未由当前工具箱/,
  );
});

test("world mutation rechecks lifecycle after asynchronous process inventory", async () => {
  const { sessions, inventory } = fixture();
  inventory.conflicts = async () => {
    sessions.starting = true;
    return [];
  };
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle"]),
    /正在启动或停止/,
  );
  sessions.starting = false;
  sessions.stopping = true;
  await assert.rejects(
    assertWorldMutation(sessions, inventory, ["idle"]),
    /正在启动或停止/,
  );
});
