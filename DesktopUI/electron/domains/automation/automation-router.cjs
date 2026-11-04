const crypto = require("node:crypto");
const { profilesForDiscovery } = require("../client/engine-profiles.cjs");
const { inspectWindow, readinessCode, gameplayUIs } = require("./automation-observation.cjs");
const { settingsSchema, select, projectView } = require("./automation-config.cjs");
const { captureScene } = require("./automation-scene.cjs");
const { AssertionTracker } = require("./assertion-tracker.cjs");
const { AUTO_IMPORT_PROFILE } = require("../../../shared/world-import-model.cjs");
const {
  validate,
  result,
  localMultiplayer,
} = require("./automation-tools.cjs");
const { withMcdk } = require("./mcp-endpoint.cjs");
const { dimensionProbeCode, buildHeightProbeCode } = require("../worlds/terrain-runtime.cjs");
const { sharedSources } = require("../../../shared/source-sharing.cjs");
const { isolatedGameVersions } = require("../../host-isolation-support.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assertionPhase(text) {
  if (/png|resource|texture|ImageHash|Empty resource/i.test(text || "")) return "resources";
  if (/UI|UITypes|layout|modifier/i.test(text || "")) return "ui";
  if (/sky|PSO|RenderMaterial|material/i.test(text || "")) return "render";
  return "unknown";
}
function blockingFile(text) {
  const m = /([A-Za-z]:[\\/][^\r\n ]+\.(?:png|json|jsonc|material|tga|jpg|jpeg))/i.exec(text || "");
  return m ? m[1].slice(0, 4096) : null;
}
class AutomationRouter {
  constructor({
    sessions,
    debug,
    worlds,
    store,
    joiner,
    profiles,
    gameOptions,
    runtime,
    onSettingsChanged,
    onDataChanged,
    inspectWindow: windowProbe = inspectWindow,
    captureWindow,
    architecture,
    proxy = withMcdk,
    onError = () => {},
  }) {
    Object.assign(this, {
      sessions,
      debug,
      worlds,
      store,
      joiner,
      profiles,
      gameOptions,
      runtime,
      onSettingsChanged,
      onDataChanged,
      inspectWindow: windowProbe,
      captureWindow,
      architecture,
      proxy,
      onError,
    });
    this.instanceId = crypto.randomUUID();
    this.launches = new Map();
    this.busy = new Set();
    this.captures = new Map();
    this.assertions = new AssertionTracker();
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
  guard(worker, generation, sequence, gamePid) {
    const b = this.bridge(worker, generation);
    if ((sequence !== undefined && b.stateSequence !== sequence) || (gamePid !== undefined && b.minecraftPid !== gamePid))
      throw Error("WORLD_CHANGED：世界已切换或重载");
    return b;
  }
  async window(worker, bridge, assertionId) {
    const value = await this.inspectWindow(this.runtime, worker, bridge, assertionId);
    this.guard(worker, bridge.connectionGeneration, bridge.stateSequence, bridge.minecraftPid);
    return value;
  }
  noteAssertions(sessionId, bridge, snapshot) {
    return this.assertions.observe(sessionId, bridge, snapshot).map(assertion => ({
      ...assertion, assetLoadPhase: assertionPhase(assertion.text), blockingFile: blockingFile(assertion.text),
    }));
  }
  async readiness(args) {
    const worker = this.worker(args.sessionId), s = worker.session;
    const match = this.debug.snapshot().sessions.find(
      x => x.connected && x.registrationId === s.bridgeRegistrationId && x.mcdkPid === s.pid,
    );
    const b = match ? {...match} : null;
    if (args.generation !== undefined && b?.connectionGeneration !== args.generation)
      throw Error("游戏会话已更新，请刷新 generation");
    const state = {
      sessionId: s.id, generation: b?.connectionGeneration ?? null,
      gamePid: b?.minecraftPid || s.minecraftPid || null,
      running: !!s.running && !worker.stopping,
      state: b?.state || (s.running ? "connecting" : "ended"),
      stateSequence: b?.stateSequence ?? null,
      bridgeConnected: !!b, gameIpcConnected: b?.gameIpcConnected === true,
      debugCapabilityEnabled: b?.debugCapabilityEnabled === true,
      worldLoaded: null, playerLoaded: null, rendering: "unknown",
      window: null, assertions: [], blockers: [], ready: false,
      assetLoadPhase: "unknown", safeToCaptureScene: false,
      observedAt: new Date().toISOString(),
    };
    if (!state.running || !b) {
      state.blockers.push(state.running ? "BRIDGE_UNAVAILABLE" : "CLIENT_ENDED");
      return state;
    }
    try {
      const native = await this.window(worker, b);
      state.window = native.window;
      state.processCreatedAt = native.processCreatedAt;
      state.assertions = this.noteAssertions(s.id, b, native);
      if (state.assertions.length) {
        state.interactionState = "blocked_by_assertion";
        state.blockers.push("ASSERTION_PENDING");
        state.assetLoadPhase = state.assertions[0].assetLoadPhase;
        state.lastBlockingAssertionId = state.assertions.at(-1).id;
        if (state.assertions.some(a => a.repeated)) {
          state.blockers.push("REPEATED_ASSERTION");
          state.needsAttention = true;
        }
      } else state.assetLoadPhase = "unknown";
      if (!native.window) state.blockers.push("WINDOW_NOT_FOUND");
    } catch (error) {
      state.windowError = error.message;
      state.blockers.push("WINDOW_OBSERVATION_FAILED");
    }
    // 模态断言会堵住游戏线程；先查窗口，再决定是否发 Python 请求。
    if (!state.blockers.length && b.state === "game_ready" && b.gameIpcConnected && b.debugCapabilityEnabled) {
      try {
        const identity = await this.debug.code(b.id, b.connectionGeneration, readinessCode, true,
          () => this.guard(worker, b.connectionGeneration, b.stateSequence, b.minecraftPid));
        this.guard(worker, b.connectionGeneration, b.stateSequence, b.minecraftPid);
        state.worldLoaded = typeof identity?.world === "string" && identity.world.length > 0;
        state.playerLoaded = typeof identity?.playerId === "string" &&
          !["", "-1", "0"].includes(identity.playerId) &&
          Array.isArray(identity.position) && identity.position.length === 3 &&
          identity.position.every(Number.isFinite);
        state.world = identity?.world ?? null;
        state.playerId = identity?.playerId ?? null;
        state.position = identity?.position ?? null;
        state.topUI = identity?.topUI ?? null;
        if (!state.worldLoaded) state.blockers.push("WORLD_UNAVAILABLE");
        if (!state.playerLoaded) state.blockers.push("PLAYER_UNAVAILABLE");
        if (!gameplayUIs.includes(state.topUI))
          state.blockers.push("GAMEPLAY_UI_UNCONFIRMED");
      } catch (error) {
        state.identityError = error.message;
        state.blockers.push("GAME_PROBE_FAILED");
      }
    } else if (!state.blockers.length) state.blockers.push("DEBUG_NOT_READY");
    state.ready = state.blockers.length === 0 && state.worldLoaded === true && state.playerLoaded === true;
    state.safeToCaptureScene = state.ready && state.needsAttention !== true &&
      state.window?.visible === true && state.window.minimized === false;
    state.observedAt = new Date().toISOString();
    return state;
  }
  async runtimeDimensionProbe(args, buildHeight = false) {
    const worker = this.worker(args.sessionId);
    const ready = await this.readiness(args);
    if (!ready.playerId) throw Error("PLAYER_UNAVAILABLE：请先进入目标存档");
    const b = this.bridge(worker, args.generation, true);
    const code = buildHeight
      ? buildHeightProbeCode(ready.playerId, args.dimension, args.candidateY)
      : dimensionProbeCode(ready.playerId, args.dimension ?? null, args.candidateY || []);
    return result(await this.debug.code(b.id, b.connectionGeneration, code, false, () => this.guard(worker, b.connectionGeneration, b.stateSequence, b.minecraftPid)));
  }
  async capture(args) {
    const worker = this.worker(args.sessionId);
    const b = { ...this.bridge(worker, args.generation) }, before = await this.window(worker, b);
    if (before.assertions.length) throw Error("ASSERTION_PENDING：请先读取断言");
    if (!this.captureWindow) throw Error("CAPTURE_BACKEND_UNAVAILABLE");
    const startedAt = new Date().toISOString();
    const frame = await this.captureWindow(before, worker, b);
    this.guard(worker, args.generation, b.stateSequence, b.minecraftPid);
    const after = await this.window(worker, b);
    const target = snapshot => {
      const { foreground, occluded, ...window } = snapshot.window || {};
      return JSON.stringify({pid:snapshot.pid,processCreatedAt:snapshot.processCreatedAt,window,assertions:snapshot.assertions});
    };
    if (target(after) !== target(before))
      throw Error("CAPTURE_TARGET_CHANGED：窗口、进程或断言状态已变化");
    if (!Buffer.isBuffer(frame.data) || frame.data.length > 16 * 1024 * 1024 ||
        frame.width !== before.window.width || frame.height !== before.window.height)
      throw Error("CAPTURE_INVALID_OR_RESIZED");
    const key = args.sessionId + ":" + args.generation + ":" + before.processCreatedAt;
    const captureId = crypto.createHash("sha256").update(frame.data).digest("hex");
    const previous = this.captures.get(key);
    this.captures.set(key, captureId);
    if (this.captures.size > 128) this.captures.delete(this.captures.keys().next().value);
    const sameAsPrevious = previous === undefined ? null : previous === captureId;
    if (args.requireChanged && sameAsPrevious !== false)
      throw Error("FRAME_CHANGE_UNCONFIRMED：没有基准帧或画面完全相同，不能区分静止画面和旧帧");
    return {
      content: [
        { type: "image", mimeType: "image/png", data: frame.data.toString("base64") },
        { type: "text", text: JSON.stringify({
          sessionId: args.sessionId, generation: args.generation, stateSequence: b.stateSequence,
          gamePid: b.minecraftPid, processCreatedAt: before.processCreatedAt,
          startedAt, capturedAt: new Date().toISOString(), captureId,
          width: frame.width, height: frame.height, originalResolution: frame.originalResolution !== false,
          window: after.window, backend: frame.backend,
          sameAsPrevious, frameTimestamp: frame.frameTimestamp, frameTimestampClock: frame.frameTimestampClock || null, freshness: "unknown",
        }) },
      ],
    };
  }
  async call(name, args = {}) {
    let mutating = false;
    try {
      validate(name, args);
      mutating = args.sessionId && !["list_clients", "client_logs", "client_readiness", "wait_client_ready", "list_client_assertions", "list_client_mcdk_tools"].includes(name);
      if (mutating && this.busy.has(args.sessionId)) throw Error("CLIENT_BUSY：此会话已有自动化操作未完成");
      if (mutating) this.busy.add(args.sessionId);
      const response = await this.dispatch(name, args);
      if (["create_project", "update_project", "import_world", "clone_world", "update_game_options"].includes(name))
        this.onDataChanged?.({method:name,projectId:args.projectId||null});
      return response;
    } catch (error) {
      error.activityLogged = true;
      this.onError({ method: "mcp." + name, message: error.message || String(error) });
      throw error;
    }
    finally { if (mutating) this.busy.delete(args.sessionId); }
  }
  async dispatch(name, args) {
    switch (name) {
      case "toolbox_status":
        return result({
          online: true,
          instanceId: this.instanceId,
          clients: this.clients(),
          launchRequests: this.launches.size,
          localMultiplayer,
          capabilities: {
            automationControlVersion: 2,
            assertionPolicy: "explicit_single_ignore",
            readiness: "layered_observation",
            capture: {backend:"windows_graphics_capture",originalResolution:true,frameTimestamp:true},
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
            terrainAutomation: {
              dimensionRuntimeProbe: true,
              buildHeightProbe: "isolated_only",
              architectureImport: !!this.architecture,
              externalDataRoot: !!this.architecture,
            },
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
      case "list_projects":
        return result({
          projects: this.store.value.projects.map((p) => ({
            id: p.id,
            name: p.name,
            root: p.root,
            baseDirectory: p.baseDirectory || p.root,
            profile: p.profile !== false,
          })),
        });
      case "read_project":
        if (!this.profiles) throw Error("当前工具箱未提供启动配置服务");
        return result(projectView(await this.profiles.read(args.projectId)));
      case "update_project":
        if (!this.profiles) throw Error("当前工具箱未提供启动配置服务");
        if (this.sessions.starting) throw Error("正在准备启动，请稍后保存配置");
        return result(
          projectView(await this.profiles.save(
            args.projectId,
            args.revision,
            args.patch,
          )),
        );
      case "read_settings": {
        await this.store.queue;
        return result({ settings: select(this.store.value.settings, settingsSchema), revision:await this.store.settingsRevision() });
      }
      case "update_settings": {
        const next = await this.store.updateSettings(args.patch, args.revision);
        if (this.onSettingsChanged) await this.onSettingsChanged(next, args.patch);
        return result({ settings: select(next.settings, settingsSchema), revision:await this.store.settingsRevision() });
      }
      case "read_game_options":
        if (!this.gameOptions) throw Error("当前工具箱未提供游戏设置服务");
        return result(await this.gameOptions.snapshot());
      case "update_game_options":
        if (!this.gameOptions) throw Error("当前工具箱未提供游戏设置服务");
        return result(
          await this.gameOptions.save(args.revision, args.overrides),
        );
      case "import_world":
      case "clone_world":
        return this.once(name, args, async () => {
          const world = await this.worlds.importWorld(
            args.profileId || AUTO_IMPORT_PROFILE,
            args.name,
            args.source,
            args.mode || "copy",
            name === "clone_world" ? args.worldId : undefined,
          );
          return result({
            world,
            instanceId: this.instanceId,
            requestId: args.requestId,
          });
        });
      case "create_project":
        return this.once(name,args,async()=>result(projectView(await this.profiles.create(args.name,args.copyId))));
      case "inspect_world_source":
        return result(await this.worlds.inspectSource(args.source));
      case "validate_world_assets":
        return result(await this.worlds.validateAssets(args.worldId));
      case "inspect_world_packs":
        return result(await this.worlds.inspectPackHealth(args.worldId));
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
          let state, assetPreflight;
          if (name === "launch_world") {
            if (args.assetPreflight === "report" && args.confirmed !== true)
              throw Error("请确认仅记录资源预检后尝试启动，存档/进程保护仍然有效");
            if (this.worlds.validateAssets) {
              const assets = await this.worlds.validateAssets(args.worldId);
              assetPreflight = {ok:assets.ok,digest:assets.digest,errorCount:assets.errors.length,errors:assets.errors.slice(0,20),mode:args.assetPreflight||"strict"};
              if (!assets.ok && args.assetPreflight !== "report")
                throw Error("WORLD_ASSET_PREFLIGHT_FAILED：" + JSON.stringify(assets));
            }
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
            ...(assetPreflight ? {assetPreflight} : {}),
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
        this.assertions.forget(args.sessionId);
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
      case "client_readiness":
        return result(await this.readiness(args));
      case "wait_client_ready": {
        const end = Date.now() + (args.timeoutMs ?? 30000);
        let last, generation = args.generation;
        do {
          last = await this.readiness({ ...args, generation });
          generation ??= last.generation ?? undefined;
          if (last.ready) return result({ ...last, timedOut: false });
          if (!last.running || last.assertions.length || last.needsAttention) return result({ ...last, timedOut: false });
          if (Date.now() >= end) break;
          await sleep(Math.min(args.pollMs ?? 1000, Math.max(1, end - Date.now())));
        } while (Date.now() < end);
        return result({ ...last, timedOut: true });
      }
      case "list_client_assertions": {
        const worker = this.worker(args.sessionId), b = this.bridge(worker, args.generation);
        const native = await this.window(worker, b);
        const assertions = this.noteAssertions(args.sessionId, b, native);
        return result({
          sessionId: args.sessionId, generation: b.connectionGeneration,
          processCreatedAt: native.processCreatedAt, assertions,
          observedAt: new Date().toISOString(),
        });
      }
      case "resolve_client_assertion": {
        const worker = this.worker(args.sessionId), b = { ...this.bridge(worker, args.generation) };
        const before = await this.window(worker, b);
        const current = this.noteAssertions(args.sessionId, b, before).find(a => a.id === args.assertionId);
        if (!current || !current.canIgnore)
          throw Error("ASSERT_CHANGED_OR_IGNORE_UNSUPPORTED");
        const nativeId = this.assertions.reserve(args.sessionId, args.assertionId);
        const sent = await this.window(worker, b, nativeId);
        if (!sent.ignoreDispatched) throw Error("ASSERT_IGNORE_RESULT_UNKNOWN");
        const after = await this.window(worker, b);
        const assertions = this.noteAssertions(args.sessionId, b, after);
        return result({
          sessionId: args.sessionId, generation: args.generation, assertionId: args.assertionId,
          dispatched: true, resolved: !after.assertions.some(a => a.id === nativeId),
          method: "dialog_command", assertions, worldReady: null,
          interactionState: assertions.length ? "blocked_by_assertion" : "recheck_readiness",
        });
      }
      case "capture_client_window":
        return this.capture(args);
      case "capture_scene":
        return this.once(name, args, () => captureScene(this, args));
      case "probe_dimension_runtime":
        return this.once(name, args, () => this.runtimeDimensionProbe(args, false));
      case "probe_build_height": {
        const worker = this.worker(args.sessionId);
        if (worker.session.storageMode !== "isolated") throw Error("HEIGHT_PROBE_REQUIRES_ISOLATED_SESSION");
        return this.once(name, args, () => this.runtimeDimensionProbe(args, true));
      }
      case "terrain_prepare":
        return this.once(name, args, async () => result(await this.architecture.call("prepare", args)));
      case "terrain_capture_source":
        return this.once(name, args, async () => result(await this.architecture.call("sourceSave", args)));
      case "terrain_preview":
        return this.once(name, args, async () => result(await this.architecture.call("preview", args)));
      case "terrain_apply":
        return this.once(name, args, async () => result(await this.architecture.call("targetPaste", args)));
      case "terrain_rollback":
        return this.once(name, args, async () => result(await this.architecture.call("revoke", args)));
      case "terrain_status": {
        let state = await this.architecture.state();
        if (!state && args.externalDataRoot) {
          await this.architecture.openExternal(args.taskId, args.externalDataRoot);
          state = await this.architecture.state();
        }
        if (!state || state.id !== args.taskId) throw Error("地形任务不存在或已变化");
        return result(state);
      }
      default:
        throw Error("此操作由 stdio 桥接器处理");
    }
  }
}
module.exports = { AutomationRouter };
