const crypto = require("node:crypto"),
  http = require("node:http"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { EasyTier, freePort, delay } = require("./easytier.cjs");
const p = require("./protocol.cjs");
const { resolvePaths, profileDefaults } = require("../domains/profiles/profiles.cjs");
const { atomicWrite } = require("../services.cjs");
const { OreJoin, hostIdentity } = require("../domains/client/ore-join.cjs");
const { checkEngine } = require("../domains/client/ore-native.cjs");
const { readJoinRoom } = require("../domains/client/client-join-room.cjs");
const { proofCode } = require("../domains/client/client-join-proof.cjs");
const { menuPlayerName } = require("../domains/client/menu-name.cjs");
const {
  VERSION: SCRIPT_SYNC,
  ScriptSyncHost,
  ScriptSyncGuest,
} = require("./script-sync.cjs");
const RECONNECT = "room-resume-v1";
const fixed = require("./fixed-room.cjs");
const sameBridge = (a, b) =>
  !!a &&
  !!b &&
  a.id === b.id &&
  a.minecraftPid === b.minecraftPid &&
  a.connectionGeneration === b.connectionGeneration &&
  a.stateSequence === b.stateSequence;
class Rooms {
  constructor(
    { sessions, debug, profiles, worlds, runtime, dataRoot },
    options = {},
  ) {
    Object.assign(this, {
      sessions,
      debug,
      profiles,
      worlds,
      runtime,
      dataRoot,
    });
    this.makeNetwork =
      options.makeNetwork || (() => new EasyTier(runtime, dataRoot));
    this.transport = options.transport || new OreJoin(runtime, {
      startupReady: (worker, pid) => sessions.gameLogs?.startupReady(worker, pid),
    });
    this.checkEngine = options.checkEngine || checkEngine;
    this.clock = options.clock || (() => Date.now());
    this.wait = options.wait || delay;
    this.room = null;
    this.job = null;
    this.closing = false;
    this.request = options.request || p.request;
    this.localHostAddress = options.localHostAddress || p.localHostAddress;
    this.preferences = new fixed.RoomPreferences(dataRoot, options.protection);
  }
  check(r) {
    if (this.closing || this.room !== r || r.cancelled)
      throw Error("联机操作已取消");
  }
  snapshot() {
    const r = this.room;
    return r
      ? {
          id: r.id,
          role: r.role,
          fixed: !!r.fixed,
          phase: r.phase,
          message: r.message,
          error: [r.error, ...(r.cleanupErrors || [])]
            .filter(Boolean)
            .join("；"),
          name: r.name || "",
          endpoint: r.endpoint || "",
          localPort: r.localPort || 0,
          ip: r.ip || "",
          sessionId: r.worker?.session?.id || "",
          networkReady: !!r.networkReady,
          gameReady: r.phase === "joined" || r.phase === "hosting",
          epoch: r.epoch || "",
          canRetry: !!r.canRetry,
          scriptSync: r.scriptSync?.status || r.scriptSyncStatus || null,
          members: [...r.invites.values()].map((i) => ({
            id: i.inviteId,
            expires: i.expires,
            phase: i.phase || "invited",
            playerName: i.playerName || "",
            playerId: i.playerId || "",
            scriptSync: i.scriptSync || null,
          })),
          network: r.networkStats || null,
        }
      : { phase: "idle", members: [] };
  }
  progress(r, phase, message) {
    this.check(r);
    r.phase = phase;
    r.message = message;
  }
  async settings() {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this.dataRoot, "network-settings.json"),
          "utf8",
        ),
      );
    } catch (e) {
      if (e.code === "ENOENT") return { endpoint: "", localPort: 11010 };
      throw e;
    }
  }
  draft() {
    return this.preferences.draft();
  }
  saveDraft(args) {
    return this.preferences.saveDraft(args);
  }
  async profile(id) {
    const s = await this.profiles.read(id);
    if (!s.config) throw Error(s.error || "配置不存在");
    if (!(
      s.config.game_executable_path ||
      this.sessions.store.value.settings.GamePath
    ))
      throw Error("请先在设置中选择游戏程序，或在启动配置中指定游戏程序");
    return resolvePaths(
      {
        ...s.config,
        game_executable_path:
          s.config.game_executable_path ||
          this.sessions.store.value.settings.GamePath,
      },
      s.project.baseDirectory || s.project.root,
    );
  }
  bridge(worker, ready = true) {
    if (!worker?.session?.running || worker.stopping)
      throw Error("游戏会话已经结束");
    const b = this.debug
      .snapshot()
      .sessions.find(
        (b) =>
          b.connected &&
          b.registrationId === worker.session.bridgeRegistrationId &&
          b.mcdkPid === worker.session.pid,
      );
    if (!b) throw Error("正在等待游戏调试连接");
    return this.debug.session(b.id, b.connectionGeneration, ready);
  }
  availableBridge(worker, ready = true) {
    if (!worker?.session?.running || worker.stopping) return null;
    const b = this.debug
      .snapshot()
      .sessions.find(
        (b) =>
          b.connected &&
          b.registrationId === worker.session.bridgeRegistrationId &&
          b.mcdkPid === worker.session.pid,
      );
    if (
      !b ||
      (ready &&
        (b.state !== "game_ready" ||
          !b.gameIpcConnected ||
          !b.debugCapabilityEnabled))
    )
      return null;
    return { ...b };
  }
  hostCheck(r) {
    this.check(r);
    const b = this.bridge(r.worker);
    if (
      b.id !== r.bridge.id ||
      b.minecraftPid !== r.bridge.minecraftPid ||
      b.connectionGeneration !== r.bridge.connectionGeneration ||
      b.stateSequence !== r.bridge.stateSequence
    )
      throw Error("房主已重载或切换存档，请重新创建房间");
    return b;
  }
  hostCode(r, code, client = false) {
    const b = this.hostCheck(r),
      epoch = r.epoch;
    return this.debug.code(b.id, b.connectionGeneration, code, client, () => {
      const current = this.hostCheck(r);
      if (epoch !== r.epoch || !sameBridge(current, b))
        throw Error("房主已切换代次，旧代码请求已取消");
    });
  }
  async ready(r, worker) {
    const end = this.clock() + 120000;
    let last;
    while (this.clock() < end) {
      this.check(r);
      if (!worker?.session?.running || worker.stopping)
        throw Error("游戏启动进程已结束，请查看该会话日志");
      try {
        return { ...this.bridge(worker) };
      } catch (e) {
        last = e;
      }
      await this.wait(500);
    }
    throw Error("游戏未在等待期限内就绪：" + last.message);
  }
  reserve(role) {
    if (this.room || this.job || this.closing)
      throw Error("请先关闭当前联机房间");
    const r = {
      id: crypto.randomUUID(),
      role,
      phase: "preparing",
      message: "正在准备联机",
      invites: new Map(),
      network: this.makeNetwork(),
      cancelled: false,
    };
    this.room = r;
    return r;
  }
  run(r, action) {
    this.job = (async () => {
      try {
        await action();
      } catch (e) {
        if (!r.cancelled) {
          r.error = e.message;
          r.preserveClient = [
            "GAME_ASSERT_DIALOG",
            "GAME_ASSERT_PENDING",
          ].includes(e.code);
          if (r.preserveClient && r.context) r.context.assertionPending = true;
          r.phase = r.preserveClient ? "needs_attention" : "failed";
          r.message = r.preserveClient
            ? "断言窗口及客户端已保留，尚未验证入房"
            : "联机失败";
        }
        await this.cleanup(r);
      } finally {
        this.job = null;
      }
    })();
    return this.snapshot();
  }
  create(args) {
    const endpoint = p.endpoint(args.endpoint),
      localPort = Number(args.localPort);
    if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535)
      throw Error("樱花本地端口必须为 1024–65535");
    if (typeof args.worldId !== "string") throw Error("请选择存档");
    const code =
      args.roomCode === undefined ? null : fixed.roomCode(args.roomCode);
    const r = this.reserve("host");
    Object.assign(r, {
      endpoint,
      localPort,
      worldId: args.worldId,
      reconnectEnabled: true,
      epoch: crypto.randomUUID(),
    });
    return this.run(r, async () => {
      const world = (await this.worlds.list()).worlds.find(
        (w) => w.id === args.worldId && !w.deleted && !w.deletedAt,
      );
      if (!world || world.error) throw Error("所选存档不存在或不可用");
      r.name = world.name;
      r.worldPath = world.path;
      const existing = this.sessions.workers.find(
        (w) => w.session?.running && w.session.worldId === world.id,
      );
      const config = existing
        ? existing.sourceSnapshot.config
        : await this.profile(world.profileId);
      r.engine = await this.checkEngine(config.game_executable_path);
      this.check(r);
      r.ip = p.subnet();
      r.networkName = "dgn-" + crypto.randomBytes(16).toString("hex");
      r.controlPort = await freePort();
      const keys = crypto.generateKeyPairSync("x25519");
      r.privateKey = keys.privateKey.export({ format: "jwk" }).d;
      r.privateKey = Buffer.from(r.privateKey, "base64url").toString("base64");
      r.hostPublicKey = Buffer.from(
        keys.publicKey.export({ format: "jwk" }).x,
        "base64url",
      ).toString("base64");
      if (code !== null) {
        const saved = await this.preferences.identity(code, endpoint, freePort);
        Object.assign(r, {
          fixed: true,
          id: saved.roomId,
          ip: saved.hostIp,
          networkName: saved.network,
          controlPort: saved.controlPort,
          privateKey: saved.privateKey,
          hostPublicKey: saved.hostPublicKey,
          fixedIdentity: saved,
        });
        if (p.subnetConflict(r.ip))
          throw Error("固定房间网段与本机网络冲突，请更换邀请码后创建");
      }
      this.progress(
        r,
        "network_starting",
        "正在创建虚拟网络，请处理 Windows 授权提示",
      );
      const state = await r.network.start({
        role: "host",
        instance: crypto.randomUUID(),
        ip: r.ip,
        network: r.networkName,
        secret: r.fixedIdentity?.secret || p.randomKey(),
        privateKey: r.privateKey,
        localPort: r.localPort,
        controlPort: r.controlPort,
        gamePath: config.game_executable_path,
        ...(r.fixed
          ? { fixedCredential: r.fixedIdentity.credential, fixedId: r.id }
          : {}),
      });
      this.check(r);
      r.networkReady = true;
      this.networkSummary(r, state);
      await fs.mkdir(this.dataRoot, { recursive: true });
      await atomicWrite(
        path.join(this.dataRoot, "network-settings.json"),
        JSON.stringify({ endpoint, localPort }),
      );
      if (existing) r.worker = existing;
      else {
        this.progress(r, "game_starting", "虚拟网络已就绪，正在启动存档");
        const state = await this.sessions.start(
          world.profileId,
          world.id,
          null,
          { debug: true },
        );
        r.worker = this.sessions.workers.find(
          (w) => w.session?.id === state.selectedSession,
        );
      }
      this.check(r);
      r.bridge = await this.ready(r, r.worker);
      const room = await readJoinRoom(this.worlds, world.id);
      r.game = {
        name: room.name,
        owner: r.worker.session.userName,
        netherNetId: hostIdentity(
          await this.hostCode(
            r,
            "import clientlevel\n_result={'netherNetId':str(clientlevel.get_nethernet_id())}",
            true,
          ),
        ),
      };
      await this.verifyWorld(r, r.worker, r.bridge);
      await this.listen(r);
      r.scriptSync = new ScriptSyncHost(
        r.worker.sourceSnapshot.config,
        r.worker.session.runDirectory,
        () => this.hostCheck(r),
      );
      this.progress(
        r,
        "hosting",
        "房间已创建，可复制邀请；请确认樱花 TCP 隧道正在运行",
      );
      this.monitor(r);
    });
  }
  networkSummary(r, state) {
    if (!Array.isArray(state.peers)) throw Error("EasyTier 状态格式不匹配");
    const rows = state.peers.filter((x) => x.cost !== "Local");
    r.networkStats = {
      peers: rows.length,
      transport: "樱花 TCP",
      latencyMs:
        rows
          .map((c) => parseFloat(c.lat_ms))
          .filter((x) => Number.isFinite(x) && x >= 0)[0] ?? null,
    };
  }
  monitor(r) {
    let polling = false;
    r.timer = setInterval(async () => {
      if (polling || r.cancelled) return;
      polling = true;
      try {
        if (r.reconnectEnabled) {
          if (!r.localJoin) this.networkSummary(r, await r.network.status());
          if (r.role === "host") await this.recoverHost(r);
          else await this.recoverGuest(r);
          for (const i of r.invites.values())
            if (i.expires <= this.clock() && i.phase !== "expired") {
              i.phase = "expired";
              await r.network.revoke(i.inviteId);
            }
          return;
        }
        if (r.role === "host") this.hostCheck(r);
        else if (r.worker) {
          const b = this.bridge(r.worker);
          if (
            b.id !== r.clientBridge.id ||
            b.connectionGeneration !== r.clientBridge.connectionGeneration ||
            b.stateSequence !== r.clientBridge.stateSequence
          )
            throw Error("客户端已离开或重载，请重新加入");
        }
        if (!r.localJoin) this.networkSummary(r, await r.network.status());
        if (r.role === "guest") {
          await this.request(r.invite, "health");
          await r.scriptSync?.tick();
        }
        for (const i of r.invites.values())
          if (i.expires <= this.clock() && i.phase !== "expired") {
            i.phase = "expired";
            await r.network.revoke(i.inviteId);
          }
      } catch (e) {
        if (
          r.reconnectEnabled &&
          r.role === "guest" &&
          r.worker?.session?.running
        ) {
          this.pauseGuest(r, e.message);
          if (
            e.code === "ROOM_AUTH_REJECTED" ||
            r.invite.expires <= this.clock()
          ) {
            r.phase = "reconnect_blocked";
            r.message = "邀请已失效，请重新取得邀请；游戏客户端已保留";
            r.canRetry = false;
          }
          return;
        }
        clearInterval(r.timer);
        r.phase = "failed";
        r.message = "联机连接已结束";
        r.error = e.message;
        await this.cleanup(r);
      } finally {
        polling = false;
      }
    }, 3000);
    r.timer.unref();
  }
  async verifyWorld(r, worker, bridge) {
    const result = await this.debug.code(
      bridge.id,
      bridge.connectionGeneration,
      "import clientlevel\n_result={'path':clientlevel.get_level_path(),'name':clientlevel.get_level_name(),'netherNetId':str(clientlevel.get_nethernet_id())}",
      true,
    );
    this.check(r);
    if (!sameBridge(bridge, this.bridge(worker)))
      throw Error("房主正在切换世界，等待稳定后恢复");
    if (
      typeof result.path !== "string" ||
      !path.isAbsolute(result.path) ||
      (await fs.realpath(result.path)).toLowerCase() !==
        (await fs.realpath(r.worldPath)).toLowerCase()
    )
      throw Error("当前游戏不是该房间绑定的存档，请恢复原存档");
    return {
      name: result.name,
      owner: worker.session.userName,
      netherNetId: hostIdentity(result),
    };
  }
  pauseHost(r, message) {
    if (r.phase !== "waiting_host") {
      r.scriptSync?.close();
      r.scriptSync = null;
      r.scriptSyncStatus = {
        phase: "paused",
        message: "等待房主恢复同一存档后继续同步",
      };
      for (const i of r.invites.values())
        if (["joined", "joining"].includes(i.phase)) {
          i.phase = "reconnecting";
          i.scriptSync = { phase: "paused", message: "等待房主恢复" };
        }
    }
    r.phase = "waiting_host";
    r.message = message || "等待重新启动原存档；网络和邀请已保留";
  }
  async recoverHost(r) {
    this.check(r);
    const worker = this.sessions.workers.findLast(
      (w) =>
        w.session?.running && !w.stopping && w.session.worldId === r.worldId,
    );
    const b = this.availableBridge(worker);
    if (!b) {
      this.pauseHost(r);
      return;
    }
    if (r.phase === "hosting" && worker === r.worker && sameBridge(b, r.bridge))
      return;
    this.pauseHost(r, "原存档正在恢复，正在重新验证房间身份");
    try {
      const engine = await this.checkEngine(
        worker.sourceSnapshot.config.game_executable_path,
      );
      if (engine.digest !== r.engine.digest)
        throw Error("恢复的游戏版本发生变化，请使用原房间的游戏版本");
      const game = await this.verifyWorld(r, worker, b);
      this.check(r);
      r.worker = worker;
      r.bridge = b;
      r.game = game;
      r.epoch = crypto.randomUUID();
      for (const i of r.invites.values())
        if (
          ![
            "revoked",
            "expired",
            "failed",
            "revoking",
            "revoke_failed",
            "creating",
            "left",
          ].includes(i.phase)
        ) {
          delete i.proof;
          delete i.attemptId;
          delete i.playerId;
          i.phase = i.resumeKey ? "reconnecting" : "invited";
        }
      r.scriptSync = new ScriptSyncHost(
        worker.sourceSnapshot.config,
        worker.session.runDirectory,
        () => this.hostCheck(r),
      );
      r.error = "";
      r.phase = "hosting";
      r.message = "房主已恢复，朋友将使用原邀请自动重新加入";
    } catch (error) {
      this.check(r);
      r.message = "等待房主恢复：" + error.message;
    }
  }
  pauseGuest(r, message) {
    if (r.phase === "joined") {
      r.scriptSync?.close();
      r.scriptSync = null;
      r.scriptSyncStatus = { phase: "paused", message: "等待重连后继续同步" };
    }
    if (r.phase !== "reconnect_blocked") {
      r.phase = "waiting_host";
      r.message = message || "等待房主恢复，客户端保持打开";
    }
  }
  async recoverGuest(r) {
    this.check(r);
    if (!r.worker?.session?.running || r.worker.stopping) {
      r.phase = "reconnect_blocked";
      r.message = "客户端已经退出，请重新加入";
      r.canRetry = false;
      return;
    }
    if (r.phase === "reconnect_blocked" && !r.canRetry) return;
    if (r.invite.expires <= this.clock())
      throw Object.assign(Error("邀请已过期"), { code: "ROOM_AUTH_REJECTED" });
    const health = await this.request(r.invite, "health");
    this.check(r);
    if (
      health.roomId !== r.invite.roomId ||
      health.reconnect !== RECONNECT ||
      !p.uuid(health.epoch)
    )
      throw Object.assign(Error("房间恢复身份无效"), {
        code: "ROOM_AUTH_REJECTED",
      });
    if (!health.hostReady) {
      this.pauseGuest(r);
      return;
    }
    if (r.phase === "reconnect_blocked") {
      if (health.epoch === r.epoch) return;
      r.phase = "waiting_host";
      r.canRetry = false;
      r.error = "";
    }
    const b = this.availableBridge(r.worker);
    if (
      r.phase === "joined" &&
      health.epoch === r.epoch &&
      sameBridge(b, r.clientBridge)
    ) {
      await r.scriptSync?.tick();
      return;
    }
    this.pauseGuest(r, "房主已恢复，正在自动重新加入");
    const newEpoch = health.epoch !== r.epoch;
    r.epoch = health.epoch;
    r.attemptId = crypto.randomUUID();
    try {
      // A connected client may still be showing the old world while its network
      // times out. Ask only this owned interpreter to leave that world once.
      if (b && (newEpoch || !sameBridge(b, r.clientBridge))) {
        try {
          await this.debug.code(
            b.id,
            b.connectionGeneration,
            "import clientlevel\nclientlevel.disconnect_game('Host is restarting. Reconnecting automatically.')\n_result=True",
            true,
          );
        } catch (error) {
          const current = this.debug
            .snapshot()
            .sessions.find((x) => x.id === b.id);
          if (
            current?.connected &&
            current.state === "game_ready" &&
            current.gameIpcConnected
          )
            throw error;
        }
        const end = this.clock() + 30000;
        while (this.clock() < end) {
          this.check(r);
          const current = this.availableBridge(r.worker, false);
          if (
            current &&
            (current.state !== "game_ready" || !current.gameIpcConnected)
          )
            break;
          await this.wait(250);
        }
      }
      const prepared = await this.request(r.invite, "prepare", {
        engine: r.engine.digest,
        playerName: r.playerName,
        scriptSync: SCRIPT_SYNC,
        reconnect: RECONNECT,
        resumeKey: r.resumeKey,
        attemptId: r.attemptId,
        epoch: r.epoch,
      });
      this.check(r);
      if (prepared.epoch !== r.epoch)
        throw Error("房主再次重载，等待下一次恢复");
      r.proof = prepared.token;
      let menu = { ...this.bridge(r.worker, false) };
      if (menu.state === "game_ready" && menu.gameIpcConnected && !newEpoch) {
        const sent = await this.debug.code(
          menu.id,
          menu.connectionGeneration,
          proofCode(r.proof, "send"),
          true,
        );
        let proof;
        const proofDeadline = this.clock() + 10000;
        do {
          proof = await this.request(r.invite, "proof", {
            playerId: sent.playerId,
            epoch: r.epoch,
            attemptId: r.attemptId,
          });
          this.check(r);
          if (proof.verified) break;
          await this.wait(500);
        } while (this.clock() < proofDeadline);
        if (proof.verified) {
          await this.request(r.invite, "finish", {
            epoch: r.epoch,
            attemptId: r.attemptId,
          });
          this.joined(r);
          return;
        }
        throw Error("当前游戏尚未确认恢复的房间，重连已暂停");
      }
      if (menu.state === "game_ready" && menu.gameIpcConnected)
        throw Error("旧世界尚未退出，重连已暂停");
      const check = () => {
        this.check(r);
        const current = this.bridge(r.worker, false);
        if (
          current.minecraftPid !== menu.minecraftPid ||
          current.id !== menu.id ||
          current.connectionGeneration !== menu.connectionGeneration
        )
          throw Error("来宾进程或连接已变化");
      };
      r.context = await this.transport.resume(
        r.worker.sourceSnapshot.config,
        r.proof,
        r.worker,
        menu,
        r.clientPort,
        check,
      );
      await this.enter(r, prepared.game);
      this.joined(r);
    } catch (error) {
      r.preserveClient = true;
      if (r.context) {
        try {
          await this.transport.close(r.context);
          r.context = null;
        } catch (closeError) {
          error.message += "；通道封闭未确认：" + closeError.message;
        }
      }
      this.check(r);
      r.phase = "reconnect_blocked";
      r.canRetry = true;
      r.message = "自动重连暂未完成，客户端已保留";
      r.error = error.message;
    }
  }
  retry() {
    const r = this.room;
    if (!r || r.role !== "guest" || !r.canRetry)
      throw Error("当前不能重试重连");
    r.canRetry = false;
    r.error = "";
    r.phase = "waiting_host";
    r.message = "正在等待并重试重连";
    return this.snapshot();
  }
  joined(r) {
    this.progress(r, "joined", "已通过房主验证，成功进入游戏");
    r.error = "";
    r.canRetry = false;
    r.preserveClient = false;
    r.clientBridge = { ...this.bridge(r.worker) };
    this.startScriptSync(r);
    r.context = null;
  }
  startScriptSync(r) {
    r.scriptSync?.close();
    if (r.scriptSyncSupported) {
      const epoch = r.epoch;
      const guard = () => {
        this.check(r);
        const b = this.bridge(r.worker);
        if (!sameBridge(b, r.clientBridge) || epoch !== r.epoch)
          throw Error("来宾游戏已切换，停止脚本同步");
        return b;
      };
      r.scriptSync = new ScriptSyncGuest({
        request: (action, data) => {
          guard();
          return this.request(r.invite, action, {
            ...data,
            ...(r.reconnectEnabled ? { epoch } : {}),
          });
        },
        code: (code) => {
          const b = guard();
          return this.debug.code(
            b.id,
            b.connectionGeneration,
            code,
            true,
            guard,
          );
        },
        guard,
        directory: path.join(
          r.worker.session.runDirectory,
          "room-script-sync",
          r.invite.roomId,
          epoch || "initial",
        ),
      });
    } else
      r.scriptSyncStatus = {
        phase: "unsupported",
        message: "房主版本未提供联机脚本热更新",
      };
  }
  async invite() {
    const r = this.room;
    if (!r || r.role !== "host" || r.phase !== "hosting")
      throw Error("请先创建并等待房间就绪");
    this.hostCheck(r);
    if (r.fixed) return { text: fixed.encode(r.fixedIdentity), fixed: true };
    if (r.invites.size >= 16)
      throw Error("本房间最多生成 16 份邀请，请重新创建房间");
    const i = {
      version: 1,
      roomId: r.id,
      inviteId: crypto.randomUUID(),
      network: r.networkName,
      hostIp: r.ip,
      guestIp: r.ip.replace(/\.1$/, "." + (r.invites.size + 2)),
      controlPort: r.controlPort,
      expires: this.clock() + 8 * 3600000,
      endpoint: r.endpoint,
      authKey: p.randomKey(),
      hostPublicKey: r.hostPublicKey,
      phase: "creating",
      seen: new Map(),
    };
    r.invites.set(i.inviteId, i);
    try {
      const c = await r.network.invite(i.inviteId, 8 * 3600);
      this.hostCheck(r);
      if (!p.key(c.credential_secret))
        throw Error("EasyTier 未返回有效邀请凭据");
      i.credential = c.credential_secret;
      i.phase = "invited";
      return { text: p.encodeInvite(i), expires: i.expires };
    } catch (e) {
      i.phase = "failed";
      throw e;
    }
  }
  async revoke(id) {
    const r = this.room;
    if (!r || r.role !== "host") throw Error("没有主持的房间");
    if (r.fixed)
      throw Error("固定邀请码可重复使用；关闭分享后更换邀请码可使旧邀请失效");
    const i = r.invites.get(id);
    if (!i) throw Error("邀请不存在");
    i.phase = "revoking";
    i.authKey = p.randomKey();
    try {
      await r.network.revoke(id);
      i.phase = "revoked";
    } catch (error) {
      i.phase = "revoke_failed";
      throw error;
    }
    return this.snapshot();
  }
  async listen(r) {
    let pending = 0;
    const server = http.createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (
        pending >= 8 ||
        req.method !== "POST" ||
        req.url !== "/room" ||
        req.headers.origin
      ) {
        res.writeHead(403);
        res.end("{}");
        req.resume();
        return;
      }
      pending++;
      let i, msg;
      try {
        const data = await p.body(req);
        i = r.invites.get(data.inviteId);
        if (!i && r.fixed && p.uuid(data.inviteId)) {
          const candidate = {
            roomId: r.id,
            inviteId: data.inviteId,
            authKey: fixed.authKey(r.fixedIdentity.credential, data.inviteId),
            expires: fixed.NEVER,
            fixed: true,
            phase: "invited",
            seen: new Map(),
          };
          // Verify the shared room credential before allocating a member slot.
          const first = p.open(
            data.box,
            candidate.authKey,
            p.aad(candidate, "request"),
          );
          if (!["hello", "health"].includes(first.action))
            throw Error("请先验证固定房间身份");
          for (const [id, member] of r.invites)
            if (
              member.fixed &&
              ["invited", "left"].includes(member.phase) &&
              this.clock() - member.lastSeen > 180000
            )
              r.invites.delete(id);
          if (r.invites.size >= 64) throw Error("房间客户端数量已达上限");
          i = candidate;
          r.invites.set(i.inviteId, i);
        }
        if (
          !i ||
          [
            "revoked",
            "revoking",
            "revoke_failed",
            "failed",
            "expired",
            "creating",
          ].includes(i.phase) ||
          i.expires <= this.clock()
        )
          throw Error("邀请不可用");
        msg = p.open(data.box, i.authKey, p.aad(i, "request"));
        if (
          !p.uuid(msg.requestId) ||
          !Number.isSafeInteger(msg.time) ||
          Math.abs(this.clock() - msg.time) > 120000 ||
          i.seen.has(msg.requestId)
        )
          throw Error("请求已过期或重复");
        for (const [k, t] of i.seen)
          if (this.clock() - t > 120000) i.seen.delete(k);
        if (i.seen.size >= 1024) throw Error("请求过于频繁");
        i.seen.set(msg.requestId, this.clock());
        i.lastSeen = this.clock();
        const statusOnly = ["hello", "health", "leave"].includes(msg.action),
          epoch = r.epoch;
        this.check(r);
        if (!statusOnly) this.hostCheck(r);
        const result = await this.command(r, i, msg.action, msg.data || {});
        this.check(r);
        if (!statusOnly) {
          this.hostCheck(r);
          if (epoch !== r.epoch)
            throw Error("房主已恢复到新的房间代次，旧请求已取消");
        }
        res.end(
          JSON.stringify({
            box: p.seal(
              { ok: true, result, requestId: msg.requestId },
              i.authKey,
              p.aad(i, "response"),
            ),
          }),
        );
      } catch (e) {
        if (i && msg?.requestId) {
          res.end(
            JSON.stringify({
              box: p.seal(
                { ok: false, error: e.message, requestId: msg.requestId },
                i.authKey,
                p.aad(i, "response"),
              ),
            }),
          );
        } else {
          res.writeHead(403);
          res.end("{}");
        }
      } finally {
        pending--;
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 5000;
    server.maxConnections = 16;
    r.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(r.controlPort, r.ip, resolve);
    });
  }
  async command(r, i, action, data) {
    const hostReady = () =>
      r.phase === "hosting" &&
      sameBridge(this.availableBridge(r.worker), r.bridge);
    if (action === "leave" && i.fixed) {
      if (!p.key(data.resumeKey) || data.resumeKey !== i.resumeKey)
        throw Error("离开请求的客户端身份不匹配");
      i.phase = "left";
      delete i.playerName;
      delete i.playerId;
      delete i.proof;
      delete i.attemptId;
      return true;
    }
    if (action === "health")
      return {
        roomId: r.id,
        ...(r.reconnectEnabled
          ? {
              reconnect: RECONNECT,
              epoch: r.epoch,
              hostReady: hostReady(),
            }
          : {}),
      };
    if (action === "hello")
      return {
        roomId: r.id,
        game: r.game,
        engine: r.engine.digest,
        packTransfer: "native-v1",
        scriptSync: SCRIPT_SYNC,
        ...(r.reconnectEnabled
          ? {
              reconnect: RECONNECT,
              epoch: r.epoch,
              hostReady: hostReady(),
            }
          : {}),
      };
    if (action === "prepare") {
      const name = menuPlayerName(data.playerName);
      if (data.engine !== r.engine.digest)
        throw Error("游戏版本不一致，请使用与房主相同的开发版游戏");
      if (i.preparing) throw Error("上一次入房准备尚未完成，请稍后重试");
      const resumable = r.reconnectEnabled && data.reconnect === RECONNECT;
      if (resumable) {
        if (
          !p.key(data.resumeKey) ||
          !p.uuid(data.attemptId) ||
          data.epoch !== r.epoch
        )
          throw Error("重连身份或房间代次无效");
        if (
          i.resumeKey &&
          !crypto.timingSafeEqual(
            Buffer.from(i.resumeKey, "base64"),
            Buffer.from(data.resumeKey, "base64"),
          )
        )
          throw Error("该邀请已绑定其他客户端");
        if (i.resumeKey && !i.fixed && i.playerName !== data.playerName)
          throw Error("重连玩家名称不能改变");
        if (i.attemptId === data.attemptId && i.epoch === r.epoch && i.proof)
          return { token: i.proof, game: r.game, epoch: r.epoch };
      } else if (i.proof || i.resumeKey)
        throw Error("本邀请已发起入房，请重新生成邀请");
      if (
        [...r.invites.values()].some(
          (x) =>
            x !== i &&
            x.playerName === name &&
            !["revoked", "expired", "left"].includes(x.phase),
        ) ||
        name === r.game.owner
      )
        throw Error("房间内已有同名玩家");
      i.preparing = true;
      try {
        if (resumable) {
          if (i.proof && i.epoch === r.epoch)
            await this.hostCode(r, proofCode(i.proof, "cleanup"));
          i.resumeKey = data.resumeKey;
          i.attemptId = data.attemptId;
          i.epoch = r.epoch;
          i.reconnectEnabled = true;
        }
        i.proof = crypto.randomBytes(16).toString("hex");
        i.playerName = name;
        i.scriptSyncSupported = data.scriptSync === SCRIPT_SYNC;
        i.phase = "joining";
        await this.hostCode(r, proofCode(i.proof, "prepare"));
        return {
          token: i.proof,
          game: r.game,
          ...(resumable ? { epoch: r.epoch } : {}),
        };
      } finally {
        delete i.preparing;
      }
    }
    if (action === "proof") {
      if (
        i.reconnectEnabled &&
        (data.epoch !== r.epoch ||
          i.epoch !== r.epoch ||
          data.attemptId !== i.attemptId)
      )
        throw Error("旧代次的玩家回执已失效");
      if (
        !i.proof ||
        typeof data.playerId !== "string" ||
        !/^-?\d{1,25}$/.test(data.playerId)
      )
        throw Error("玩家回执无效");
      const proof = await this.hostCode(r, proofCode(i.proof, "read"));
      const ok = proof.players.includes(data.playerId);
      if (ok) {
        i.playerId = data.playerId;
        i.phase = "joined";
        if (!i.scriptSyncSupported)
          i.scriptSync = {
            phase: "unsupported",
            message: "来宾版本未启用联机脚本热更新",
          };
      }
      return { verified: ok };
    }
    if (action === "finish") {
      if (
        i.reconnectEnabled &&
        (data.epoch !== r.epoch || data.attemptId !== i.attemptId)
      )
        throw Error("旧代次的入房请求已失效");
      if (i.proof) await this.hostCode(r, proofCode(i.proof, "cleanup"));
      return true;
    }
    if (action.startsWith("scripts.")) {
      if (i.reconnectEnabled && (data.epoch !== r.epoch || i.epoch !== r.epoch))
        throw Error("脚本同步所属房间代次已失效");
      if (
        i.phase !== "joined" ||
        !i.playerId ||
        !i.scriptSyncSupported ||
        !r.scriptSync
      )
        throw Error("只有已验证入房的新客户端才能同步脚本");
      if (action === "scripts.list") return r.scriptSync.list(data);
      if (action === "scripts.chunk") return r.scriptSync.chunk(data);
      if (action === "scripts.ack") {
        if (
          !["synced", "error"].includes(data.phase) ||
          typeof data.message !== "string" ||
          data.message.length > 1024 ||
          (data.revision !== undefined && !/^[a-f0-9]{64}$/.test(data.revision))
        )
          throw Error("脚本同步回执无效");
        if (
          data.phase === "synced" &&
          (!Number.isInteger(data.updated) ||
            !Number.isInteger(data.files) ||
            data.updated < 0 ||
            data.files < data.updated ||
            data.files > 256)
        )
          throw Error("脚本更新数量无效");
        i.scriptSync = {
          phase: data.phase,
          revision: data.revision,
          message: data.message,
          files: data.files,
          updated: data.updated,
          receivedAt: this.clock(),
        };
        return true;
      }
    }
    throw Error("不支持的房间请求");
  }
  join(args) {
    const invite = p.parseInvite(args.invitation),
      playerName = menuPlayerName(args.playerName);
    const localJoin = this.localHostAddress(invite.hostIp);
    if (!localJoin && p.subnetConflict(invite.guestIp))
      throw Error("邀请的虚拟网段与本机网络冲突，请房主重建房间");
    const r = this.reserve("guest");
    Object.assign(r, {
      invite,
      localJoin,
      ip: localJoin ? invite.hostIp : invite.guestIp,
      endpoint: invite.endpoint,
      playerName,
    });
    return this.run(r, async () => {
      if (invite.fixed) {
        const client = await this.preferences.client();
        invite.inviteId = client.id;
        invite.authKey = fixed.authKey(invite.credential, client.id);
        r.fixed = true;
        r.savedResumeKey = fixed.authKey(client.resumeKey, invite.roomId);
      }
      // Join uses only the global executable and an ephemeral menu client.
      // Never read a local profile or infer the host's filesystem paths.
      const gamePath = this.sessions.store.value.settings.GamePath;
      if (!gamePath)
        throw Error(
          "请先在“设置 → 全局游戏程序”选择开发版 Minecraft.Windows.exe，再粘贴邀请加入",
        );
      if (typeof gamePath !== "string" || !path.isAbsolute(gamePath))
        throw Error("全局游戏程序路径无效，请在设置中重新选择");
      const config = {
        ...profileDefaults(),
        game_executable_path: gamePath,
        user_name: playerName,
        included_mod_dirs: [],
        auto_hot_reload_mods: false,
        auto_hot_reload_ui: false,
        auto_hot_reload_shaders: false,
        auto_hot_reload_materials: false,
        auto_hot_reload_particles: false,
      };
      let engine;
      try {
        engine = await this.checkEngine(config.game_executable_path);
      } catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
          throw Error("全局游戏程序不存在或无法读取，请在设置中重新选择");
        throw error;
      }
      this.check(r);
      if (localJoin) {
        // Sharing a subnet alone never grants access. A local host must answer
        // the same invitation-authenticated hello/prepare/proof protocol before
        // any game process starts. No second TUN or borrowed network cleanup.
        this.progress(r, "connecting", "正在验证本机房主的邀请");
      } else {
        this.progress(
          r,
          "network_starting",
          "正在连接樱花入口，请处理 Windows 授权提示",
        );
        const networkState = await r.network.start({
          role: "guest",
          instance: crypto.randomUUID(),
          ip: r.ip,
          network: invite.network,
          secret: invite.credential,
          privateKey: invite.credential,
          endpoint: invite.endpoint,
          hostPublicKey: invite.hostPublicKey,
          controlPort: invite.controlPort,
          gamePath: config.game_executable_path,
          ...(invite.fixed ? { dynamicIp: true } : {}),
        });
        if (invite.fixed) r.ip = networkState.node.ipv4_addr.split("/")[0];
        this.check(r);
        r.networkReady = true;
        this.progress(r, "connecting", "网络已启动，正在等待房主认证");
      }
      let hello;
      const deadline = this.clock() + 45000;
      while (this.clock() < deadline) {
        this.check(r);
        try {
          hello = await this.request(invite, "hello");
          if (hello.reconnect === RECONNECT && hello.hostReady === false) {
            this.progress(r, "waiting_host", "正在等待房主恢复原存档");
            hello = null;
            r.connectError = "房主尚未恢复原存档";
            await this.wait(1000);
            continue;
          }
          break;
        } catch (e) {
          r.connectError = e.message;
          await this.wait(1000);
        }
      }
      if (!hello) throw Error(r.connectError || "无法联系房主");
      if (hello.roomId !== invite.roomId) throw Error("房间身份与邀请不一致");
      if (localJoin) {
        r.networkReady = true;
        r.networkStats = { transport: "本机共享房主网络", latencyMs: null };
      }
      r.name = hello.game.name;
      if (hello.engine !== engine.digest)
        throw Error("游戏版本不一致，请使用与房主相同的开发版游戏");
      if (hello.packTransfer !== "native-v1")
        throw Error("房主工具箱尚不支持原生模组下载，请更新后重新创建房间");
      r.scriptSyncSupported = hello.scriptSync === SCRIPT_SYNC;
      r.reconnectEnabled = hello.reconnect === RECONNECT;
      r.engine = engine;
      if (r.reconnectEnabled) {
        if (!p.uuid(hello.epoch) || !hello.hostReady)
          throw Error("房主正在恢复，请等待原存档就绪后加入");
        r.epoch = hello.epoch;
        r.resumeKey = r.savedResumeKey || p.randomKey();
        r.attemptId = crypto.randomUUID();
      }
      const prepared = await this.request(invite, "prepare", {
        engine: engine.digest,
        playerName,
        scriptSync: SCRIPT_SYNC,
        ...(r.reconnectEnabled
          ? {
              reconnect: RECONNECT,
              epoch: r.epoch,
              resumeKey: r.resumeKey,
              attemptId: r.attemptId,
            }
          : {}),
      });
      r.proof = prepared.token;
      const context = await this.transport.create(config, r.proof, () =>
        this.check(r),
      );
      r.context = context;
      r.clientPort = context.port;
      const state = await this.sessions.start(
        null,
        null,
        { userName: playerName },
        {
          debug: true,
          roomGuest: true,
          playerName,
          runtimeConfig: config,
          prepareClient: async (worker, bridge) => {
            r.worker = worker;
            await this.transport.prepare(context, worker, bridge);
          },
        },
      );
      r.worker = this.sessions.workers.find(
        (w) => w.session?.id === state.selectedSession,
      );
      this.check(r);
      await this.enter(r, prepared.game);
      this.joined(r);
      this.monitor(r);
    });
  }
  async enter(r, game) {
    const context = r.context,
      end = this.clock() + 120000;
    const check = () => {
      this.check(r);
      const b = this.bridge(r.worker, false);
      if (
        b.minecraftPid !== context.pid ||
        b.id !== context.registration ||
        b.connectionGeneration !== context.generation
      )
        throw Error("客户端连接已变化");
      return b;
    };
    let sent = null,
      dispatched = false;
    await this.transport.open(
      context,
      check,
      (phase, msg) => this.progress(r, phase, msg),
      end,
      (message) => {
        this.progress(
          r,
          message ? "waiting_assertion" : "joining",
          message || "继续等待游戏入房",
        );
      },
    );
    while (this.clock() < end) {
      await this.transport.inspect(context);
      const b = check();
      if (
        b.state === "game_ready" &&
        b.gameIpcConnected &&
        b.debugCapabilityEnabled
      ) {
        if (!dispatched) throw Error("客户端进入了未验证的世界");
        if (!sent) {
          this.progress(r, "verifying", "已进入游戏，正在等待房主确认");
          sent = await this.debug.code(
            b.id,
            b.connectionGeneration,
            proofCode(r.proof, "send"),
            true,
            check,
          );
        }
        const proof = await this.request(r.invite, "proof", {
          playerId: sent.playerId,
          ...(r.reconnectEnabled
            ? { epoch: r.epoch, attemptId: r.attemptId }
            : {}),
        });
        if (proof.verified) {
          await this.request(
            r.invite,
            "finish",
            r.reconnectEnabled
              ? { epoch: r.epoch, attemptId: r.attemptId }
              : {},
          );
          await this.transport.close(context);
          return;
        }
      } else if (!dispatched) {
        const row = await this.transport.discover(context, game);
        check();
        if (row) {
          await this.transport.dispatch(context, row);
          dispatched = true;
          this.progress(
            r,
            "joining",
            "已找到目标房间；如游戏询问资源包，请选择下载并加入",
          );
        }
      } else await this.transport.status(context);
      await this.wait(1000);
    }
    throw Error("游戏入房超时；网络连通不代表 NetherNet 已完成连接");
  }
  async cleanup(r) {
    if (r.cleanupPromise) return r.cleanupPromise;
    r.cleanupPromise = (async () => {
      clearInterval(r.timer);
      r.scriptSync?.close();
      const errors = [];
      let transportError;
      if (r.context)
        try {
          await this.transport.close(r.context);
          r.context = null;
        } catch (e) {
          r.preserveClient = false;
          transportError = e;
        }
      if (r.role === "guest" && !r.preserveClient && r.worker?.session?.running)
        try {
          await this.sessions.stop(r.worker.session.id);
        } catch (e) {
          errors.push("客户端停止失败：" + e.message);
        }
      // A terminated client no longer needs a native seal. Retry transport
      // cleanup after stopping it instead of retaining an obsolete seal error.
      if (transportError && !r.worker?.session?.running)
        try {
          await this.transport.close(r.context);
          r.context = null;
          transportError = null;
        } catch (e) {
          transportError = e;
        }
      if (transportError)
        errors.push("菜单清理失败：" + transportError.message);
      if (
        r.fixed &&
        r.role === "guest" &&
        !r.worker?.session?.running &&
        r.networkReady &&
        !r.leaveSent
      ) {
        r.leaveSent = true;
        // Local cleanup must still complete if the host is already offline.
        await this.request(
          r.invite,
          "leave",
          { resumeKey: r.resumeKey },
          2000,
        ).catch(() => {});
      }
      if (r.server) {
        r.server.closeAllConnections();
        await new Promise((resolve) => r.server.close(resolve));
        r.server = null;
      }
      if (!r.networkCleaned)
        try {
          await r.network.stop();
          r.networkCleaned = true;
        } catch (e) {
          errors.push("网络清理失败：" + e.message);
        }
      r.networkReady = false;
      r.cleanupErrors = errors;
      r.cleanupFailed = errors.length > 0;
      if (r.cleanupFailed) {
        r.phase = "needs_attention";
        r.message = "联机清理未完成；处理上述问题后可再次点击离开重试";
      }
    })().finally(() => {
      r.cleanupPromise = null;
    });
    return r.cleanupPromise;
  }
  async close() {
    const r = this.room;
    if (!r) return this.snapshot();
    if (r.closePromise) return r.closePromise;
    r.closePromise = this.closeRoom(r).finally(() => {
      r.closePromise = null;
    });
    return r.closePromise;
  }
  async closeRoom(r) {
    r.cancelled = true;
    r.network.cancel?.();
    clearInterval(r.timer);
    await this.job;
    // Preserving assertion dialogs only applies to an automatic failed join.
    // Explicit leave authorizes stopping this room's own guest client.
    r.preserveClient = false;
    await this.cleanup(r);
    if (r.cleanupFailed) throw Error(r.cleanupErrors.join("；"));
    if (this.room === r) this.room = null;
    return this.snapshot();
  }
  async shutdown() {
    this.closing = true;
    await this.close();
  }
}
module.exports = { Rooms };
