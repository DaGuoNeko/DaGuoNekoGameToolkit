const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const tracked = new Set([
  "settings.update", "project.save", "projects.add", "projects.remove", "projects.relocate", "project.backup", "profiles.create", "profiles.rename", "profiles.remove",
  "ui-editor.save", "ui-editor.save-as", "game-options.save",
  "mods.save", "mods.remove", "mods.import-profiles", "mods.add-directories",
  "worlds.create", "worlds.update", "worlds.import", "worlds.rename", "worlds.recycle",
  "worlds.restore", "worlds.purge", "worlds.sync-pack-versions", "worlds.rebind-pack-uuids",
  "worlds.edit-pack", "worlds.copy", "worlds.select", "launch.start", "launch.quick", "launch.blank", "launch.joined",
  "launch.stop", "debug.reload", "debug.restartLatest", "debug.execute", "world-actions.run",
  "architecture.prepare", "architecture.start-source", "architecture.save-source", "architecture.source-done", "architecture.stop",
  "architecture.start-target", "architecture.preview", "architecture.paste", "architecture.revoke",
  "map-preview.render", "rooms.create", "rooms.join", "rooms.close", "rooms.retry", "rooms.revoke", "rooms.invite", "world-actions.save", "world-actions.cancel", "update.check", "update.history", "update.download", "update.install",
]);

function label(method) {
  return {
    "worlds.import": "导入存档", "worlds.recycle": "移入回收站", "worlds.restore": "恢复存档",
    "worlds.purge": "永久删除存档", "worlds.create": "创建存档", "worlds.update": "保存存档设置",
    "launch.start": "启动游戏", "launch.stop": "停止游戏", "map-preview.render": "生成地图预览",
    "architecture.prepare": "准备地形导入", "architecture.paste": "写入地形导入",
  }[method] || method;
}

