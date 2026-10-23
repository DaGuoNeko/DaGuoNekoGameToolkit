const path = require("node:path");
const clean = (text, limit) =>
  typeof text === "string"
    ? text
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, limit)
    : "";
function titleFor(session, info) {
  const world =
    clean(info?.world, 100) ||
    (session.role === "world" ? clean(session.worldName, 100) : "") ||
    (session.autoJoin?.phase === "joined"
      ? clean(session.autoJoin.worldName, 100)
      : "") ||
    (session.gameReady ? "联机游戏" : "主菜单");
  // MCDK locates windows by PID plus a case-sensitive "Minecraft" title match.
  return `Minecraft · ${world} · ${clean(info?.player, 64) || clean(session.userName, 64) || "玩家"}`;
}
const infoCode =
  "# DGN_WINDOW_IDENTITY\nimport clientlevel\nimport mod.client.extraClientApi as api\n_p = api.GetLocalPlayerId()\n_result = {'world':clientlevel.get_level_name(),'player':api.GetEngineCompFactory().CreateName(_p).GetName()}";
class GameTitles {
  constructor(
    sessions,
    debug,
    runtime,
    { createWorker, interval = 1000 } = {},
  ) {
    Object.assign(this, { sessions, debug, runtime });
    this.records = new Map();
    this.child = null;
    this.closed = false;
    this.failed = false;
    this.last = "";
    this.createWorker =
      createWorker ||
      (() =>
        require("electron").utilityProcess.fork(
          path.join(__dirname, "game-title-worker.cjs"),
          [],
          { stdio: "pipe", serviceName: "Game window titles" },
        ));
    this.timer = setInterval(() => {
      try {
        this.refresh();
      } catch (e) {
        this.fail(e.message);
      }
    }, interval);
    this.timer.unref();
  }
  fail(message) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.sessions.workers
      .find((w) => w.session?.running)
      ?.log?.("system", "窗口标题同步已停止，游戏仍可正常使用：" + message);
    this.child?.kill();
  }
  refresh() {
    if (this.closed || this.failed) return;
    const bridges = this.debug.snapshot().sessions;
    const targets = [];
    const seen = new Set();
    for (const worker of this.sessions.workers) {
      const s = worker.session;
      if (!s?.running || worker.stopping) continue;
      const b = bridges.find(
        (b) =>
          b.connected &&
          b.registrationId === s.bridgeRegistrationId &&
          b.mcdkPid === s.pid,
      );
      if (
        !b ||
        !Number.isInteger(b.minecraftPid) ||
        b.minecraftPid <= 0 ||
        typeof b.projectRoot !== "string" ||
        !s.runDirectory ||
        path.resolve(b.projectRoot).toLowerCase() !==
          path.resolve(s.runDirectory).toLowerCase()
      )
        continue;
      const key = `${s.id}:${b.minecraftPid}:${b.connectionGeneration}:${b.stateSequence}:${b.state}`;
      seen.add(s.id);
      let record = this.records.get(s.id);
      if (record?.key !== key) {
        record = { key, info: null };
        this.records.set(s.id, record);
        if (
          b.state === "game_ready" &&
          b.gameIpcConnected &&
          b.debugCapabilityEnabled
        ) {
          const stillCurrent = () =>
            !this.closed &&
            s.running &&
            !worker.stopping &&
            this.records.get(s.id) === record &&
            this.debug
              .snapshot()
              .sessions.some(
                (now) =>
                  now.connected &&
                  now.id === b.id &&
                  now.minecraftPid === b.minecraftPid &&
                  now.connectionGeneration === b.connectionGeneration &&
                  now.stateSequence === b.stateSequence &&
                  now.state === "game_ready",
              );
          // One read per connection/world transition, never a per-frame script.
          this.debug
            .code(b.id, b.connectionGeneration, infoCode, true, () => {
              if (!stillCurrent()) throw Error("窗口会话已变化");
            })
            .then((info) => {
              if (stillCurrent()) {
                record.info = info;
                this.refresh();
              }
            })
            .catch(() => {}); // Optional identity API: retain launch metadata on unsupported builds.
        }
      }
      targets.push({
        key,
        pid: b.minecraftPid,
        parentPid: s.pid,
        exe: worker.sourceSnapshot.config.game_executable_path,
        title: titleFor(
          {
            ...s,
            gameReady: b.state === "game_ready",
            worldName: s.worldName || worker.sourceSnapshot.config.world_name,
          },
          record.info,
        ),
      });
    }
    for (const id of this.records.keys())
      if (!seen.has(id)) this.records.delete(id);
    const message = JSON.stringify(targets);
    if (message === this.last || (!targets.length && !this.child)) return;
    this.last = message;
    this.pendingTargets = targets;
    if (!this.child) {
      this.child = this.createWorker();
      this.child.stdout?.resume();
      this.child.stderr?.resume();
      this.child.on("exit", () => {
        this.child = null;
        if (!this.closed) this.fail("后台标题服务已退出");
      });
      this.child.on("error", (e) => this.fail(e.message));
      this.child.once("spawn", () => {
        if (this.closed || this.failed) return;
        this.spawned = true;
        this.child.postMessage({
          type: "init",
          runtime: this.runtime,
          ownerPid: process.pid,
        });
        this.child.postMessage({
          type: "targets",
          targets: this.pendingTargets,
        });
      });
    }
    if (this.spawned) this.child.postMessage({ type: "targets", targets });
  }
  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.records.clear();
    this.child?.kill();
    this.child = null;
  }
}
module.exports = { GameTitles, titleFor, infoCode };
