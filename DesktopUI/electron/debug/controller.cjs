const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { HostBridgeServer } = require("./vendor/server.cjs");
const ui = require("./vendor/uiDebugger.cjs");
const { buildMutation } = require("./ui-mutation.cjs");
const liveUi = require("./ui-live.cjs");
const { ScriptReloader } = require("./script-reload.cjs");
const { EmbeddedReloader } = require("./embedded-reload.cjs");
const cpu = require("./vendor/pythonProfiler.cjs");
const memory = require("./vendor/pythonMemoryProfiler.cjs");
const {
  NativeProfilerCapture,
  shutdownAllNativeProfilerCaptures,
} = require("./vendor/nativeProfilerCapture.cjs");
const {
  discoverTracyListeners,
} = require("./vendor/nativeProfilerPortDiscovery.cjs");
const { dynamicLibraryManager } = require("./vendor/dynamicLibraryManager.cjs");
const {
  DebugFunctions,
  buildDebugFunctionInvocation,
} = require("./functions.cjs");

class DebugController extends EventEmitter {
  constructor(store, runtimeRoot, options = {}) {
    super();
    this.store = store;
    this.runtimeRoot = runtimeRoot;
    this.server =
      options.server ||
      new HostBridgeServer({
        name: "DaGuoNeko Game Toolkit",
        version: "0.1.0",
        instanceId: crypto.randomUUID(),
      });
    this.nativeStart =
      options.nativeStart ||
      ((settings) => NativeProfilerCapture.start(settings));
    this.discoverPorts = options.discoverPorts || discoverTracyListeners;
    this.functions = new DebugFunctions(store);
    this.registrations = new Map();
    this.launchRoots = new Map();
    this.scriptReloader = options.scriptReloader || new ScriptReloader();
    this.embeddedReloaders = new Map();
    this.queues = new Map();
    this.profiles = new Map();
    this.resources = new Map();
    this.pickers = new Map();
    this.pickerOwners = new Map();
    this.pickerQueues = new Map();
    this.prefix = "_dgn_" + crypto.randomBytes(6).toString("hex");
    this.reportDirectory = path.join(path.dirname(store.file), "debug-reports");
    this.subscription = this.server.onDidChange(() => {
      this.reconcile();
      for (const reloader of this.embeddedReloaders.values()) reloader.resume();
      this.changed();
    });
    this.disposed = false;
    this.revision = 0;
  }
  changed() {
    this.revision++;
    this.emit("state", this.snapshot());
  }
  snapshot() {
    return {
      ...this.server.getSnapshot(),
      sessions: this.server.getSnapshot().sessions.map((s) => ({
        ...s,
        projectId: this.registrations.get(s.registrationId),
        profileName: this.store.value.projects.find(
          (p) => p.id === this.registrations.get(s.registrationId),
        )?.name,
      })),
      revision: this.revision,
      profiles: [...this.profiles.values()].map((record) => ({ ...record })),
      pickers: [...this.pickers.keys()],
      pickerOwners: Object.fromEntries(this.pickerOwners),
    };
  }
  async prepareLaunch(id, root) {
    if (this.disposed) throw Error("调试服务已关闭");
    await this.server.start(0);
    const registration = this.server.registerLaunch(
      root || this.store.project(id).root,
    );
    this.registrations.set(registration.registrationId, id);
    this.launchRoots.set(
      registration.registrationId,
      root || this.store.project(id).root,
    );
    if (root) {
      try {
        const config = require("../services.cjs").parseConfig(
          await fs.readFile(path.join(root, ".mcdev.json"), "utf8"),
        );
        const directories = config.auto_hot_reload_mods
          ? config.included_mod_dirs
              .filter(
                (entry) =>
                  entry.enabled !== false && entry.toolbox_hot_reload === true,
              )
              .map((entry) => path.resolve(root, entry.path))
          : [];
        if (directories.length)
          this.embeddedReloaders.set(
            registration.registrationId,
            new EmbeddedReloader(directories, {
              target: () => {
                const s = this.server
                  .getSnapshot()
                  .sessions.find(
                    (s) => s.registrationId === registration.registrationId,
                  );
                return s?.connected &&
                  s.state === "game_ready" &&
                  s.gameIpcConnected &&
                  s.debugCapabilityEnabled
                  ? { sessionId: s.id, generation: s.connectionGeneration }
                  : null;
              },
              reload: (target) =>
                this.reload({
                  ...target,
                  action: "scripts",
                  embeddedOnly: true,
                }),
              report: (result) =>
                this.emit("embedded-reload", {
                  registrationId: registration.registrationId,
                  ...result,
                }),
            }),
          );
      } catch (error) {
        this.releaseLaunch(registration.registrationId);
        throw error;
      }
    }
    return registration;
  }
  releaseLaunch(id) {
    this.embeddedReloaders.get(id)?.close();
    this.embeddedReloaders.delete(id);
    this.server.releaseRegistration(id);
    this.registrations.delete(id);
    this.launchRoots.delete(id);
    this.scriptReloader.forget(id);
  }
  session(id, generation, ready = true) {
    const session = this.server
      .getSnapshot()
      .sessions.find((item) => item.id === id);
    if (!session?.connected || !this.registrations.has(session.registrationId))
      throw Error("游戏会话已断开，请通过工具箱重新启动");
    if (
      !Number.isInteger(generation) ||
      generation !== session.connectionGeneration
    )
      throw Error("游戏会话已更新，请刷新后重试");
    if (ready && (session.state !== "game_ready" || !session.gameIpcConnected))
      throw Error("请先进入游戏世界，等待调试连接就绪");
    if (ready && !session.debugCapabilityEnabled)
      throw Error(
        "开发辅助模组尚未加载，请使用新版工具箱重新启动该存档或配置客户端",
      );
    return session;
  }
  code(id, generation, code, isClient, guard) {
    if (
      typeof code !== "string" ||
      !code.trim() ||
      Buffer.byteLength(code) > 1024 * 1024 ||
      typeof isClient !== "boolean"
    )
      return Promise.reject(Error("代码为空、超过 1 MB 或执行端无效"));
    const previous = this.queues.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        this.session(id, generation);
        guard?.();
        const result = await this.server.request(
          id,
          "game/code/execute",
          { code, isClient },
          15000,
        );
        this.session(id, generation);
        guard?.();
        return result;
      });
    this.queues.set(id, operation);
    operation
      .finally(() => {
        if (this.queues.get(id) === operation) this.queues.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  script(source) {
    return source
      .replaceAll("_mcdev_pp", this.prefix + "_pp")
      .replaceAll("_mcdev_pm", this.prefix + "_pm")
      .replaceAll("_mcdev_ui", this.prefix + "_ui")
      .replaceAll("_MCDevUi", this.prefix + "_Ui");
  }
  assertReloadIdle(sessionId, includeQueue = false) {
    if (
      [...this.profiles.values()].some(
        (p) =>
          p.sessionId === sessionId &&
          ["starting", "running", "collecting"].includes(p.status),
      )
    )
      throw Error("请先结束本会话的性能采样，再进行热更新或重载");
    if (this.pickers.has(sessionId))
      throw Error("请先关闭 UI 控件拾取，再进行热更新或重载");
    if (
      includeQueue &&
      (this.queues.has(sessionId) || this.pickerQueues.has(sessionId))
    )
      throw Error("本会话还有调试操作未完成，请稍后重启");
  }
  reload({ sessionId, generation, action, confirmed, embeddedOnly = false }) {
    if (!["scripts", "world", "addons"].includes(action))
      return Promise.reject(Error("无效的重载动作"));
    if (action !== "scripts" && confirmed !== true)
      return Promise.reject(Error("请先确认重载当前世界"));
    const previous = this.queues.get(sessionId) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const session = this.session(sessionId, generation);
        await this.beforeReload?.({ sessionId, generation });
        this.session(sessionId, generation);
        if (
          [...this.profiles.values()].some(
            (p) =>
              p.sessionId === sessionId &&
              ["starting", "running", "collecting"].includes(p.status),
          )
        )
          throw Error("请先结束本会话的性能采样，再进行热更新或重载");
        if (this.pickers.has(sessionId))
          throw Error("请先关闭 UI 控件拾取，再进行热更新或重载");
        if (action === "scripts") {
          return this.scriptReloader.reload(
            session,
            this.launchRoots.get(session.registrationId),
            async (code) => {
              this.session(sessionId, generation);
              const result = await this.server.request(
                sessionId,
                "game/code/execute",
                { code, isClient: true },
                15000,
              );
              this.session(sessionId, generation);
              return result;
            },
            embeddedOnly,
          );
        }
        if (
          session.methods &&
          !session.methods.some((m) => m.name === "game/reload")
        )
          throw Error("当前启动器未提供重载世界接口");
        // A world reload can disconnect IPC after acceptance. Do not replay it or
        // require the old connection generation to survive the reload itself.
        const result = await this.server.request(
          sessionId,
          "game/reload",
          { addons: action === "addons" },
          15000,
        );
        if (result?.accepted !== true) throw Error("游戏未确认接收重载请求");
        return result;
      });
    this.queues.set(sessionId, operation);
    operation
      .finally(() => {
        if (this.queues.get(sessionId) === operation)
          this.queues.delete(sessionId);
      })
      .catch(() => {});
    return operation;
  }
  profileScript(source, record) {
    const suffix = record.id.replaceAll("-", "");
    return this.script(source)
      .replaceAll(this.prefix + "_pp", this.prefix + "_pp_" + suffix)
      .replaceAll(this.prefix + "_pm", this.prefix + "_pm_" + suffix);
  }
  async refresh() {
    await this.server.refreshSessions();
    return this.snapshot();
  }
  uiCommand(args) {
    if (!["picker-start", "picker-stop"].includes(args.action))
      return this.performUiCommand(args);
    const previous = this.pickerQueues.get(args.sessionId) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => this.performUiCommand(args));
    this.pickerQueues.set(args.sessionId, operation);
    operation
      .finally(() => {
        if (this.pickerQueues.get(args.sessionId) === operation)
          this.pickerQueues.delete(args.sessionId);
      })
      .catch(() => {});
    return operation;
  }
  async performUiCommand(args) {
    const { sessionId, generation, action } = args;
    this.session(sessionId, generation);
    if (
      args.screen !== undefined &&
      (typeof args.screen !== "string" ||
        args.screen.length > 512 ||
        args.screen.includes("\0"))
    )
      throw Error("无效屏幕名称");
    if (
      args.path !== undefined &&
      (typeof args.path !== "string" ||
        args.path.length > 4096 ||
        args.path.includes("\0"))
    )
      throw Error("无效控件路径");
    const run = (source) =>
      this.code(sessionId, generation, this.script(source), true);
    if (action === "screens")
      return ui.parseUiDebuggerScreens(
        await run(ui.buildUiDebuggerScreensCode()),
      );
    if (action === "children") {
      const offset =
        Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
      return liveUi.parseChildren(
        await run(liveUi.visibleChildren(args.screen, args.path || "", offset)),
        args.path || "",
        offset,
      );
    }
    if (action === "select") {
      const highlight =
        args.highlight === true &&
        this.pickers.get(sessionId) === generation &&
        (!args.owner || this.pickerOwners.get(sessionId) === args.owner);
      const result = await run(
        liveUi.selectionCode(
          args.screen,
          args.path,
          args.reveal !== false,
          highlight,
        ),
      );
      if (!Array.isArray(result) || result.length !== 2)
        throw Error("游戏返回的选择信息无效");
      return {
        details: ui.parseUiDebuggerNode(result[0], args.screen, args.path),
        pages: liveUi.parseReveal(result[1]),
      };
    }
    if (action === "toggle-visible")
      return run(liveUi.toggleVisibilityCode(args.screen, args.path));
    if (action === "node")
      return ui.parseUiDebuggerNode(
        await run(ui.buildUiDebuggerNodeCode(args.screen, args.path)),
        args.screen,
        args.path,
      );
    if (action === "mutate") {
      if (!Object.hasOwn(args, "expected"))
        throw Error("请先读取当前属性，再应用修改");
      return run(buildMutation(args));
    }
    if (action === "set")
      return run(
        ui.buildUiDebuggerPropertyCode(
          args.screen,
          args.path,
          args.property,
          args.value,
        ),
      );
    if (action === "visible") {
      if (typeof args.value !== "boolean") throw Error("可见性必须是开关值");
      return run(
        ui.buildUiDebuggerVisibilityCode(args.screen, args.path, args.value),
      );
    }
    if (action === "reveal")
      return ui.parseUiDebuggerReveal(
        await run(ui.buildUiDebuggerRevealCode(args.screen, args.path)),
      );
    if (action === "highlight") {
      if (
        !this.pickers.has(sessionId) ||
        (args.owner && this.pickerOwners.get(sessionId) !== args.owner)
      )
        throw Error("请先启用双向选中");
      return run(liveUi.highlightCode(args.screen, args.path));
    }
    if (action === "picker-start") {
      if (
        this.pickers.has(sessionId) &&
        args.owner &&
        this.pickerOwners.get(sessionId) !== args.owner
      )
        await run(ui.buildUiDebuggerPickerDisableCode());
      const result = await run(liveUi.pickerEnableCode(args.bounds === true));
      this.pickers.set(sessionId, generation);
      this.pickerOwners.set(sessionId, args.owner || "legacy");
      this.changed();
      if (result !== true) {
        try {
          await run(ui.buildUiDebuggerPickerDisableCode());
          this.pickers.delete(sessionId);
          this.pickerOwners.delete(sessionId);
          this.changed();
        } catch (error) {
          throw Error("游戏未能启用拾取器，清理也未完成：" + error.message);
        }
        throw Error("游戏未能启用拾取器，请检查当前屏幕与游戏版本");
      }
      return result;
    }
    if (action === "picker-stop") {
      if (
        this.pickers.get(sessionId) === generation &&
        (!args.owner || this.pickerOwners.get(sessionId) === args.owner)
      ) {
        await run(ui.buildUiDebuggerPickerDisableCode());
        this.pickers.delete(sessionId);
        this.pickerOwners.delete(sessionId);
        this.changed();
      }
      return true;
    }
    if (action === "picker-poll")
      return this.pickers.get(sessionId) === generation &&
        (!args.owner || this.pickerOwners.get(sessionId) === args.owner)
        ? run(liveUi.pickerPollCode())
        : null;
    throw Error("不支持的 UI 调试操作");
  }
  async invoke(args) {
    const session = this.session(args.sessionId, args.generation);
    const projectId = this.registrations.get(session.registrationId);
    if (args.projectId !== projectId) throw Error("函数项目与游戏会话不匹配");
    const entries = await this.functions.list(projectId),
      saved = entries.find((item) => item.id === args.id);
    if (!saved) throw Error("请先收藏要运行的调试函数");
    return this.code(
      args.sessionId,
      args.generation,
      buildDebugFunctionInvocation(saved, args.arguments || {}),
      saved.target === "client",
    );
  }
  async startProfile(args) {
    const session = this.session(args.sessionId, args.generation);
    if (!["python", "memory", "native"].includes(args.kind))
      throw Error("无效采样类型");
    if (
      !Number.isFinite(args.duration) ||
      args.duration < 1 ||
      args.duration > 300
    )
      throw Error("采样时长为 1–300 秒");
    if (
      [...this.profiles.values()].some(
        (p) =>
          p.sessionId === session.id &&
          ["starting", "running", "collecting"].includes(p.status),
      )
    )
      throw Error("请先结束本会话当前的采样");
    const record = {
      id: crypto.randomUUID(),
      kind: args.kind,
      sessionId: session.id,
      generation: args.generation,
      projectId: this.registrations.get(session.registrationId),
      status: "starting",
      duration: args.duration,
      startedAt: new Date().toISOString(),
      target: args.target || "client",
      clock: args.clock || "WALL",
    };
    if (
      !["client", "server", "all"].includes(record.target) ||
      !["CPU", "WALL"].includes(record.clock)
    )
      throw Error("无效采样目标或计时方式");
    if (args.kind === "memory") record.target = "client";
    const resource = {};
    this.profiles.set(record.id, record);
    this.resources.set(record.id, resource);
    this.changed();
    const run = (source, client = record.target !== "server") =>
      this.code(
        session.id,
        args.generation,
        this.profileScript(source, record),
        client,
      );
    try {
      if (args.kind === "python") {
        cpu.parsePythonProfilerStart(
          await run(
            cpu.buildPythonProfilerStartCode({
              target: record.target,
              clock: record.clock,
              durationSeconds: args.duration,
            }),
          ),
        );
        if (record.target === "all")
          for (const side of ["client", "server"])
            await run(cpu.buildPythonProfilerMarkCode(side), side === "client");
      } else if (args.kind === "memory") {
        const lease = [
          "import threading",
          "if _result.get('ok'):",
          " def _mcdev_pm_expire():",
          "  if globals().get('_mcdev_pm_owned',False):",
          "   if tracemalloc.is_tracing(): tracemalloc.stop()",
          "   globals()['_mcdev_pm_owned']=False;globals()['_mcdev_pm_base']=None",
          ` _mcdev_pm_timer=threading.Timer(${args.duration + 15},_mcdev_pm_expire)`,
          " _mcdev_pm_timer.daemon=True;_mcdev_pm_timer.start()",
        ].join("\n");
        memory.parsePythonMemoryStart(
          await run(
            memory.buildPythonMemoryStartCode({
              tracebackDepth: args.depth || 8,
            }) +
              "\n" +
              lease,
          ),
        );
      } else {
        const ports = (await this.discoverPorts()).filter(
          (entry) => entry.pid === session.minecraftPid,
        );
        const port = args.port
          ? ports.find((entry) => entry.port === args.port)?.port
          : ports[0]?.port;
        if (!port)
          throw Error(
            "该游戏进程没有 Tracy 监听端口（8086–8105），请检查游戏版本",
          );
        record.port = port;
        await this.nativeViewerGuard?.(session, port);
        const capture = await this.nativeStart({
          extensionRoot: this.runtimeRoot,
          port,
          maximumSeconds: args.duration,
          memoryLimitPercent: 25,
        });
        resource.capture = capture;
        resource.completion = capture.completion
          .then(async (value) => {
            if (record.status === "cancelled" || record.status === "failed")
              return;
            record.result = value.result;
            await fs.mkdir(this.reportDirectory, { recursive: true });
            record.traceFile = path.join(
              this.reportDirectory,
              record.id + ".tracy",
            );
            await fs.copyFile(value.tracePath, record.traceFile);
            await this.complete(record);
          })
          .catch((error) => this.failed(record, error))
          .finally(async () => {
            await capture.dispose();
            this.resources.delete(record.id);
          })
          .catch((error) => this.failed(record, error));
      }
      this.session(session.id, args.generation);
      if (resource.cancelled || record.status === "failed")
        throw Error("采样已取消或会话已断开");
      record.status = "running";
      this.changed();
      if (args.kind !== "native")
        resource.timer = setTimeout(
          () => this.collect(record.id).catch(() => {}),
          args.duration * 1000 + 250,
        );
      return this.snapshot();
    } catch (error) {
      clearTimeout(resource.timer);
      await this.cleanup(record, resource).catch(() => {});
      if (resource.completion) await resource.completion;
      this.resources.delete(record.id);
      this.failed(record, error);
      throw error;
    }
  }
  async collect(id, collectGarbage = false) {
    const record = this.profiles.get(id),
      resource = this.resources.get(id);
    if (!record || !resource) throw Error("没有正在进行的采样");
    if (resource.collecting) return resource.collecting;
    resource.collecting = (async () => {
      clearTimeout(resource.timer);
      record.status = "collecting";
      this.changed();
      try {
        if (record.kind === "native") {
          await resource.capture.stop();
          await resource.completion;
          return;
        }
        const source =
          record.kind === "python"
            ? cpu.buildPythonProfilerCollectCode(record.target)
            : "_mcdev_pm_timer=globals().get('_mcdev_pm_timer')\nif _mcdev_pm_timer: _mcdev_pm_timer.cancel()\n" +
              memory.buildPythonMemoryCollectCode(collectGarbage);
        const value = await this.code(
          record.sessionId,
          record.generation,
          this.profileScript(source, record),
          record.target !== "server",
        );
        record.result =
          record.kind === "python"
            ? cpu.parsePythonProfilerResult(value, record.target)
            : memory.parsePythonMemoryResult(value);
        await this.complete(record);
        this.resources.delete(id);
      } catch (error) {
        await this.cleanup(record).catch(() => {});
        this.resources.delete(id);
        this.failed(record, error);
        throw error;
      }
    })();
    return resource.collecting;
  }
  async complete(record) {
    if (["cancelled", "failed"].includes(record.status)) return;
    record.status = "complete";
    record.endedAt = new Date().toISOString();
    await fs.mkdir(this.reportDirectory, { recursive: true });
    await fs.writeFile(
      path.join(this.reportDirectory, record.id + ".json"),
      JSON.stringify(record, null, 2),
      "utf8",
    );
    // Keep a bounded in-memory report list; files remain available in the report directory.
    const completed = [...this.profiles.values()].filter((p) =>
      ["complete", "failed", "cancelled"].includes(p.status),
    );
    for (const old of completed.slice(0, Math.max(0, completed.length - 12)))
      this.profiles.delete(old.id);
    this.changed();
  }
  failed(record, error) {
    if (record.status === "cancelled") return;
    record.status = "failed";
    record.error = error.message;
    this.changed();
  }
  async cleanup(record, resource = this.resources.get(record.id)) {
    if (record.kind === "native") {
      await resource?.capture?.stop();
      return;
    }
    const source =
      record.kind === "python"
        ? cpu.buildPythonProfilerCleanupCode()
        : "_mcdev_pm_timer=globals().get('_mcdev_pm_timer')\nif _mcdev_pm_timer: _mcdev_pm_timer.cancel()\n" +
          memory.buildPythonMemoryCleanupCode();
    await this.code(
      record.sessionId,
      record.generation,
      this.profileScript(source, record),
      record.target !== "server",
    );
  }
  async cancel(id) {
    const record = this.profiles.get(id),
      resource = this.resources.get(id);
    if (!record || !resource) return this.snapshot();
    clearTimeout(resource.timer);
    resource.cancelled = true;
    record.status = "cancelled";
    this.changed();
    try {
      await this.cleanup(record);
      if (resource.completion) await resource.completion;
    } finally {
      this.resources.delete(id);
    }
    return this.snapshot();
  }
  reconcile() {
    for (const [id, resource] of this.resources) {
      const record = this.profiles.get(id);
      try {
        this.session(record.sessionId, record.generation);
      } catch (error) {
        clearTimeout(resource.timer);
        this.failed(record, error);
        if (resource.capture) resource.capture.stop().catch(() => {});
        // A disconnected interpreter cannot be cleaned remotely. Never target a new generation.
        if (record.status !== "starting" && !resource.capture)
          this.resources.delete(id);
      }
    }
    for (const [id, generation] of this.pickers) {
      try {
        this.session(id, generation);
      } catch {
        this.pickers.delete(id);
        this.pickerOwners.delete(id);
      }
    }
  }
  async stopForLaunch(registrationId) {
    const session = this.server
      .getSnapshot()
      .sessions.find((item) => item.registrationId === registrationId);
    if (!session) return;
    await this.pickerQueues.get(session.id)?.catch(() => {});
    const pending = [...this.profiles.values()]
      .filter((p) => p.sessionId === session.id && this.resources.has(p.id))
      .map((p) => this.cancel(p.id));
    if (this.pickers.has(session.id))
      pending.push(
        this.uiCommand({
          sessionId: session.id,
          generation: session.connectionGeneration,
          action: "picker-stop",
        }),
      );
    const failures = (await Promise.allSettled(pending)).filter(
      (r) => r.status === "rejected",
    );
    if (failures.length)
      throw Error(
        "调试清理未完成：" + failures.map((r) => r.reason.message).join("；"),
      );
  }
  async stopForOwner(owner) {
    // An enable already queued by this window must finish before ownership is inspected.
    await Promise.allSettled([...this.pickerQueues.values()]);
    const ids = [...this.pickers.keys()].filter(
      (id) => this.pickerOwners.get(id) === owner,
    );
    for (const id of ids)
      await this.uiCommand({
        sessionId: id,
        generation: this.pickers.get(id),
        action: "picker-stop",
        owner,
      });
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const reloader of this.embeddedReloaders.values()) reloader.close();
    this.embeddedReloaders.clear();
    await Promise.allSettled(
      [...this.registrations.keys()].map((id) => this.stopForLaunch(id)),
    );
    await this.functions.queue.catch(() => {});
    await this.server.dispose();
    this.subscription.dispose();
    await shutdownAllNativeProfilerCaptures(this.runtimeRoot);
    await dynamicLibraryManager.unloadAll();
  }
}
module.exports = { DebugController };