class ActivityCenter extends EventEmitter {
  constructor(dataRoot, { dedupeWindowMs = 5000, maxFileBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.directory = path.join(dataRoot, "logs", "activity");
    this.file = path.join(this.directory, "events.jsonl");
    this.events = [];
    this.tasks = new Map();
    this.queue = Promise.resolve();
    this.recent = new Map();
    this.dedupeWindowMs = dedupeWindowMs;
    this.maxFileBytes = maxFileBytes;
    this.persistenceError = "";
  }
  eventKey(value) {
    return [value.method, value.level, value.projectId || "", value.source || "", value.message].join("\0");
  }
  async load() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-5000)) {
        try {
          const value = JSON.parse(line);
          if (value.kind === "task") this.tasks.set(value.task.id, value.task);
          else if (value.kind === "event") this.events.push(value.event);
          else if (value.kind === "event-update") {
            const event = this.events.find((item) => item.id === value.event.id);
            if (event) Object.assign(event, value.event);
          }
        } catch { /* 保留可读性：损坏行不阻止工具箱启动。 */ }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const now = Date.now();
    for (const event of this.events) {
      const time = Date.parse(event.lastTime || event.time);
      if (Number.isFinite(time) && now - time < this.dedupeWindowMs)
        this.recent.set(this.eventKey(event), event);
    }
  }
  async compact() {
    const temporary = this.file + ".compact-" + crypto.randomUUID() + ".tmp";
    const lines = [
      ...this.tasks.values()].map((task) => JSON.stringify({ kind: "task", task }));
    lines.push(...this.events.slice(-3000).map((event) => JSON.stringify({ kind: "event", event })));
    try {
      await fs.writeFile(temporary, lines.length ? lines.join("\n") + "\n" : "", "utf8");
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async append(value) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(this.file, JSON.stringify(value) + "\n", "utf8");
      if ((await fs.stat(this.file)).size > this.maxFileBytes) await this.compact();
    });
    return this.queue.catch((error) => {
      this.persistenceError = "项目日志写盘失败：" + (error.message || String(error));
      this.emitState();
      throw error;
    });
  }
  emitState() {
    this.emit("state", this.snapshot());
  }
  event({ method, level = "info", message, projectId = null, operationId = null, source = "ui", details = null }) {
    const now = new Date().toISOString();
    const key = [method, level, projectId || "", source || "", message].join("\0");
    const previous = level === "error" ? this.recent.get(key) : null;
    if (previous && Date.parse(previous.lastTime || previous.time) + this.dedupeWindowMs >= Date.now()) {
      previous.repeatCount = (previous.repeatCount || 1) + 1;
      previous.lastTime = now;
      this.append({ kind: "event-update", event: { id: previous.id, repeatCount: previous.repeatCount, lastTime: previous.lastTime } }).catch(() => {});
      this.emitState();
      return previous;
    }
    const value = { id: crypto.randomUUID(), time: now, lastTime: now, repeatCount: 1, method, level, message, projectId, operationId, source, ...(details ? { details } : {}) };
    if (level === "error") this.recent.set(key, value);
    this.persistenceError = "";
    this.events.push(value);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    this.append({ kind: "event", event: value }).catch(() => {});
    this.emitState();
    return value;
  }
  start(method, meta = {}) {
    const task = {
      id: crypto.randomUUID(), method, title: meta.title || label(method), projectId: meta.projectId || null,
      source: meta.source || "ui", status: "running", completed: null, total: null,
      message: meta.message || "正在处理", startedAt: new Date().toISOString(), finishedAt: null, error: "",
    };
    this.tasks.set(task.id, task);
    this.append({ kind: "task", task }).catch(() => {});
    this.event({ method, level: "info", message: task.message, projectId: task.projectId, operationId: task.id, source: task.source });
    return task;
  }
  update(id, patch = {}) {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, patch);
    this.append({ kind: "task", task }).catch(() => {});
    this.emitState();
  }
  finish(id, status, error = "") {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
    if (status === "success") {
      task.total = Number.isFinite(task.total) && task.total > 0 ? task.total : 1;
      task.completed = task.total;
    }
    task.error = error;
    task.finishedAt = new Date().toISOString();
    task.message = status === "success" ? "已完成" : status === "cancelled" ? "已取消" : error || "执行失败";
    this.append({ kind: "task", task }).catch(() => {});
    this.event({ method: task.method, level: status === "success" ? "info" : "error", message: task.message, projectId: task.projectId, operationId: id, source: task.source });
  }
  background(method, operation, meta = {}) {
    const task = this.start(method, meta);
    Promise.resolve().then(() => operation({
      task,
      update: patch => this.update(task.id, patch),
    })).then(() => this.finish(task.id, "success"), error => this.finish(task.id, "failed", error.message || String(error)));
    return { operationId: task.id };
  }
  snapshot({ projectId = "", level = "all" } = {}) {
    const matches = value => (!projectId || value.projectId === projectId) && (level === "all" || value.level === level);
    return {
      tasks: [...this.tasks.values()].filter(task => !projectId || task.projectId === projectId).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || "")).slice(0, 100),
      events: this.events.filter(matches).slice(-300).reverse(),
      error: this.persistenceError,
    };
  }
  clear() {
    this.events = [];
    this.recent.clear();
    for (const [id, task] of this.tasks) if (["success", "failed", "cancelled", "interrupted"].includes(task.status)) this.tasks.delete(id);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(this.file, [...this.tasks.values()].map(task => JSON.stringify({ kind: "task", task })).join("\n") + (this.tasks.size ? "\n" : ""), "utf8");
    });
    this.emitState();
    return this.snapshot();
  }
  async export(target, filters = {}) {
    const destination = path.resolve(target);
    const directory = path.resolve(this.directory);
    if (destination.toLowerCase().startsWith(directory.toLowerCase() + path.sep))
      throw Error("请导出到项目日志目录以外的位置");
    try {
      const stat = await fs.lstat(destination);
      if (stat.isSymbolicLink() || !stat.isFile()) throw Error("项目日志导出目标不是普通文件");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.flush();
    const value = this.snapshot(filters);
    const lines = [
      `# 大果喵游戏工具箱项目日志 ${new Date().toISOString()}`,
      ...value.tasks.slice().reverse().map((task) =>
        `[${task.finishedAt || task.startedAt || ""}] [task] [${task.status}] ${task.method} ${task.message}${task.error ? ` | ${task.error}` : ""}`,
      ),
      ...value.events.slice().reverse().map((event) =>
        `[${event.time || ""}] [${event.level}] [${event.source || "system"}] ${event.method} ${event.message}${event.repeatCount > 1 ? ` (重复 ${event.repeatCount} 次)` : ""}`,
      ),
    ];
    await fs.writeFile(destination, lines.join("\n") + "\n", "utf8");
    return true;
  }
  async flush() {
    await this.queue.catch(() => {});
  }
  static tracks(method) { return tracked.has(method); }
}

module.exports = { ActivityCenter };
