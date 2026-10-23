const crypto = require("node:crypto");
const path = require("node:path");
const { normalizeBiome } = require("../../../shared/biome-model.cjs");
const {
  biomeProbeCode,
  biomePlan,
  biomeBatchCode,
} = require("./biome-actions.cjs");
const MAX_ACTIONS = 64;
function text(value, max, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw Error(label + "为空或过长");
  return value.trim();
}
function normalizeAction(value) {
  if (!value || !["command", "item", "script", "biome"].includes(value.type))
    throw Error("无效功能类型");
  const action = {
    id: text(value.id, 80, "功能 ID"),
    name: text(value.name, 80, "功能名称"),
    type: value.type,
    enabled: value.enabled !== false,
    auto: value.auto === true,
  };
  if (action.type === "command") {
    action.command = text(value.command, 4096, "游戏指令");
    if (/[\r\n]/.test(action.command))
      throw Error("每个指令功能只允许一条指令");
  } else if (action.type === "item") {
    action.item = text(value.item, 160, "物品标识符");
    if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(action.item))
      throw Error("请填写命名空间:物品名，例如 minecraft:diamond");
    action.count = value.count;
    action.aux = value.aux;
    if (
      !Number.isInteger(action.count) ||
      action.count < 1 ||
      action.count > 64 ||
      !Number.isInteger(action.aux) ||
      action.aux < 0 ||
      action.aux > 32767
    )
      throw Error("数量须为 1–64 的整数，附加值须为 0–32767 的整数");
  } else if (action.type === "biome") {
    Object.assign(action, normalizeBiome(value));
  } else {
    action.code = text(value.code, 16384, "Python 代码");
    if (!["client", "server"].includes(value.target))
      throw Error("请选择脚本执行端");
    action.target = value.target;
  }
  return action;
}
function normalizeActions(value = []) {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS)
    throw Error("每个存档最多保存 64 个功能");
  const actions = value.map(normalizeAction);
  if (new Set(actions.map((a) => a.id)).size !== actions.length)
    throw Error("功能 ID 重复");
  return actions;
}
const revision = (actions) =>
  crypto.createHash("sha256").update(JSON.stringify(actions)).digest("hex");
// JSON is carried as base64 so arbitrary quotes/Chinese never become Python syntax.
const payload = (value) =>
  `__import__('json').loads(__import__('base64').b64decode('${Buffer.from(JSON.stringify(value)).toString("base64")}'))`;
const playerProbe =
  "# DGN_ACTION_PLAYER\nimport mod.client.extraClientApi as api\n_result={'playerId':api.GetLocalPlayerId()}";
