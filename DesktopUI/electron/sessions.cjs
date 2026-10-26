const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Launcher, validateConfig, atomicWrite } = require("./services.cjs");
const { SessionHistory } = require("./domains/game/history.cjs");
const { resolvePaths, profileDefaults } = require("./domains/profiles/profiles.cjs");
const { discoverGames } = require("./domains/game/discovery.cjs");
const { folderFor } = require("./domains/worlds/world-path.cjs");
const { reloadDefaults } = require("./domains/reload/reload-options.cjs");
const { menuPlayerName } = require("./domains/client/menu-name.cjs");
const { allocateMcp } = require("./domains/automation/mcp-endpoint.cjs");
const { normalizeActions } = require("./domains/worlds/world-actions.cjs");
const { applyWindowSize } = require("./window-size.cjs");
const { quickTestMods } = require("./domains/reload/quick-test.cjs");
const { sourceSelection } = require("./domains/reload/reload-sources.cjs");
class Sessions extends EventEmitter {
  constructor(
    store,
    runtime,
    {
      bridge,
      worlds,
      profiles,
      modLibrary,
      gameOptions,
      isolation,
      menuName,
      detectPids,
      discover = discoverGames,
      launcherOptions = {},
    } = {},
  ) {
    super();
    Object.assign(this, {
      store,
      runtime,
      bridge,
      worlds,
      profiles,
      modLibrary,
      gameOptions,
      isolation,
      menuName,
      detectPids,
      discover,
      launcherOptions,
    });
    this.workers = [];
    this.selected = "";
    this.starting = false;
    this.epoch = 0;
    this.revision = 0;
    const history = new SessionHistory(
      path.join(path.dirname(store.file), "logs"),
      () => {},
    );
    this.archive = history;
    this.historyQueue = Promise.resolve();
    this.history = {
      directory: history.directory,
      list: async (channel) =>
        (await this.historyArchive(channel).list()).map((entry) => ({
          ...entry,
          canDelete: !this.historyActive(entry.id),
        })),
      read: (id, channel) => this.historyWriter(id, channel).read(id),
      query: (id, channel, options) =>
        this.historyWriter(id, channel).query(id, options),
      entry: async (id, channel, entryId) => {
        if (!Number.isSafeInteger(entryId) || entryId < 1)
          throw Error("无效日志行号");
        return (
          await this.historyWriter(id, channel).query(
            id,
            { before: entryId + 1 },
            1,
          )
        ).logs.find((entry) => entry.id === entryId);
      },
      export: (id, target, channel) =>
        this.historyWriter(id, channel).export(id, target),
    };
  }
  historyArchive(channel = "script") {
    if (channel === "script") return this.archive;
    if (channel === "game" && this.gameLogs) return this.gameLogs.archive;
    throw Error("无效日志类型");
  }
  historyWriter(id, channel = "script") {
    const archive = this.historyArchive(channel);
    return (
      (channel === "game"
        ? this.gameLogs.records.get(id)?.history
        : this.workers.find((w) => w.session?.id === id)?.history) || archive
    );
  }
  historyActive(id) {
    return (
      this.starting ||
      this.workers.some(
        (w) =>
          w.session?.id === id &&
          (w.session.running || w.starting || w.stopping),
      )
    );
  }
  async previewHistoryDeletion(id, channel) {
    const archive = this.historyArchive(channel);
    if (this.starting) throw Error("正在启动游戏，请稍后清理历史日志");
    const candidates =
      id === undefined ? await archive.deletionCandidates() : [id];
    const ids = [];
    let bytes = 0,
      skipped = 0;
    for (const target of candidates) {
      if (this.historyActive(target)) {
        skipped++;
        continue;
      }
      const files = await archive.deletionFiles(target);
      if (!files.length) continue;
      ids.push(target);
      bytes += files.reduce((sum, f) => sum + f.bytes, 0);
    }
    return { ids, bytes, skipped };
  }
  deleteHistory(ids, confirmed, channel = "script") {
    const operation = this.historyQueue.then(async () => {
      const archive = this.historyArchive(channel);
      if (confirmed !== true) throw Error("请确认永久删除历史日志");
      if (!Array.isArray(ids) || !ids.length || ids.length > 50000)
        throw Error("请选择有效的历史日志");
      const targets = [...new Set(ids)];
      for (const id of targets) archive.file(id);
      const deleted = [],
        skipped = [],
        errors = [];
      for (const id of targets) {
        if (this.historyActive(id)) {
          skipped.push(id);
          continue;
        }
        const worker = this.workers.find((w) => w.session?.id === id);
        try {
          if (channel === "game") await this.gameLogs.finish(id);
          else await worker?.history.finish();
          if (this.historyActive(id)) {
            skipped.push(id);
            continue;
          }
          await archive.remove(id);
          deleted.push(id);
          if (channel === "game") {
            this.gameLogs.clear(id);
            if (worker) worker.session.gameHistoryDeleted = true;
          } else if (worker) {
            worker.session.historyDeleted = true;
            if (this.current === worker) this.epoch++;
            worker.clearLogs();
          }
        } catch (error) {
          errors.push({ id, message: error.message });
        }
      }
      this.publish();
      return { deleted, skipped, errors };
    });
    this.historyQueue = operation.catch(() => {});
    return operation;
  }
  get current() {
    return (
      this.workers.find((w) => w.session?.id === this.selected) ||
      this.workers.at(-1)
    );
  }
  get session() {
    return this.current?.session || null;
  }
  get logs() {
    return this.current?.logs || [];
  }
  get stopping() {
    return this.workers.some((w) => w.stopping);
  }
  get hasRunning() {
    return this.workers.some((w) => w.session?.running);
  }
  get historyError() {
    return this.current?.historyError || "";
  }
  state() {
    const value = this.current?.state() || { session: null, logs: [] };
    return {
      ...value,
      sessions: this.workers
        .filter((w) => w.session)
        .map((w) => ({ ...w.session, child: undefined })),
      selectedSession: this.session?.id || "",
      epoch: this.epoch,
      revision: this.revision,
      starting: this.starting,
      stopping: !!this.current?.stopping,
    };
  }
  publish() {
    this.revision++;
    this.emit("state", this.state());
  }
  select(id) {
    if (!this.workers.some((w) => w.session?.id === id))
      throw Error("游戏会话不存在");
    this.selected = id;
    this.epoch++;
    this.publish();
    return this.state();
  }
  profileRunning(id) {
    return this.workers.some(
      (w) => w.session?.running && w.session.projectId === id,
    );
  }
  gameIsRunning(file) {
    return Launcher.prototype.gameIsRunning.call(this, file);
  }
  log(stream, text) {
    this.current?.log(stream, text);
  }
  clearLogs() {
    this.current?.clearLogs();
    this.epoch++;
    this.publish();
    return this.state();
  }
  async blankGame() {
    const runningWorld = this.workers.find(
      (w) => w.session?.running && w.session.worldId,
    );
    const candidates = [
      runningWorld?.sourceSnapshot.config.game_executable_path,
    ];
    const usable = async (file) => {
      if (!file || !path.isAbsolute(file) || !/\.exe$/i.test(file))
        return false;
      try {
        return (await fs.stat(file)).isFile();
      } catch (e) {
        if (!["ENOENT", "ENOTDIR"].includes(e.code)) throw e;
        return false;
      }
    };
    for (const file of candidates) if (await usable(file)) return file;
    if (this.store.value.settings.GamePath) {
      if (await usable(this.store.value.settings.GamePath))
        return this.store.value.settings.GamePath;
      throw Error("全局游戏程序不存在，请在设置中重新选择");
    }
    for (const worker of this.workers.slice().reverse()) {
      const file = worker.sourceSnapshot?.config.game_executable_path;
      if (await usable(file)) return file;
    }
    for (const p of this.store.value.projects) {
      const snapshot = await this.store.readProject(p.id);
      if (!snapshot.config?.game_executable_path) continue;
      const file = path.resolve(
        p.baseDirectory || p.root,
        snapshot.config.game_executable_path,
      );
      if (await usable(file)) return file;
    }
    const result = await this.discover();
    if (result.games.length) return result.games[0].path;
    throw Error("没有找到游戏程序。请在工具箱设置中选择全局游戏程序。");
  }
  startBlank(userName) {
    if (
      typeof userName !== "string" ||
      !userName.trim() ||
      [...userName.trim()].length > 32 ||
      /[\x00-\x1f\x7f]/.test(userName)
    )
      return Promise.reject(Error("玩家名应为 1–32 个字符，不能包含控制字符"));
    return this.start(null, null, { userName: userName.trim() });
  }
  async start(profileId, worldId = null, blank = null, automation = null) {
    if (this.closed) throw Error("工具箱正在关闭，不能启动游戏");
    if (
      this.restartReservation &&
      automation?.restartReservation !== this.restartReservation
    )
      throw Error("正在按最新配置重启，请等待完成");
    const quickTest = automation?.quickTest;
    if (this.starting) throw Error("正在启动游戏，请稍后再开一个客户端");
    if (
      worldId &&
      this.workers.some(
        (w) => w.session?.running && w.session.worldId === worldId,
      )
    )
      throw Error("已有存档主机正在运行此地图，请勿重复启动同一存档");
    if (
      worldId &&
      !this.isolation &&
      this.workers.some((w) => w.session?.running && w.session.worldId)
    )
      throw Error("已有存档正在运行；当前启动环境未提供独立主机隔离");
    this.starting = true;
    this.publish();
    let isolated,
      adopted = false;
    try {
      await this.store.queue;
      await this.profiles?.queue.catch(() => {});
      const runId = crypto.randomUUID(),
        runDir = path.join(path.dirname(this.store.file), "runs", runId);
      let snapshot, profile;
      if (quickTest) {
        if (!worldId || blank || automation?.runtimeConfig)
          throw Error("快速测试需要指定存档");
        const mods = await quickTestMods(this.modLibrary, quickTest);
        profileId = "quick-" + runId;
        profile = { id: profileId, name: "快速测试（默认参数）", root: runDir };
        snapshot = {
          project: profile,
          revision: null,
          exists: true,
          config: {
            ...profileDefaults(),
            included_mod_dirs: mods,
            include_debug_mod: true,
            mcp_server_config: { enabled: true },
          },
        };
      } else if (blank) {
        profileId = "blank-" + runId;
        profile = {
          id: profileId,
          name: automation?.roomGuest || automation?.localJoin
            ? "联机客户端"
            : automation?.debug
              ? "AI 调试客户端"
              : "空白客户端",
          root: runDir,
        };
        snapshot = {
          project: profile,
          revision: null,
          exists: true,
          config: {
            ...profileDefaults(),
            game_executable_path:
              automation?.runtimeConfig?.game_executable_path ||
              (await this.blankGame()),
            user_name: blank.userName,
            included_mod_dirs: [],
            include_debug_mod: !!automation?.debug,
            auto_hot_reload_mods: false,
            auto_hot_reload_ui: false,
            auto_hot_reload_shaders: false,
            auto_hot_reload_materials: false,
            auto_hot_reload_particles: false,
            mcp_server_config: { enabled: !!automation?.debug },
          },
        };
      } else {
        snapshot = await (this.profiles
          ? this.profiles.read(profileId)
          : this.store.readProject(profileId));
        if (!snapshot.config) throw Error(snapshot.error);
        profile = this.store.project(profileId);
      }
      const launchConfig = automation?.runtimeConfig || snapshot.config;
      const inheritedGame = !launchConfig.game_executable_path.trim();
      const selectedGame = inheritedGame
        ? this.store.value.settings.GamePath
        : launchConfig.game_executable_path;
      if (!selectedGame)
        throw Error("请先在设置中选择全局游戏程序，或在此启动配置中单独指定");
      if (inheritedGame && !path.isAbsolute(selectedGame))
        throw Error("全局游戏程序路径无效，请在设置中重新选择");
      let config = resolvePaths(
        { ...launchConfig, game_executable_path: selectedGame },
        profile.baseDirectory || profile.root,
      );
      const launchSource = {
        mode:
          automation?.runtimeConfig || blank
            ? "snapshot"
            : quickTest
              ? "quick"
              : "profile",
        profileId: quickTest ? null : profileId,
        selection: sourceSelection(config),
        ...(quickTest ? { modIds: [...quickTest.modIds] } : {}),
        debug: !!automation?.debug,
        ...(automation?.playerName !== undefined
          ? { playerName: automation.playerName }
          : {}),
      };
      await automation?.preflight?.();
      if (inheritedGame) {
        try {
          if (!(await fs.stat(config.game_executable_path)).isFile())
            throw Error("不是文件");
        } catch {
          throw Error("全局游戏程序不存在或无法读取，请在设置中重新选择");
        }
      }
      let launchActions = [];
      if (worldId) {
        const world = await this.worlds.launchWorld(
          worldId,
          profileId,
          !!quickTest,
        );
        if (quickTest)
          await this.worlds.saveQuickTest(worldId, quickTest.modIds);
        launchActions = normalizeActions(world.actions);
        config = {
          ...config,
          ...world.options,
          world_name: world.name,
          world_folder_name: folderFor(world.id),
          world_source_path: world.sourcePath
            ? path.resolve(
                world.projectRoot || profile.baseDirectory || profile.root,
                world.sourcePath,
              )
            : null,
          auto_join_game: true,
          reset_world: false,
        };
        if (world.sourcePath === "auto") {
          const candidate = world.projectRoot || profile.baseDirectory;
          config.world_source_path = null;
          try {
            if ((await fs.stat(path.join(candidate, "level.dat"))).isFile())
              config.world_source_path = candidate;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        isolated = await this.isolation?.prepare(
          worldId,
          config,
          this.store.value.settings.LauncherPath || this.runtime,
          runDir,
          this.store.value.settings.IndependentWorlds !== false,
        );
        if (
          (!isolated || isolated.mode === "shared") &&
          this.workers.some((w) => w.session?.running && w.session.worldId)
        )
          throw Error(
            "已有存档正在运行；请在设置中开启独立主机，并使用内置启动器与已支持的开发版游戏",
          );
        if (world.embeddedPacks)
          config.included_mod_dirs = await this.worlds.prepareWorldPacks(
            world.id,
            world.embeddedPacks,
            config.included_mod_dirs,
            isolated?.mode === "isolated",
            isolated === null && this.isolation ? undefined : runDir,
          );
      } else
        config = {
          ...config,
          world_folder_name: "MENU",
          world_name: "Menu runtime",
          world_source_path: null,
          auto_join_game: false,
          reset_world: false,
        };
      if (!worldId && automation?.localJoin && this.isolation)
        isolated = await this.isolation.prepareClient(runDir, config, this.store.value.settings.LauncherPath || this.runtime);
      if (automation?.playerName !== undefined)
        config.user_name = menuPlayerName(automation.playerName);
      // Profile launches always provide the toolbox's in-world capabilities,
      // including legacy profiles that explicitly disabled the helper pack.
      if (!blank) config.include_debug_mod = true;
      if (automation?.debug) {
        config.include_debug_mod = true;
        config.mcp_server_config = {
          ...config.mcp_server_config,
          enabled: true,
        };
      }
      config = validateConfig(config);
      if (config.mcp_server_config?.enabled)
        config.mcp_server_config = await allocateMcp(
          config.mcp_server_config,
          this.workers
            .filter((w) => w.session?.running)
            .map((w) => w.sourceSnapshot?.config.mcp_server_config?.server_port)
            .filter(Boolean),
        );
      if (!worldId) config.user_name = menuPlayerName(config.user_name);
      // Local joined clients retain the host's immutable launch snapshot,
      // including absence of an override when the host used game defaults.
      if (!automation?.runtimeConfig || automation?.roomGuest)
        config = applyWindowSize(
          config,
          this.store.value.settings.GameWindowSize,
        );
      if (!blank || automation?.debug)
        config.debug_options = {
          ...config.debug_options,
          ...(this.store.value.settings.ReloadKeys || reloadDefaults),
        };
      await atomicWrite(
        path.join(runDir, ".mcdev.json"),
        JSON.stringify(config, null, 2),
      );
      const actualStore = this.store;
      const launchStore = {
        file: this.store.file,
        value: this.store.value,
        projectQueues: this.store.projectQueues,
        queue: this.store.queue,
        readProject: async () => {
          await automation?.preflight?.();
          if (quickTest) await quickTestMods(this.modLibrary, quickTest);
          if (!blank && !quickTest) {
            const current = await actualStore.readProject(profileId);
            if (current.revision !== snapshot.revision)
              throw Error("启动配置已变化，请重新启动");
          }
          return {
            ...snapshot,
            project: { ...profile, root: runDir },
            config,
            exists: true,
          };
        },
      };
      const appData = isolated
        ? isolated.roaming
        : worldId
          ? this.worlds.appDataOverride
          : path.join(runDir, "game-data");
      const ownedWorlds = {
        run: (fn) => this.worlds.run(fn),
        checkLaunch: (id, value) =>
          worldId
            ? this.worlds.checkLaunch(quickTest ? null : id, value)
            : null,
        appDataOverride: appData,
        get queue() {
          return Promise.resolve();
        },
      };
      const bridge = this.bridge
        ? {
            prepareLaunch: (id) => this.bridge.prepareLaunch(id, runDir),
            releaseLaunch: (id) => this.bridge.releaseLaunch(id),
            stopForLaunch: (id) => this.bridge.stopForLaunch(id),
          }
        : null;
      const detectRunning = async (file) => {
        if (isolated && isolated.mode !== "shared") return false; // Validated private deployment + held world lock.
        if (!worldId) return false;
        if (!this.detectPids) return this.gameIsRunning(file);
        const pids = await this.detectPids(file),
          snap = this.bridge?.snapshot().sessions || [];
        const privateIds = new Set(
          snap
            .filter((s) =>
              this.workers.some(
                (w) =>
                  w.session?.running &&
                  w.session.role === "menu" &&
                  w.session.bridgeRegistrationId === s.registrationId,
              ),
            )
            .map((s) => s.minecraftPid),
        );
        return pids.some((pid) => !privateIds.has(pid));
      };
      const sourceRoots = await Promise.all(
        config.included_mod_dirs
          .filter(
            (entry) => typeof entry === "string" || entry.enabled !== false,
          )
          .map(async (entry) => {
            const dir = path.resolve(
              typeof entry === "string"
                ? entry
                : entry.toolbox_source_path || entry.path,
            );
            try {
              return await fs.realpath(dir);
            } catch (e) {
              if (e.code === "ENOENT") return dir;
              throw e;
            }
          }),
      );
      const worker = new Launcher(launchStore, this.runtime, {
        ...this.launcherOptions,
        ...(isolated
          ? { spawn: isolated.spawn, kill: () => isolated.stop() }
          : {}),
        bridge,
        worlds: ownedWorlds,
        detectRunning,
        beforeSpawn: isolated
          ? isolated.options
          : this.gameOptions
            ? () => this.gameOptions.prepare()
            : undefined,
      });
      worker.sourceSnapshot = { project: profile, config };
      worker.launchSource = launchSource;
      worker.launchActions = launchActions;
      worker.on("state", () => this.publish());
      worker.on("log", (entry) => {
        if (this.current === worker) {
          this.revision++;
          this.emit("log", entry);
        }
      });
      this.workers.push(worker);
      await worker.start(profileId, snapshot.revision);
      adopted = true;
      Object.assign(worker.session, {
        role: worldId ? "world" : "menu",
        worldId: worldId || null,
        profileName: profile.name,
        userName: config.user_name,
        blank: !!blank && !automation?.localJoin,
        quickTest: !!quickTest,
        runDirectory: runDir,
        storageMode: isolated?.mode || (isolated ? "isolated" : "shared"),
        isolationRoot: isolated?.roaming || null,
        actualWorldPath: isolated?.actualWorld || null,
        sourceRoots,
      });
      if (!worldId && this.menuName) {
        worker.session.playerNameStatus = "applying";
        try {
          const identity = await this.menuName.apply(
            this.bridge,
            worker,
            config.user_name,
            runDir,
            automation?.prepareClient
              ? (session) => automation.prepareClient(worker, session)
              : undefined,
          );
          worker.session.playerNameStatus = "applied";
          worker.session.minecraftPid = identity.pid;
          worker.log("system", "客户端玩家名已设置：" + identity.name);
        } catch (error) {
          worker.session.playerNameStatus = "failed";
          worker.log("stderr", "客户端玩家名设置失败：" + error.message);
          try {
            await worker.stop();
          } catch (stopError) {
            throw Error(
              "玩家名设置失败，且无法停止此客户端，请手动关闭该客户端：" +
                error.message +
                "；" +
                stopError.message,
            );
          }
          throw Error("客户端已停止，玩家名未能设置：" + error.message);
        }
      }
      this.selected = worker.session.id;
      this.epoch++;
      this.publish();
      return this.state();
    } finally {
      if (isolated && !adopted) await isolated.stop();
      this.starting = false;
      this.publish();
    }
  }
  async stop(id = this.session?.id) {
    const worker = this.workers.find((w) => w.session?.id === id);
    if (!worker) throw Error("请选择要停止的游戏会话");
    await worker.stop();
    this.publish();
    return this.state();
  }
  async remove(id) {
    const worker = this.workers.find((w) => w.session?.id === id);
    if (!worker) throw Error("会话已移除，请刷新");
    if (worker.session.running || worker.starting || worker.stopping)
      throw Error("只能删除已结束的会话，请先停止该会话");
    await worker.history.finish();
    await this.gameLogs?.forget(id);
    if (worker.session.running || worker.starting || worker.stopping)
      throw Error("会话状态已变化，请重试");
    const selected = this.current === worker;
    this.workers = this.workers.filter((w) => w !== worker);
    worker.removeAllListeners("state");
    worker.removeAllListeners("log");
    if (selected) {
      this.selected =
        this.workers.find((w) => w.session?.running)?.session.id ||
        this.workers.at(-1)?.session?.id ||
        "";
      this.epoch++;
    }
    this.publish();
    return this.state();
  }
  async shutdown() {
    this.closed = true;
    await this.historyQueue;
    if (this.starting)
      await new Promise((resolve) => {
        const done = () => {
          if (!this.starting) {
            this.off("state", done);
            resolve();
          }
        };
        this.on("state", done);
        done();
      });
    await this.profiles?.queue.catch(() => {});
    await this.store.queue;
    await Promise.all([...this.store.projectQueues.values()]);
    await this.worlds.queue.catch(() => {});
    for (const worker of this.workers) await worker.shutdown();
    await this.gameLogs?.dispose();
  }
  recordExit(game) {
    const worker = this.workers.find(
      (w) => w.session?.bridgeRegistrationId === game.registrationId,
    );
    if (
      !worker ||
      !Number.isInteger(game.minecraftExitCode) ||
      worker.session.gameExitCode !== undefined
    )
      return;
    worker.session.gameExitCode = game.minecraftExitCode;
    worker.log(
      game.minecraftExitCode ? "stderr" : "system",
      `Minecraft 游戏进程已退出：${game.minecraftExitCode}（0x${(game.minecraftExitCode >>> 0).toString(16).toUpperCase()}）；启动器退出码另行记录。`,
    );
    worker.publish();
  }
}
module.exports = { Sessions };
