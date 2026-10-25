const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite } = require("../../services.cjs");
const { prepareChunker } = require("./chunker.cjs");
const { copySnapshot, readData, writeData } = require("./terrain-storage.cjs");
const model = require("../../../shared/terrain-model.cjs");
const runtime = require("./terrain-runtime.cjs");
const { AUTO_IMPORT_PROFILE } = require("../../../shared/world-import-model.cjs");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

class ArchitectureImport {
  constructor({ dataRoot, worlds, profiles, sessions, actions, converter = prepareChunker }) {
    Object.assign(this, { worlds, profiles, sessions, actions, converter });
    this.root = path.join(dataRoot, "architecture");
    this.file = path.join(this.root, "task.json");
    this.task = null;
    this.job = null;
    this.controller = null;
    this.disposed = false;
    this.loading = null;
    this.queue = Promise.resolve();
  }
  call(method, args) {
    const operation = this.queue.catch(() => {}).then(() => this[method](args));
    this.queue = operation;
    return operation;
  }
  async load() {
    if (!this.loading) this.loading = (async () => {
      let raw;
      try { raw = await fs.readFile(this.file, "utf8"); }
      catch (e) { if (e.code === "ENOENT") return; throw e; }
      const task = JSON.parse(raw);
      if (task.version !== 2 || !uuid(task.id)) throw Error("旧版地形任务不可续接，请保留 architecture 目录并重新建立任务");
      this.task = task;
      if (task.busy) {
        task.busy = false;
        task.stage = "interrupted";
        task.error = "上次任务中断，未自动重放。已写入批次可尝试撤销；完整备份保留在任务目录。";
        await this.save();
      }
    })();
    await this.loading;
    return this.task;
  }
  directory() {
    if (!uuid(this.task?.id)) throw Error("没有有效的地形任务");
    return path.join(this.root, this.task.id);
  }
  async save() {
    await fs.mkdir(this.root, { recursive: true });
    await atomicWrite(this.file, JSON.stringify(this.task, null, 2));
    await atomicWrite(path.join(this.directory(), "task.json"), JSON.stringify(this.task, null, 2));
    return this.state();
  }
  async state() {
    if (!this.task) await this.load();
    return this.task ? structuredClone({ ...this.task, directory: this.directory() }) : null;
  }
  async require(args = {}, stages) {
    await this.load();
    if (this.job && !this.task?.busy) await this.job;
    if (this.disposed || this.job) throw Error("地形任务正在运行或工具箱正在退出");
    if (!this.task || args.taskId !== this.task.id) throw Error("地形任务已变化，请重新打开");
    if (stages && !stages.includes(this.task.stage)) throw Error("当前步骤不可执行此操作");
    return this.task;
  }
  check() {
    if (this.disposed || this.controller?.signal.aborted) throw Error("任务已停止；已确认的进度和备份已保留");
  }
  begin(stage, action, complete, context) {
    if (this.job || this.disposed) throw Error("已有地形操作正在执行");
    this.controller = new AbortController();
    this.task.busy = true;
    this.task.stage = stage;
    this.task.error = "";
    this.task.progress = { completed: 0, total: 0 };
    const record = context && this.actions.record(context.worker);
    if (record) record.busy = true;
    this.job = (async () => {
      try {
        await this.save();
        await action();
        this.check();
        this.task.stage = complete;
      } catch (e) {
        this.task.stage = "interrupted";
        this.task.error = e.message;
      } finally {
        if (record) record.busy = false;
        this.task.busy = false;
        await this.save();
      }
    })().finally(() => { this.job = null; this.controller = null; });
    this.job.catch(() => {});
    return this.state();
  }
  async prepare(input) {
    await this.load();
    if (this.job || this.disposed) throw Error("请先停止当前地形任务");
    if (this.task?.attempted && !["done", "undone"].includes(this.task.stage))
      throw Error("已有未完成写入，请先撤销或从备份恢复，不能覆盖撤销记录");
    if (!["java", "bedrock"].includes(input.kind)) throw Error("来源类型无效");
    const name = String(input.name || "地形导入").trim();
    if (!name || name.length > 60 || /[\x00-\x1f]/.test(name)) throw Error("任务名称无效");
    const target = this.worlds.find(await this.worlds.read(), null, input.targetWorldId);
    if (!target.profileId) throw Error("目标存档需要绑定启动配置");
    if (this.sessions.workers.some(w => w.session?.running && [target.id, this.task?.sourceWorldId].includes(w.session.worldId)))
      throw Error("请先保存并停止目标存档和上次来源会话，再准备新任务");
    this.task = { version: 2, id: crypto.randomUUID(), name, kind: input.kind, source: input.source, chunkerJar: input.chunkerJar || "", targetWorldId: target.id, targetName: target.name, stage: "preparing", createdAt: new Date().toISOString(), attempted: 0 };
    await fs.mkdir(this.directory(), { recursive: true });
    return this.begin("preparing", async () => {
      let source = input.source;
      if (input.kind === "java") {
        if (!(await fs.stat(path.join(source, "level.dat"))).isFile()) throw Error("Java 来源目录缺少 level.dat");
        if (!input.chunkerJar || !(await fs.stat(input.chunkerJar)).isFile()) throw Error("请先选择 Chunker CLI JAR");
        const snapshot = path.join(this.directory(), "java-source");
        await copySnapshot(source, snapshot, () => this.check());
        this.task.message = "正在使用 Chunker 转换来源副本";
        const converted = await this.converter({ javaPath: snapshot, chunkerJar: input.chunkerJar, outputRoot: this.directory(), signal: this.controller.signal, onOutput: value => { this.task.message = value.slice(-600); } });
        source = converted.outputDirectory;
      }
      this.check();
      const world = await this.worlds.importWorld(AUTO_IMPORT_PROFILE, name + "（地形来源副本）", source, "copy");
      this.task.sourceWorldId = world.id;
      this.task.sourceProfileId = world.profileId;
      this.task.message = "来源副本已准备好，原地图保持不变";
    }, "prepared");
  }
  async startSource(args) {
    await this.require(args, ["prepared", "source-running", "source-ready", "interrupted"]);
    if (!this.task.sourceWorldId || this.task.capture) throw Error("来源尚未准备，或选区已经读取完成");
    if (this.task.sourceSessionId && this.sessions.workers.some(w => w.session?.id === this.task.sourceSessionId && w.session.running)) return this.state();
    return this.begin("source-starting", async () => {
      const state = await this.sessions.start(this.task.sourceProfileId, this.task.sourceWorldId);
      this.task.sourceSessionId = state.selectedSession;
    }, "source-running");
  }
  async context(which) {
    const worker = this.actions.worker(this.task[which + "SessionId"]);
    if (worker.session.worldId !== this.task[which + "WorldId"]) throw Error("任务与当前存档会话不匹配");
    if (which === "target" && this.task.backup) {
      const world = this.worlds.find(await this.worlds.read(), null, this.task.targetWorldId);
      const info = await this.worlds.inspect(world);
      if (path.resolve(info.path).toLowerCase() !== path.resolve(this.task.backup.original).toLowerCase())
        throw Error("目标存档路径发生变化，不能应用旧预览或撤销记录");
    }
    const target = this.actions.target(worker), record = this.actions.record(worker);
    if (record.busy || ["waiting", "running"].includes(record.phase)) throw Error("请先等待存档启动操作完成");
    const player = await this.actions.player(worker, target);
    if (!player) throw Error("请先进入存档，等待玩家就绪");
    const probe = await this.actions.code(worker, target, runtime.probeCode(player), false);
    if (!Number.isInteger(probe?.dimension) || !Array.isArray(probe?.position) || !probe.position.every(Number.isFinite) || !probe.min || !probe.max)
      throw Error("无法确定玩家位置、维度及高度边界");
    return { worker, target, player, probe };
  }
  async position(args) {
    await this.require(args);
    const context = await this.context(args.which === "source" ? "source" : "target");
    return { ...context.probe, position: context.probe.position.map(Math.floor) };
  }
  bounds(region, probe) {
    if (region.min[1] < probe.min[1] || region.max[1] > probe.max[1])
      throw Error(`选区高度超出维度 ${probe.dimension} 的范围 ${probe.min[1]}～${probe.max[1]}`);
  }
  async batch(context, data) {
    this.check();
    this.actions.guard(context.worker, context.target);
    const id = crypto.randomUUID();
    const code = value => this.actions.code(context.worker, context.target, value, false);
    try {
      const accepted = await code(runtime.startCode({ ...data, id, player: context.player, dimension: context.probe.dimension }));
      if (!accepted?.accepted) throw Error("游戏未确认地形批次，未自动重试");
      const end = Date.now() + 50000;
      while (Date.now() < end) {
        this.check();
        const result = await code(runtime.statusCode(id));
        if (result?.phase === "done") { if (result.liquidSkipped) (this.task.warnings ||= []).push("部分含水方块未能通过当前游戏版本的 SetLiquidBlock 写入，已保留方块状态"); return result; }
        if (result?.phase === "error") throw Error("地形批次失败：" + result.message + `（已确认 ${result.completed || 0} 格）`);
        await wait(80);
      }
      throw Error("地形批次超时，结果未知；未自动重试，请先撤销或检查备份");
    } finally { await code(runtime.cancelCode(id)).catch(() => {}); }
  }
  async sourceSave(args) {
    await this.require(args, ["source-running", "source-ready", "interrupted"]);
    if (this.task.attempted) throw Error("已有目标写入记录，不能重新覆盖来源");
    const selected = model.region(args), context = await this.context("source");
    this.bounds(selected, context.probe);
    this.task.region = selected;
    this.task.sourceDimension = context.probe.dimension;
    this.task.capture = null;
    this.task.plan = null;
    return this.begin("copying", async () => {
      const tiles = [], id = crypto.randomUUID();
      this.task.progress.total = selected.volume;
      for (const tile of model.tiles(selected)) {
        const result = await this.batch(context, { op: "read", ...tile });
        if (!Array.isArray(result.blocks) || result.blocks.length !== model.positions(tile).length) throw Error("来源读取数量不完整");
        const file = await writeData(this.directory(), id + "-source-" + tiles.length, result.blocks);
        tiles.push({ ...tile, ...file });
        this.task.progress.completed += result.blocks.length;
      }
      this.task.capture = await writeData(this.directory(), id + "-capture", tiles);
    }, "source-ready", context);
  }
  async sourceDone(args) {
    await this.require(args, ["source-ready", "interrupted"]);
    if (!this.task.capture) throw Error("来源选区尚未读取完成");
    return this.begin("source-stopping", async () => {
      const worker = this.actions.worker(this.task.sourceSessionId);
      if (worker.session.worldId !== this.task.sourceWorldId) throw Error("来源会话已变化");
      if (worker.session.running) await this.sessions.stop(worker.session.id);
    }, "source-saved");
  }
  async startTarget(args) {
    await this.require(args, ["source-saved", "target-running", "interrupted", "done", "undone"]);
    if (!this.task.capture) throw Error("来源选区尚未读取完成");
    if (this.sessions.workers.some(w => w.session?.running && w.session.id === this.task.sourceSessionId))
      throw Error("请先保存并退出来源会话");
    if (this.task.targetSessionId && this.sessions.workers.some(w => w.session?.id === this.task.targetSessionId && w.session.running)) return this.state();
    const resumeStage = this.task.attempted ? this.task.stage === "done" ? "done" : "interrupted" : "target-running";
    return this.begin("backing-up", async () => {
      const target = await this.worlds.run(async () => {
        await this.worlds.mutable([this.task.targetWorldId]);
        const world = this.worlds.find(await this.worlds.read(), null, this.task.targetWorldId);
        const info = await this.worlds.inspect(world);
        if (!info.ready || info.deleted) throw Error("目标存档需要先正常生成并退出，再执行导入");
        await this.worlds.noLinks(info.path);
        if (this.task.attempted) {
          if (!this.task.backup || path.resolve(info.path).toLowerCase() !== path.resolve(this.task.backup.original).toLowerCase()) throw Error("目标与原备份不匹配");
        } else {
          const folder = "backup-" + crypto.randomUUID();
          const size = await copySnapshot(info.path, path.join(this.directory(), folder), () => this.check());
          await this.worlds.mutable([world.id]);
          this.task.backup = { folder, original: info.path, ...size };
        }
        await this.save();
        return world;
      });
      this.check();
      const state = await this.sessions.start(target.profileId, target.id);
      this.task.targetSessionId = state.selectedSession;
    }, resumeStage);
  }
  async preview(args) {
    await this.require(args, ["target-running", "preview-ready", "done", "undone", "interrupted"]);
    if (this.task.attempted) throw Error("请先完成撤销，不能覆盖未完成写入的记录");
    if (!this.task.backup || !this.task.capture) throw Error("来源数据或目标备份不完整");
    const options = model.placement(args, this.task.region), context = await this.context("target");
    this.bounds({ min: options.origin, max: options.max }, context.probe);
    const offset = options.origin.map((v, i) => v - this.task.region.min[i]);
    const plan = { id: crypto.randomUUID(), options, dimension: context.probe.dimension, target: context.target, player: context.player, counts: { changed: 0, kept: 0, air: 0, identical: 0 } };
    this.task.plan = plan;
    return this.begin("previewing", async () => {
      const batches = [], tiles = await readData(this.directory(), this.task.capture);
      this.task.progress.total = this.task.region.volume;
      for (const tile of tiles) {
        const source = await readData(this.directory(), tile);
        const moved = { min: tile.min.map((v, i) => v + offset[i]), max: tile.max.map((v, i) => v + offset[i]) };
        const before = (await this.batch(context, { op: "read", ...moved })).blocks;
        const change = model.changes(source, before, tile, offset, options);
        for (const key of Object.keys(plan.counts)) plan.counts[key] += change.counts[key];
        if (change.writes.length) batches.push(await writeData(this.directory(), plan.id + "-plan-" + batches.length, { ...moved, writes: change.writes }));
        this.task.progress.completed += source.length;
      }
      if (Object.values(plan.counts).reduce((sum, n) => sum + n, 0) !== this.task.region.volume)
        throw Error("预览计数不完整，未允许写入");
      if (this.task.plan !== plan) throw Error("预览期间任务对象发生变化");
      plan.manifest = await writeData(this.directory(), plan.id + "-manifest", batches);
    }, "preview-ready", context);
  }
  async targetPaste(args) {
    await this.require(args, ["preview-ready"]);
    const plan = this.task.plan;
    if (args.previewId !== plan?.id || args.confirmed !== true) throw Error("请确认当前预览后再导入");
    const context = await this.context("target");
    if (!model.equal(plan.target, context.target) || plan.player !== context.player || plan.dimension !== context.probe.dimension)
      throw Error("目标会话、玩家或维度已变化，请重新预览");
    this.task.applied = 0;
    return this.begin("pasting", async () => {
      const batches = await readData(this.directory(), plan.manifest);
      this.task.progress.total = batches.length;
      for (let i = 0; i < batches.length; i++) {
        this.check();
        const batch = await readData(this.directory(), batches[i]);
        // 写前持久化，超时或退出也保留本批 before/after，绝不自动重放。
        this.task.attempted = i + 1;
        await this.save();
        const result = await this.batch(context, { op: "write", ...batch });
        if (result.completed !== batch.writes.length) throw Error("写入回执不完整");
        this.task.applied = i + 1;
        this.task.progress.completed = i + 1;
        await this.save();
      }
    }, "done", context);
  }
  async revoke(args) {
    await this.require(args, ["done", "interrupted"]);
    if (!this.task.attempted || args.confirmed !== true) throw Error("没有可撤销写入，或尚未确认撤销");
    const context = await this.context("target"), plan = this.task.plan;
    if (context.probe.dimension !== plan.dimension) throw Error("请回到导入时的目标维度再撤销");
    return this.begin("undoing", async () => {
      const batches = await readData(this.directory(), plan.manifest);
      this.task.progress.total = this.task.attempted;
      while (this.task.attempted) {
        const batch = await readData(this.directory(), batches[this.task.attempted - 1]);
        const result = await this.batch(context, { op: "undo", ...batch });
        if (result.completed !== batch.writes.length) throw Error("撤销回执不完整");
        this.task.attempted--;
        this.task.progress.completed++;
        await this.save();
      }
    }, "undone", context);
  }
  async stop(args) {
    if (args.taskId !== this.task?.id) throw Error("任务已变化");
    this.controller?.abort();
    await this.job;
    return this.state();
  }
  async dispose() {
    this.disposed = true;
    this.controller?.abort();
    await this.job;
  }
}
module.exports = { ArchitectureImport };
