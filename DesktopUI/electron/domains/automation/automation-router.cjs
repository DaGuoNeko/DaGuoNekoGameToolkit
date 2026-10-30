const crypto = require("node:crypto");
const { profilesForDiscovery } = require("../client/engine-profiles.cjs");
const {
  validate,
  result,
  localMultiplayer,
} = require("./automation-tools.cjs");
const { withMcdk } = require("./mcp-endpoint.cjs");
const { sharedSources } = require("../../../shared/source-sharing.cjs");
const { isolatedGameVersions } = require("../../host-isolation-support.cjs");
class AutomationRouter {
  constructor({ sessions, debug, worlds, store, joiner, proxy = withMcdk }) {
    Object.assign(this, { sessions, debug, worlds, store, joiner, proxy });
    this.instanceId = crypto.randomUUID();
    this.launches = new Map();
    this.startQueue = Promise.resolve();
  }
  worker(id) {
    const worker = this.sessions.workers.find((w) => w.session?.id === id);
    if (!worker) throw Error("客户端不存在，请重新 list_clients");
    return worker;
  }
  bridge(worker, generation, ready = false) {
    if (!worker.session.running || worker.stopping)
      throw Error("客户端已结束或正在停止");
    const match = this.debug
      .snapshot()
      .sessions.find(
        (s) =>
          s.connected &&
          s.registrationId === worker.session.bridgeRegistrationId &&
          s.mcdkPid === worker.session.pid,
      );
    if (!match) throw Error("此客户端尚未连接 Host Bridge");
    return this.debug.session(match.id, generation, ready);
  }
  clients() {
    const bridges = this.debug.snapshot().sessions;
    return this.sessions.workers
      .filter((w) => w.session)
      .map((w) => {
        const s = w.session,
          b = bridges.find(
            (b) =>
              b.connected &&
              b.registrationId === s.bridgeRegistrationId &&
              b.mcdkPid === s.pid,
          );
        return {
          sessionId: s.id,
          profileName: s.profileName,
          playerName: s.userName,
          role: s.role,
          worldId: s.worldId,
          worldName: s.worldName,
          storageMode: s.storageMode || "shared",
          isolationReason: s.isolationReason || null,
          engineVersion: s.engineVersion || null,
          engineDigest: s.engineDigest || null,
          engineProfile: s.engineProfile || null,
          sourceRoots: s.sourceRoots || [],
          sharedSources: sharedSources(
            s.sourceRoots,
            this.sessions.workers.map((w) => w.session).filter(Boolean),
            s.id,
          ),
          running: s.running,
          launcherPid: s.pid,
          gamePid: b?.minecraftPid || s.minecraftPid || null,
          playerNameStatus: s.playerNameStatus,
          autoJoin: s.autoJoin || null,
          state: b?.state || (s.running ? "connecting" : "ended"),
          generation: b?.connectionGeneration ?? null,
          capabilities: {
            logs: true,
            stop: !!s.running,
            code: !!(
              s.running &&
              b?.state === "game_ready" &&
              b.gameIpcConnected &&
              b.debugCapabilityEnabled
            ),
            mcdkConfigured:
              !!w.sourceSnapshot?.config.mcp_server_config?.enabled,
          },
          mcdkPort: w.sourceSnapshot?.config.mcp_server_config?.enabled
            ? w.sourceSnapshot.config.mcp_server_config.server_port || 19133
            : null,
        };
      });
  }
  async once(name, args, fn) {
    if (args.instanceId !== this.instanceId)
      throw Error(
        "工具箱已重启或 instanceId 错误，请先检查 list_clients 和 toolbox_status，不能直接重试启动",
      );
    const hash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          name,
          Object.keys(args)
            .sort()
            .map((k) => [k, args[k]]),
        ]),
      )
      .digest("hex");
    const old = this.launches.get(args.requestId);
    if (old) {
      if (old.hash !== hash) throw Error("requestId 已用于另一组启动参数");
      return old.promise;
    }
    // Never evict launch IDs: refusing after the cap is safer than replaying an old launch.
    if (this.launches.size >= 1000)
      throw Error("本次运行的 AI 启动请求已达 1000 条上限，请先检查现有客户端");
    const promise = this.startQueue.then(fn);
    this.startQueue = promise.catch(() => {});
    this.launches.set(args.requestId, { hash, promise });
    return promise;
  }
  async call(name, args = {}) {
    validate(name, args);
    switch (name) {
      case "toolbox_status":
        return result({
          online: true,
          instanceId: this.instanceId,
          clients: this.clients(),
          launchRequests: this.launches.size,
          localMultiplayer,
          capabilities: {
            autoJoin: !!this.joiner,
            isolatedWorldHosts:
              !!this.sessions.isolation &&
              this.store.value.settings.IndependentWorlds !== false,
            isolatedHostGameVersions: this.sessions.isolation
              ? [...isolatedGameVersions]
              : [],
            gameVersions: profilesForDiscovery(),
            autoJoinTransport: this.joiner ? "oreui" : null,
            autoJoinAssertionPolicy: this.joiner ? "pause_preserve" : null,
          },
        });
      case "list_clients":
        return result({ clients: this.clients() });
      case "list_launch_profiles":
        return result({
          profiles: this.store.value.projects.map((p) => ({
            id: p.id,
            name: p.name,
          })),
        });
      case "list_worlds": {
        const value = await this.worlds.list();
        return result({
          worlds: value.worlds.map((w) => ({
            id: w.id,
            name: w.name,
            profileId: w.profileId,
            deletedAt: w.deletedAt,
            deleted: !!w.deleted,
            copying: !!w.copying,
            ready: !!w.ready,
            error: w.error || null,
          })),
        });
      }
      case "launch_joined_client":
        return this.once(name, args, async () => {
          if (!this.joiner) throw Error("此工具箱实例未提供自动联机服务");
          const id = await this.joiner.launch(
            args.hostSessionId,
            args.playerName,
          );
          return result({
            client: this.clients().find((c) => c.sessionId === id),
            instanceId: this.instanceId,
            requestId: args.requestId,
          });
        });
      case "launch_client":
      case "launch_world":
        return this.once(name, args, async () => {
          let state;
          if (name === "launch_world") {
            const world = (await this.worlds.list()).worlds.find(
              (w) => w.id === args.worldId,
            );
            if (!world?.profileId) throw Error("存档不存在或未绑定启动配置");
            state = await this.sessions.start(world.profileId, world.id, null, {
              debug: true,
            });
          } else {
            if (args.mode === "profile" && !args.profileId)
              throw Error("profile 模式需要 profileId");
            if (args.mode !== "profile" && args.profileId)
              throw Error("仅 profile 模式可传 profileId");
            state = await this.sessions.start(
              args.mode === "profile" ? args.profileId : null,
              null,
              args.mode === "profile" ? null : { userName: args.playerName },
              { debug: args.mode !== "blank", playerName: args.playerName },
            );
          }
          return result({
            client: this.clients().find(
              (c) => c.sessionId === state.selectedSession,
            ),
            instanceId: this.instanceId,
            requestId: args.requestId,
          });
        });
      case "client_logs": {
        const all = this.worker(args.sessionId).logs;
        return result({
          sessionId: args.sessionId,
          oldestId: all[0]?.id,
          latestId: all.at(-1)?.id,
          truncated:
            args.afterId !== undefined &&
            all.length > 0 &&
            args.afterId < all[0].id - 1,
          logs: all
            .filter((l) => args.afterId === undefined || l.id > args.afterId)
            .slice(-(args.limit || 200)),
        });
      }
      case "close_client":
        this.joiner?.cancel(args.sessionId);
        await this.sessions.stop(args.sessionId);
        return result({
          client: this.clients().find((c) => c.sessionId === args.sessionId),
        });
      case "remove_client":
        await this.sessions.remove(args.sessionId);
        return result({ removed: args.sessionId });
      case "execute_client_code": {
        const b = this.bridge(
          this.worker(args.sessionId),
          args.generation,
          true,
        );
        return result(
          await this.debug.code(
            b.id,
            args.generation,
            args.code,
            args.side === "client",
          ),
        );
      }
      case "reload_client": {
        const b = this.bridge(
          this.worker(args.sessionId),
          args.generation,
          true,
        );
        return result(
          await this.debug.reload({
            sessionId: b.id,
            generation: args.generation,
            action: args.action,
            confirmed: args.confirmed,
          }),
        );
      }
      case "list_client_mcdk_tools":
      case "call_client_mcdk_tool": {
        const worker = this.worker(args.sessionId);
        const check = () => this.bridge(worker, args.generation);
        check();
        if (
          name === "call_client_mcdk_tool" &&
          /reload|restart/i.test(args.name)
        )
          throw Error("重载请使用 reload_client，以保留采样、拾取与确认保护");
        const value = await this.proxy(
          worker,
          check,
          name === "call_client_mcdk_tool" ? args : null,
        );
        return name === "call_client_mcdk_tool" ? value : result(value);
      }
      default:
        throw Error("此操作由 stdio 桥接器处理");
    }
  }
}
module.exports = { AutomationRouter };
