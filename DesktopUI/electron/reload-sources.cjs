const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { resolvePaths, profileDefaults } = require("./profiles.cjs");
const { quickTestMods } = require("./quick-test.cjs");
const hash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sourceSelection(config) {
  return {
    mods: (config.included_mod_dirs || []).map((entry) => ({
      path: path.resolve(typeof entry === "string" ? entry : entry.path),
      enabled: typeof entry === "string" || entry.enabled !== false,
      hotReload: typeof entry === "string" || entry.hot_reload !== false,
    })),
    automatic: config.auto_hot_reload_mods !== false,
  };
}
const equivalent = (value) => ({
  ...value,
  mods: value.mods.map((m) => ({ ...m, path: m.path.toLowerCase() })),
});
class ReloadSources {
  constructor(sessions, debug) {
    this.sessions = sessions;
    this.debug = debug;
    this.busy = false;
  }
  target(context) {
    const b = this.debug.session(context.sessionId, context.generation, false);
    const worker = this.sessions.workers.find(
      (w) =>
        w.session?.running &&
        !w.stopping &&
        w.session.bridgeRegistrationId === b.registrationId &&
        w.session.pid === b.mcdkPid,
    );
    return { worker, bridge: { ...b } };
  }
  async latest(worker) {
    const { store, profiles, worlds, modLibrary } = this.sessions,
      source = worker.launchSource;
    if (!source || source.mode === "snapshot")
      throw Error("此会话使用固定运行快照，请从原启动入口重新启动");
    await store.queue;
    await profiles?.queue.catch(() => {});
    let snapshot, config, quickTest, world;
    if (worker.session.worldId) {
      world = worlds.find(await worlds.read(), null, worker.session.worldId);
      if (world.deletedAt || world.copying)
        throw Error("目标存档已删除或尚未准备完成");
    }
    if (source.mode === "quick") {
      const catalog = await modLibrary.list();
      quickTest = {
        modIds: world.quickTestModIds || source.modIds,
        revision: catalog.revision,
      };
      config = {
        ...profileDefaults(),
        included_mod_dirs: await quickTestMods(modLibrary, quickTest),
      };
      snapshot = {
        revision: hash(quickTest),
        project: { root: worker.session.runDirectory },
      };
    } else {
      if (world && (world.profileId || world.projectId) !== source.profileId)
        throw Error("存档绑定配置已变化，请保存退出后从该存档卡片重新启动");
      snapshot = await (profiles
        ? profiles.read(source.profileId)
        : store.readProject(source.profileId));
      if (!snapshot.config) throw Error(snapshot.error || "原启动配置不存在");
      config = resolvePaths(
        snapshot.config,
        snapshot.project.baseDirectory || snapshot.project.root,
      );
    }
    if (!config.game_executable_path?.trim())
      config.game_executable_path = store.value.settings.GamePath || "";
    return {
      config,
      quickTest,
      snapshot,
      world,
      selection: sourceSelection(config),
      token: hash([
        worker.session.id,
        snapshot.revision,
        world,
        store.value.settings,
      ]),
    };
  }
  async status(context) {
    const { worker, bridge } = this.target(context);
    if (!worker)
      return {
        supported: false,
        canRestart: false,
        changed: false,
        activeSources: [],
        message: "此调试连接不属于工具箱启动会话，无法比较启动来源",
      };
    const result = {
      supported: !!worker.launchSource,
      canRestart: false,
      changed: false,
      activeSources: worker.session.sourceRoots || [],
      sessionId: worker.session.id,
      worldId: worker.session.worldId,
      profileName: worker.session.profileName,
      message:
        "热更新与重载使用本次启动的模组来源；修改其他工作树不会自动切换。",
    };
    if (!worker.launchSource || worker.launchSource.mode === "snapshot")
      return result;
    try {
      const latest = await this.latest(worker);
      if (
        this.target(context).worker !== worker ||
        bridge.stateSequence !==
          this.debug.session(context.sessionId, context.generation, false)
            .stateSequence
      )
        throw Error("会话已变化，请重新检查模组来源");
      const before = worker.launchSource.selection,
        after = latest.selection;
      result.changed =
        JSON.stringify(equivalent(before)) !==
        JSON.stringify(equivalent(after));
      result.savedSources = after.mods;
      result.activeSelection = before.mods;
      result.configFile = latest.snapshot.file || "";
      result.token = latest.token;
      result.canRestart = !!worker.session.worldId;
      if (result.changed)
        result.message =
          "已保存的模组来源或热更新设置与本次运行不同。热更新/重载不会切换来源，请保存游戏后按最新配置重启。";
    } catch (e) {
      result.error = e.message;
      result.message = "无法核对最新配置：" + e.message;
    }
    return result;
  }
  async check(context) {
    if (this.busy && this.restartingSession === context.sessionId)
      throw Error("正在按最新配置重启，请等待完成");
    const status = await this.status(context);
    if (status.error || status.changed)
      throw Error(
        status.message +
          (status.changed
            ? " 当前来源：" +
              status.activeSelection
                .filter((m) => m.enabled)
                .map((m) => m.path)
                .join("；") +
              "；最新来源：" +
              status.savedSources
                .filter((m) => m.enabled)
                .map((m) => m.path)
                .join("；")
            : ""),
      );
    return status;
  }
  async restart(context) {
    if (context.confirmed !== true)
      throw Error("请先保存游戏进度，并确认按最新配置重启");
    if (this.busy || this.sessions.starting || this.sessions.stopping)
      throw Error("已有启动、停止或重启操作，请等待完成");
    this.busy = true;
    this.restartingSession = context.sessionId;
    const reservation = crypto.randomUUID();
    this.sessions.restartReservation = reservation;
    let stopped = false;
    try {
      const { worker, bridge } = this.target(context),
        status = await this.status(context);
      if (!worker || !status.canRestart || status.error)
        throw Error(status.error || "仅工具箱存档主机支持按最新配置重启");
      if (context.token !== status.token)
        throw Error("配置在确认期间发生变化，请重新检查并确认重启");
      this.debug.assertReloadIdle(context.sessionId, true);
      const latest = await this.latest(worker);
      for (const mod of latest.selection.mods.filter((m) => m.enabled))
        if (!(await fs.stat(mod.path)).isDirectory())
          throw Error("模组目录不可用：" + mod.path);
      for (const file of [
        latest.config.game_executable_path,
        this.sessions.store.value.settings.LauncherPath ||
          this.sessions.runtime,
      ])
        if (!file || !path.isAbsolute(file) || !(await fs.stat(file)).isFile())
          throw Error("游戏程序或启动器不存在，请先修正配置");
      const world = await this.sessions.worlds.inspect(latest.world);
      if (!world.present || !world.ready || world.deleted)
        throw Error("目标存档不可用，请先恢复存档目录");
      if (
        latest.token !== context.token ||
        (await this.latest(worker)).token !== context.token
      )
        throw Error("配置已变化，请重新确认");
      if (
        this.target(context).worker !== worker ||
        this.debug.session(context.sessionId, context.generation, false)
          .stateSequence !== bridge.stateSequence
      )
        throw Error("游戏状态已变化，本次重启已取消");
      this.debug.assertReloadIdle(context.sessionId, true);
      await this.sessions.stop(worker.session.id);
      if (worker.session.running) throw Error("原游戏未确认退出，取消重新启动");
      stopped = true;
      const source = worker.launchSource;
      if ((await this.latest(worker)).token !== context.token)
        throw Error("配置在停止期间又发生变化，请从存档卡片检查后启动");
      return await this.sessions.start(
        source.mode === "quick" ? null : source.profileId,
        worker.session.worldId,
        null,
        {
          debug: source.debug,
          ...(source.playerName !== undefined
            ? { playerName: source.playerName }
            : {}),
          ...(latest.quickTest ? { quickTest: latest.quickTest } : {}),
          restartReservation: reservation,
          preflight: async () => {
            if ((await this.latest(worker)).token !== context.token)
              throw Error("配置已变化，取消本次重新启动");
          },
        },
      );
    } catch (e) {
      if (stopped) e.message = "原游戏已停止，新启动未完成：" + e.message;
      throw e;
    } finally {
      if (this.sessions.restartReservation === reservation)
        this.sessions.restartReservation = null;
      this.busy = false;
      this.restartingSession = null;
    }
  }
}
module.exports = { ReloadSources, sourceSelection };
