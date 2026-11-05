const crypto = require("node:crypto");
const { OreJoin, hostIdentity } = require("./ore-join.cjs");
const { proofCode } = require("./client-join-proof.cjs");
const { menuPlayerName } = require("./menu-name.cjs");
const { readJoinRoom } = require("./client-join-room.cjs");
const { LocalDiscovery } = require("./local-discovery.cjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
class ClientJoiner {
  constructor(
    sessions,
    debug,
    runtime,
    {
      transport = new OreJoin(runtime, {
        startupReady: (worker, pid) => sessions.gameLogs?.startupReady(worker, pid),
      }),
      discovery = new LocalDiscovery(runtime),
      timeoutMs = 120000,
      wait = delay,
      roomName = (target) =>
        readJoinRoom(sessions.worlds, target.worker.session.worldId),
    } = {},
  ) {
    Object.assign(this, {
      sessions,
      debug,
      transport,
      discovery,
      timeoutMs,
      wait,
      roomName,
    });
    this.jobs = new Map();
    this.pendingStarts = new Set();
    this.pendingNames = new Set();
    this.closing = false;
  }
  bridge(worker, ready = false) {
    if (!worker.session?.running || worker.stopping)
      throw Error("游戏会话已结束或正在停止");
    const b = this.debug
      .snapshot()
      .sessions.find(
        (b) =>
          b.connected &&
          b.registrationId === worker.session.bridgeRegistrationId &&
          b.mcdkPid === worker.session.pid,
      );
    if (!b) throw Error("游戏调试连接尚未就绪");
    return this.debug.session(b.id, b.connectionGeneration, ready);
  }
  host(id) {
    const w = this.sessions.workers.find((w) => w.session?.id === id);
    if (!w?.session.worldId || w.session.role !== "world")
      throw Error("请选择本工具箱启动的存档主机会话");
    return { worker: w, bridge: { ...this.bridge(w, true) } };
  }
  hosts() {
    return this.sessions.workers
      .filter(
        (w) =>
          w.session?.running &&
          w.session.role === "world" &&
          w.session.worldId &&
          !w.stopping,
      )
      .map((w) => {
        let bridge,
          reason = "";
        try {
          bridge = this.bridge(w, true);
        } catch (e) {
          reason = e.message;
        }
        return {
          sessionId: w.session.id,
          worldId: w.session.worldId,
          worldName:
            w.session.worldName ||
            w.sourceSnapshot?.config.world_name ||
            "未命名存档",
          playerName: w.session.userName || "玩家",
          launcherPid: w.session.pid,
          gamePid: bridge?.minecraftPid || null,
          ready: !!bridge,
          reason,
          engineVersion: w.session.engineVersion || null,
          engineProfile: w.session.engineProfile || null,
          autoJoinSupported: !!w.session.engineProfile?.autoJoin,
          storageMode: w.session.storageMode,
        };
      });
  }
  checkHost(target) {
    const current = this.bridge(target.worker, true),
      before = target.bridge;
    if (
      current.id !== before.id ||
      current.minecraftPid !== before.minecraftPid ||
      current.connectionGeneration !== before.connectionGeneration ||
      current.stateSequence !== before.stateSequence
    )
      throw Error("主房间在自动加入期间已重载或变化，操作已停止");
    return current;
  }
  hostCode(target, code) {
    const b = this.checkHost(target);
    return this.debug.code(b.id, b.connectionGeneration, code, false);
  }
  progress(worker, phase, message, extra = {}) {
    worker.session.autoJoin = {
      ...worker.session.autoJoin,
      phase,
      message,
      ...extra,
    };
    worker.log("system", "[自动联机] " + message);
    this.sessions.publish();
  }
  launch(hostSessionId, name) {
    const operation = (async () => {
      const playerName = menuPlayerName(name);
      if (this.pendingNames.has(playerName))
        throw Error("同名客户端正在启动，请等待完成或使用不同玩家名");
      this.pendingNames.add(playerName);
      try {
        return await this.startJoin(hostSessionId, playerName);
      } finally {
        this.pendingNames.delete(playerName);
      }
    })();
    this.pendingStarts.add(operation);
    operation
      .finally(() => this.pendingStarts.delete(operation))
      .catch(() => {});
    return operation;
  }
  async startJoin(hostSessionId, name) {
    if (this.closing) throw Error("工具箱正在关闭");
    const target = this.host(hostSessionId),
      playerName = menuPlayerName(name),
      token = crypto.randomBytes(16).toString("hex");
    if (
      this.sessions.workers.some(
        (w) => w.session?.running && w.session.userName === playerName,
      )
    )
      throw Error("已有同名运行客户端，请使用不同玩家名");
    const room = await this.roomName(target);
    this.checkHost(target);
    const identity = await this.debug.code(
      target.bridge.id,
      target.bridge.connectionGeneration,
      "import clientlevel\n_result={'netherNetId':str(clientlevel.get_nethernet_id())}",
      true,
    );
    const netherNetId = hostIdentity(identity);
    const checkStarting = () => {
      if (this.closing) throw Error("工具箱正在关闭");
      this.checkHost(target);
    };
    const context = await this.transport.create(
      target.worker.sourceSnapshot.config,
      token,
      checkStarting,
    );
    let worker,
      prepared = false;
    try {
      checkStarting();
      const expectedGameDigest = target.worker.session.engineDigest;
      if (!expectedGameDigest || expectedGameDigest !== context.engine?.digest)
        throw Error("房主游戏文件与启动时的构建不一致，请重新启动房主后再加入");
      await this.hostCode(target, proofCode(token, "prepare"));
      prepared = true;
      const state = await this.sessions.start(
        null,
        null,
        { userName: playerName },
        {
          debug: true,
          localJoin: true,
          playerName,
          expectedGameDigest,
          preflight: checkStarting,
          prepareClient: async (created, bridge) => {
            worker = created;
            checkStarting();
            await this.transport.prepare(context, created, bridge);
            checkStarting();
            if (target.worker.session.storageMode === "isolated") {
              const checkPair = () => {
                checkStarting();
                const current = this.bridge(created);
                if (
                  current.id !== bridge.id ||
                  current.minecraftPid !== bridge.minecraftPid ||
                  current.connectionGeneration !== bridge.connectionGeneration
                )
                  throw Error("新客户端连接代次已变化");
              };
              context.discovery = await this.discovery.open(
                target.worker,
                target.bridge,
                created,
                bridge,
                netherNetId,
                checkPair,
              );
              checkPair();
            }
          },
          runtimeConfig: structuredClone(target.worker.sourceSnapshot.config),
          runtimeFullscreen: target.worker.launchSource?.fullscreen,
        },
      );
      worker = this.sessions.workers.find(
        (w) => w.session?.id === state.selectedSession,
      );
      this.checkHost(target);
      if (worker?.session.engineDigest !== expectedGameDigest)
        throw Error("主客机游戏构建不一致，已停止新客户端");
    } catch (error) {
      context.discovery?.close();
      try {
        if (prepared) await this.hostCode(target, proofCode(token, "cleanup"));
      } catch (cleanupError) {
        error.message +=
          "；验证监听清理未确认，将由房主计时器释放：" + cleanupError.message;
      }
      try {
        await this.transport.close(context);
      } catch (e) {
        error.message += "；原生通道清理：" + e.message;
      }
      if (worker?.session.running) await this.sessions.stop(worker.session.id);
      throw error;
    }
    worker.session.autoJoin = {
      hostSessionId,
      hostGamePid: target.bridge.minecraftPid,
      transport: "oreui",
      engineVersion: context.engine?.version,
      worldId: target.worker.session.worldId,
      worldName: room.name,
      libraryWorldName: target.worker.sourceSnapshot.config.world_name,
      worldNameSource: room.source,
      startedAt: new Date().toISOString(),
    };
    const job = {
      worker,
      target,
      token,
      context,
      room: {
        name: room.name,
        owner: target.worker.session.userName,
        netherNetId,
      },
      cancelled: false,
    };
    this.jobs.set(worker.session.id, job);
    this.progress(
      worker,
      "waiting_menu",
      "客户端已启动，正在等待主菜单和局域网房间：" + room.name,
    );
    job.promise = this.run(job).finally(() =>
      this.jobs.delete(worker.session.id),
    );
    return worker.session.id;
  }
  async run(job) {
    const { worker, target, token, context } = job,
      end = Date.now() + this.timeoutMs;
    let sent = null,
      dispatched = false,
      resumePhase = null,
      lastError = "等待原生房间列表";
    const onAssertion = (message) => {
      if (message) {
        if (!resumePhase) resumePhase = worker.session.autoJoin.phase;
        if (worker.session.autoJoin.assertion === message) return;
        this.progress(
          worker,
          "waiting_assertion",
          "游戏出现断言，已暂停自动加入并保留客户端。请处理游戏弹窗，关闭弹窗后将在本次等待期限内继续。\n" +
            message,
          { assertion: message },
        );
      } else if (resumePhase) {
        this.progress(
          worker,
          resumePhase,
          "断言弹窗已关闭，继续自动加入与房主验证",
          {
            assertion: null,
          },
        );
        resumePhase = null;
      }
    };
    const check = () => {
      context.discovery?.assert();
      if (job.cancelled || this.closing) throw Error("自动加入已取消");
      this.checkHost(target);
      const current = this.bridge(worker);
      if (
        context.pid &&
        (current.minecraftPid !== context.pid ||
          current.id !== context.registration ||
          current.connectionGeneration !== context.generation)
      )
        throw Error("新客户端连接代次已变化");
      return current;
    };
    try {
      await this.transport.open(
        context,
        check,
        (phase, message) => this.progress(worker, phase, message),
        end,
        onAssertion,
      );
      while (Date.now() < end) {
        await this.transport.inspect(context);
        const b = check();
        if (
          b.state === "game_ready" &&
          b.gameIpcConnected &&
          b.debugCapabilityEnabled
        ) {
          if (!dispatched) throw Error("新客户端提前进入了未验证的世界");
          if (!sent) {
            this.progress(
              worker,
              "verifying",
              "已进入游戏，正在等待指定房主确认玩家身份",
            );
            sent = await this.debug.code(
              b.id,
              b.connectionGeneration,
              proofCode(token, "send"),
              true,
            );
            if (typeof sent?.playerId !== "string")
              throw Error("新客户端未返回可验证的玩家身份");
          }
          const proof = await this.hostCode(target, proofCode(token, "read"));
          if (proof.players.includes(sent.playerId)) {
            await this.transport.close(context);
            check();
            this.progress(worker, "joined", "已验证加入指定主房间", {
              playerId: sent.playerId,
              verifiedAt: new Date().toISOString(),
            });
            return;
          }
        } else if (!sent) {
          if (!dispatched) {
            const row = await this.transport.discover(context, job.room);
            check();
            if (row) {
              await this.transport.dispatch(context, row);
              dispatched = true;
              this.progress(
                worker,
                "joining",
                "已向官方接口发送入房请求，等待游戏加载",
              );
            }
          } else await this.transport.status(context);
        }
        await this.wait(1000);
      }
      throw Error(
        "自动加入超时：" +
          (sent
            ? "指定房主未收到新客户端的身份回执"
            : lastError || "未进入目标房间"),
      );
    } catch (error) {
      const assertion = ["GAME_ASSERT_DIALOG", "GAME_ASSERT_PENDING"].includes(
        error.code,
      );
      if (assertion) context.assertionPending = true;
      this.progress(
        worker,
        assertion ? "needs_attention" : "failed",
        assertion
          ? "自动加入已结束，客户端与断言弹窗已保留，请手动处理。尚未验证加入目标房间；不要反复新开客户端。\n" +
              error.message
          : error.message,
        assertion ? { assertion: error.message } : {},
      );
      // An assertion needs user attention. Other lifecycle/protocol failures
      // still stop only this unverified new client.
      if (!assertion && worker.session.running) {
        try {
          await this.sessions.stop(worker.session.id);
        } catch (stopError) {
          this.progress(
            worker,
            "failed",
            error.message +
              "；无法停止新客户端，请手动关闭：" +
              stopError.message,
          );
        }
      }
    } finally {
      context.discovery?.close();
      try {
        await this.transport.close(context);
      } catch (error) {
        worker.log("stderr", "原生联机通道清理失败：" + error.message);
        this.progress(
          worker,
          "failed",
          "原生联机通道无法封闭，必须停止本次客户端：" + error.message,
        );
        if (worker.session.running) await this.sessions.stop(worker.session.id);
      }
      try {
        await this.hostCode(target, proofCode(token, "cleanup"));
      } catch (error) {
        worker.log(
          "system",
          "[自动联机] 验证监听清理未确认：" +
            error.message +
            "；房主内的限时监听将自行释放",
        );
      }
    }
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (job) job.cancelled = true;
  }
  async shutdown() {
    this.closing = true;
    for (const job of this.jobs.values()) job.cancelled = true;
    await Promise.allSettled([...this.pendingStarts]);
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }
}
module.exports = { ClientJoiner };