function actionCode(action, playerId) {
  if (action.type === "script") return action.code;
  const setup = [
    "# DGN_WORLD_ACTION",
    "import mod.server.extraServerApi as api",
    `data=${payload({ ...action, playerId })}`,
    "player=data['playerId']",
    "if player not in api.GetPlayerList(): raise RuntimeError('Target player has left the world')",
    "factory=api.GetEngineCompFactory()",
  ];
  if (action.type === "command")
    setup.push(
      "ok=factory.CreateCommand(api.GetLevelId()).SetCommand(data['command'].encode('utf-8'),player,True)",
      "_result={'ok':bool(ok)}",
    );
  else
    setup.push(
      "item={'newItemName':data['item'].encode('utf-8'),'count':data['count'],'newAuxValue':data['aux']}",
      "ok=factory.CreateItem(player).SpawnItemToPlayerInv(item,player)",
      "_result={'ok':bool(ok)}",
    );
  return setup.join("\n");
}
class WorldActions {
  constructor(
    sessions,
    debug,
    worlds,
    { interval = 750, timeout = 120000 } = {},
  ) {
    Object.assign(this, { sessions, debug, worlds, timeout });
    this.records = new Map();
    this.disposed = false;
    this.onChange = () => this.reconcile();
    sessions.on("state", this.onChange);
    debug.on("state", this.onChange);
    this.timer = setInterval(this.onChange, interval);
    this.timer.unref();
  }
  config(worldId) {
    return this.worlds.run(async () => {
      const w = this.worlds.find(await this.worlds.read(), null, worldId);
      const info = await this.worlds.inspect(w);
      if (info.deleted || w.copying) throw Error("存档不可用");
      const actions = normalizeActions(w.actions);
      return { actions, revision: revision(actions) };
    });
  }
  save({ worldId, actions: input, revision: expected }) {
    const actions = normalizeActions(input);
    return this.worlds.run(async () => {
      const data = await this.worlds.read(),
        w = this.worlds.find(data, null, worldId);
      if ((await this.worlds.inspect(w)).deleted || w.copying)
        throw Error("存档不可用");
      if (revision(normalizeActions(w.actions)) !== expected)
        throw Error("功能配置已变化，请重新打开后编辑");
      w.actions = actions;
      if (
        Buffer.byteLength(JSON.stringify(data, null, 2) + "\n") >
        4 * 1024 * 1024
      )
        throw Error("存档功能配置过大，请减少脚本或功能数量后重试");
      await this.worlds.write(data);
      return { actions, revision: revision(actions) };
    });
  }
  worker(id) {
    const w = this.sessions.workers.find((w) => w.session?.id === id);
    if (!w?.session?.worldId || w.session.role !== "world")
      throw Error("请选择存档主机会话");
    return w;
  }
  target(w) {
    if (this.disposed || !w.session.running || w.stopping)
      throw Error("存档会话已结束或正在停止");
    const b = this.debug
      .snapshot()
      .sessions.find(
        (b) => b.registrationId === w.session.bridgeRegistrationId,
      );
    if (
      !b?.connected ||
      b.mcdkPid !== w.session.pid ||
      !b.minecraftPid ||
      path.resolve(b.projectRoot || "").toLowerCase() !==
        path.resolve(w.session.runDirectory).toLowerCase()
    )
      throw Error("正在等待该存档的调试连接");
    this.debug.session(b.id, b.connectionGeneration);
    return {
      sessionId: w.session.id,
      bridgeId: b.id,
      generation: b.connectionGeneration,
      sequence: b.stateSequence,
      pid: b.minecraftPid,
    };
  }
  guard(w, target) {
    const actual = this.target(w);
    if (JSON.stringify(actual) !== JSON.stringify(target))
      throw Error("游戏已重载或连接已变化，本次操作已取消");
  }
  code(w, target, code, client) {
    this.guard(w, target);
    return this.debug.code(
      target.bridgeId,
      target.generation,
      code,
      client,
      () => this.guard(w, target),
    );
  }
  async player(w, target) {
    const value = await this.code(w, target, playerProbe, true);
    const id = value?.playerId;
    if (
      typeof id !== "string" ||
      !/^-?\d+$/.test(id) ||
      id === "-1" ||
      id === "0"
    )
      return null;
    const ready = await this.code(
      w,
      target,
      `# DGN_ACTION_READY\nimport mod.server.extraServerApi as api\n_result={'ready':${payload(id)} in api.GetPlayerList()}`,
      false,
    );
    return ready?.ready === true ? id : null;
  }
  record(w) {
    let r = this.records.get(w.session.id);
    if (!r) {
      r = {
        phase: "waiting",
        message: "等待进入存档和玩家就绪",
        deadline: Date.now() + this.timeout,
        actions: w.launchActions || [],
        busy: false,
        history: [],
        target: null,
        job: null,
      };
      this.records.set(w.session.id, r);
      if (!r.actions.some((a) => a.auto && a.enabled)) {
        r.phase = "idle";
        r.message = "未设置启动自动操作";
      }
    }
    return r;
  }
  status(worldId) {
    const w = this.sessions.workers.findLast(
      (w) => w.session?.worldId === worldId,
    );
    if (!w)
      return { ready: false, message: "启动存档后可使用即时功能", history: [] };
    const r = this.record(w);
    const reloadBridge = this.debug
      .snapshot()
      .sessions.find(
        (b) =>
          b.connected &&
          b.registrationId === w.session.bridgeRegistrationId &&
          b.mcdkPid === w.session.pid,
      );
    let target = null,
      reason = "";
    try {
      target = this.target(w);
    } catch (e) {
      reason = e.message;
    }
    return {
      sessionId: w.session.id,
      reloadTarget:
        w.session.running && reloadBridge
          ? {
              sessionId: reloadBridge.id,
              generation: reloadBridge.connectionGeneration,
            }
          : null,
      ready: !!target,
      target,
      busy: r.busy,
      phase: r.phase,
      message: r.message,
      reason,
      history: r.history,
    };
  }
  entry(w, r, action, automatic) {
    const entry = {
      id: crypto.randomUUID(),
      actionId: action.id,
      name: action.name,
      automatic,
      at: new Date().toISOString(),
      status: "running",
      message: "执行中",
    };
    r.history.unshift(entry);
    r.history.splice(100);
    return entry;
  }
  async execute(w, r, action, target, playerId, automatic) {
    const e = this.entry(w, r, action, automatic);
    try {
      const result =
        action.type === "biome"
          ? await this.setBiome(w, target, action, playerId, e)
          : await this.code(
              w,
              target,
              actionCode(action, playerId),
              action.type === "script" && action.target === "client",
            );
      if (action.type !== "script" && result?.ok !== true)
        throw Error("游戏返回失败，请检查指令、物品或背包状态");
      e.status = "success";
      e.message =
        action.type === "biome"
          ? `群系已设置为 ${action.biome}；维度 ${result.dimension}，中心 (${result.origin.join(", ")})，Y ${result.minY}～${result.maxY}，共 ${result.columns} 列。2D 整列及 3D 表面群系遵循游戏规则`
          : action.type === "script"
            ? "脚本已执行：" +
              String(JSON.stringify(result) ?? "无返回值").slice(0, 2000)
            : "游戏已确认执行成功";
      w.log("system", "[存档功能] " + action.name + "：" + e.message);
      return e;
    } catch (error) {
      e.status = "error";
      e.message =
        error.message.slice(0, 2000) +
        "。未自动重试；超时或断线时请先检查游戏内结果。";
      w.log("stderr", "[存档功能] " + action.name + "：" + e.message);
      throw error;
    }
  }
  async setBiome(w, target, action, playerId, entry) {
    const probe = await this.code(
      w,
      target,
      biomeProbeCode(action, playerId),
      false,
    );
    const plan = biomePlan(action, probe, playerId);
    let completed = 0;
    entry.result = {
      dimension: plan.dimension,
      origin: plan.origin,
      minY: plan.minY,
      maxY: plan.maxY,
      columns: plan.columns,
      completedColumns: 0,
    };
    try {
      for (let i = 0; i < plan.volumes.length; i += 2) {
        const batch = plan.volumes.slice(i, i + 2);
        const result = await this.code(
          w,
          target,
          biomeBatchCode(plan, batch),
          false,
        );
        if (
          !Number.isInteger(result?.completed) ||
          result.completed < 0 ||
          result.completed > batch.length
        )
          throw Error("群系修改回执无效，本批结果未知");
        completed += batch
          .slice(0, result.completed)
          .reduce((n, v) => n + v.columns, 0);
        entry.result.completedColumns = completed;
        entry.message = `维度 ${plan.dimension}：已完成 ${completed}/${plan.columns} 列`;
        if (result.ok !== true || result.completed !== batch.length)
          throw Error("游戏未完成本批群系修改，失败区域可能已有部分变化");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { ok: true, ...entry.result };
    } catch (e) {
      throw Error(
        `群系修改停止：已确认 ${completed}/${plan.columns} 列；维度 ${plan.dimension}。${e.message}`,
      );
    }
  }
  reconcile() {
    if (this.disposed) return;
    for (const [id, r] of this.records) {
      if (!this.sessions.workers.some((w) => w.session?.id === id) && !r.busy)
        this.records.delete(id);
    }
    for (const w of this.sessions.workers) {
      if (!w.session?.worldId || !w.launchActions) continue;
      const r = this.record(w);
      if (r.phase !== "waiting" || r.busy) continue;
      if (!w.session.running || w.stopping || Date.now() > r.deadline) {
        r.phase = "cancelled";
        r.message = "自动操作已取消：会话结束或等待就绪超时";
        continue;
      }
      let target;
      try {
        target = this.target(w);
      } catch (e) {
        if (r.target) {
          r.phase = "cancelled";
          r.message = "自动操作已取消：世界状态发生变化";
        } else r.message = e.message;
        continue;
      }
      if (r.target && JSON.stringify(target) !== JSON.stringify(r.target)) {
        r.phase = "cancelled";
        r.message = "自动操作已取消：游戏重载或重新连接";
        continue;
      }
      r.target = target;
      r.busy = true;
      r.job = this.auto(w, r, target).finally(() => {
        r.busy = false;
      });
    }
  }
  async auto(w, r, target) {
    try {
      const playerId = await this.player(w, target);
      if (r.phase !== "waiting") return;
      if (this.disposed || Date.now() > r.deadline) {
        r.phase = "cancelled";
        r.message = "自动操作已取消：等待超时或工具箱正在退出";
        return;
      }
      if (!playerId) {
        r.message = "等待房主玩家就绪";
        return;
      }
      // Mark before the first mutation. Reconnection, page remount and reload never replay it.
      r.phase = "running";
      r.message = "正在执行启动自动操作";
      for (const action of r.actions.filter((a) => a.auto && a.enabled))
        await this.execute(w, r, action, target, playerId, true);
      r.phase = "done";
      r.message = "本次启动的自动操作已完成";
    } catch (e) {
      r.phase = "error";
      r.message =
        "自动操作已停止：" + e.message + "。未自动重试，后续操作未执行。";
      w.log("stderr", "[存档功能] " + r.message);
    }
  }
  async run({ worldId, sessionId, target, actionId, quick }) {
    const w = this.worker(sessionId);
    if (w.session.worldId !== worldId) throw Error("存档与会话不匹配");
    this.guard(w, target);
    const r = this.record(w);
    if (r.busy || ["waiting", "running"].includes(r.phase))
      throw Error("正在执行或等待启动自动操作，请稍后");
    r.busy = true;
    const operation = async () => {
      const action = quick
        ? normalizeAction({ ...quick, id: "quick", auto: false, enabled: true })
        : (await this.config(worldId)).actions.find((a) => a.id === actionId);
      if (!action?.enabled) throw Error("功能不存在或已停用");
      const playerId = await this.player(w, target);
      if (!playerId) throw Error("房主玩家尚未就绪，请稍后点击");
      return this.execute(w, r, action, target, playerId, false);
    };
    r.job = operation().finally(() => {
      r.busy = false;
    });
    return r.job;
  }
  cancel(sessionId) {
    const w = this.worker(sessionId),
      r = this.record(w);
    if (r.phase !== "waiting") throw Error("只能取消尚未开始的自动操作");
    r.phase = "cancelled";
    r.message = "已取消本次启动自动操作";
  }
  async dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.sessions.off("state", this.onChange);
    this.debug.off("state", this.onChange);
    await Promise.allSettled([...this.records.values()].map((r) => r.job));
  }
}
module.exports = {
  WorldActions,
  normalizeActions,
  normalizeAction,
  actionCode,
  playerProbe,
};
