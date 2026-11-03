const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const tracked = new Set([
  "settings.update", "project.save", "profiles.create", "profiles.rename", "profiles.remove",
  "mods.save", "mods.remove", "mods.import-profiles", "mods.add-directories",
  "worlds.create", "worlds.update", "worlds.import", "worlds.rename", "worlds.recycle",
  "worlds.restore", "worlds.purge", "worlds.sync-pack-versions", "worlds.rebind-pack-uuids",
  "worlds.edit-pack", "launch.start", "launch.quick", "launch.blank", "launch.joined",
  "launch.stop", "debug.reload", "debug.restartLatest", "debug.execute", "world-actions.run",
  "architecture.prepare", "architecture.start-source", "architecture.save-source", "architecture.source-done",
  "architecture.start-target", "architecture.preview", "architecture.paste", "architecture.revoke",
  "map-preview.render", "rooms.create", "rooms.join", "rooms.close", "rooms.retry", "update.download", "update.install",
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
  constructor(dataRoot) {
    super();
    this.directory = path.join(dataRoot, "logs", "activity");
    this.file = path.join(this.directory, "events.jsonl");
    this.events = [];
    this.tasks = new Map();
    this.queue = Promise.resolve();
  }
  async load() {
    try {
      const text = await fs.readFile(this.file, "utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-5000)) {
        try {
          const value = JSON.parse(line);
          if (value.kind === "task") this.tasks.set(value.task.id, value.task);
          else if (value.kind === "event") this.events.push(value.event);
        } catch { /* 保留可读性：损坏行不阻止工具箱启动。 */ }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async append(value) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(this.file, JSON.stringify(value) + "\n", "utf8");
    });
    return this.queue;
  }
  emitState() {
    this.emit("state", this.snapshot());
  }
  event({ method, level = "info", message, projectId = null, operationId = null, source = "ui", details = null }) {
    const value = { id: crypto.randomUUID(), time: new Date().toISOString(), method, level, message, projectId, operationId, source, ...(details ? { details } : {}) };
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
    };
  }
  clear() {
    this.events = [];
    for (const [id, task] of this.tasks) if (["success", "failed", "cancelled"].includes(task.status)) this.tasks.delete(id);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(this.file, [...this.tasks.values()].map(task => JSON.stringify({ kind: "task", task })).join("\n") + (this.tasks.size ? "\n" : ""), "utf8");
    });
    this.emitState();
    return this.snapshot();
  }
  static tracks(method) { return tracked.has(method); }
}

module.exports = { ActivityCenter };
