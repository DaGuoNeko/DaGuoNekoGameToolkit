const { canonical } = require("./game-processes.cjs");

// Called inside WorldLibrary's queue, which also serializes launch preparation.
// Only isolated hosts have a private world list; a shared/menu client can open
// another shared world without going through the toolbox's launch buttons.
async function assertWorldMutation(sessions, gameProcesses, ids) {
  const check = () => {
    if (sessions?.starting || sessions?.stopping)
      throw Error("正在启动或停止游戏，请稍后再管理存档");
    const workers = (sessions?.workers || []).filter((w) => w.session?.running);
    if (workers.some((w) => ids.includes(w.session.worldId)))
      throw Error("该存档正在运行，请先保存并退出该存档");
    if (workers.some((w) => w.session.storageMode !== "isolated"))
      throw Error(
        "共享模式或菜单客户端仍在运行，无法确认存档占用，请先退出这些客户端",
      );
    return workers;
  };
  check();
  const processes = await gameProcesses.conflicts();
  const workers = check();
  const bridges = sessions?.bridge?.snapshot().sessions || [];
  for (const process of processes) {
    const worker = workers.find((w) =>
      bridges.some(
        (b) =>
          b.connected &&
          b.registrationId === w.session.bridgeRegistrationId &&
          b.mcdkPid === w.session.pid &&
          b.minecraftPid === process.pid,
      ),
    );
    const game = worker?.sourceSnapshot?.config.game_executable_path;
    if (!game || (await canonical(game)) !== (await canonical(process.path)))
      throw Error(
        "检测到未由当前工具箱隔离管理的游戏，请退出该游戏后再管理存档",
      );
  }
  check();
}

module.exports = { assertWorldMutation };
