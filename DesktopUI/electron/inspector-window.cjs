const { BrowserWindow } = require("electron");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { applyCache } = require("../src/inspector-cache.cjs");

const inspectorMethods = new Set([
  "bootstrap",
  "debug.state",
  "debug.refresh",
  "debug.ui",
  "debug.copy-path",
  "inspector.state",
  "inspector.cache",
  "inspector.selected",
  "inspector.close",
  "inspector.command-result",
  "window.state",
  "window.control",
  "window.dirty",
]);
function validateEntries(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length > 30 ||
    Buffer.byteLength(JSON.stringify(entries)) > 8 * 1024 * 1024
  )
    throw Error("调试工作区过大，无法交接到独立窗口");
  for (const entry of entries)
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length > 200 ||
      !entry[1] ||
      typeof entry[1] !== "object" ||
      Array.isArray(entry[1])
    )
      throw Error("无效调试工作区");
}
class InspectorWindow {
  constructor(main, debuggerService, directory, theme) {
    this.main = main;
    this.debug = debuggerService;
    this.directory = directory;
    this.theme = theme;
    this.window = null;
    this.caches = new Map();
    this.selected = "";
    this.dirty = false;
    this.closing = false;
    this.version = 0;
    this.commands = new Map();
  }
  get open() {
    return !!this.window && !this.window.isDestroyed();
  }
  owns(sender) {
    return this.open ? sender === this.window : sender === this.main;
  }
  state(sender) {
    return {
      version: this.version,
      open: this.open,
      popup: sender === this.window,
      ownerId: String(sender.webContents.id),
      selected: this.selected,
      caches: [...this.caches],
    };
  }
  send(window, event, value) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(event, value);
  }
  announce() {
    this.version++;
    for (const window of [this.main, this.window])
      if (window && !window.isDestroyed())
        this.send(window, "inspector-window", this.state(window));
  }
  save(sender, entries) {
    if (!this.owns(sender)) return false;
    validateEntries(entries);
    const staged = entries.map(([key, patch]) => [
      key,
      applyCache(this.caches.get(key), patch),
    ]);
    for (const [key, value] of staged) this.caches.set(key, value);
    const dirty = [...this.caches.values()].some(
      (value) =>
        Object.keys(value.drafts || {}).length || value.pendingMutation,
    );
    if (sender === this.window) this.dirty = dirty;
    const other = sender === this.main ? this.window : this.main;
    this.send(other, "inspector-cache", entries);
    return true;
  }
  select(sender, selected) {
    if (typeof selected !== "string" || selected.length > 200)
      throw Error("无效会话");
    if (!this.owns(sender) && sender !== this.main) return false;
    if ([...this.caches.values()].some((value) => value.pendingMutation))
      throw Error("请等属性写入完成后切换会话");
    this.selected = selected;
    this.send(
      sender === this.main ? this.window : this.main,
      "inspector-selected",
      selected,
    );
    return true;
  }
  command(sender, args) {
    if (sender !== this.main || !this.open) throw Error("独立窗口尚未就绪");
    if (
      ![
        "refresh",
        "screen",
        "picker",
        "bounds",
        "autoRefresh",
        "clear-old-drafts",
      ].includes(args.action)
    )
      throw Error("不支持的调试设置");
    if (
      typeof args.sessionId !== "string" ||
      !Number.isInteger(args.generation)
    )
      throw Error("无效调试会话");
    if (
      args.action === "screen" &&
      (typeof args.value !== "string" ||
        args.value.length > 512 ||
        args.value.includes("\0"))
    )
      throw Error("无效屏幕");
    if (
      ["picker", "bounds", "autoRefresh"].includes(args.action) &&
      typeof args.value !== "boolean"
    )
      throw Error("无效开关值");
    if (this.commands.size >= 8) throw Error("请等待前一次设置完成");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(id);
        reject(Error("独立窗口设置超时，请检查窗口状态"));
      }, 20000);
      this.commands.set(id, { resolve, reject, timer });
      this.send(this.window, "inspector-command", { ...args, id });
    });
  }
  commandResult(sender, args) {
    if (sender !== this.window) throw Error("无效设置响应");
    const pending = this.commands.get(args.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.commands.delete(args.id);
    if (args.error) pending.reject(Error(String(args.error).slice(0, 1000)));
    else pending.resolve(true);
    return true;
  }
  async launch(sender, args) {
    if (this.opening) return this.opening;
    this.opening = this.create(sender, args);
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }
  async create(sender, args) {
    if (this.open) {
      if (!process.env.DGN_GAME_HEADLESS) {
        this.window.show();
        this.window.focus();
      }
      return this.state(sender);
    }
    if (sender !== this.main) throw Error("只能从工具箱展开调试窗口");
    validateEntries(args.caches);
    if (args.caches.some(([, value]) => value.pendingMutation))
      throw Error("属性请求尚未完成，请稍后展开");
    await this.debug.stopForOwner(String(sender.webContents.id));
    this.caches = new Map(args.caches);
    this.selected = typeof args.selected === "string" ? args.selected : "";
    this.closing = false;
    const child = (this.window = new BrowserWindow({
      title: "UI 调试器 · 大果喵游戏工具箱",
      width: 1100,
      height: 820,
      minWidth: 740,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      icon: path.join(this.directory, "icon.ico"),
      backgroundColor: this.theme(),
      webPreferences: {
        preload: path.join(this.directory, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    }));
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.on("page-title-updated", (event) => event.preventDefault());
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.on("close", (event) => {
      if (this.closing) return;
      event.preventDefault();
      this.send(child, "inspector-close-requested", {});
    });
    child.webContents.on("render-process-gone", () => {
      this.debug
        .stopForOwner(String(child.webContents.id))
        .catch((error) => console.error("Inspector cleanup:", error.message));
      for (const [key, value] of this.caches)
        if (value.pendingMutation)
          this.caches.set(key, {
            ...value,
            pendingMutation: null,
            error: "调试窗口意外关闭，修改结果需要重新读取。",
          });
      this.destroy();
    });
    child.on("closed", () => {
      for (const pending of this.commands.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error("独立窗口已关闭"));
      }
      this.commands.clear();
      if (this.window === child) {
        this.window = null;
        this.dirty = false;
        this.announce();
      }
    });
    child.once("ready-to-show", () => {
      if (!process.env.DGN_GAME_HEADLESS) child.show();
    });
    this.announce();
    try {
      await child.loadURL("app://game-toolkit/index.html?inspector=1");
    } catch (error) {
      this.destroy();
      throw error;
    }
    return this.state(sender);
  }
  async close(sender) {
    if (sender === this.main) {
      if (this.open) this.window.close();
      return true;
    }
    if (sender !== this.window) throw Error("请在独立窗口中收回工作区");
    if ([...this.caches.values()].some((value) => value.pendingMutation))
      throw Error("属性请求尚未完成，请等回读结束后再收回窗口");
    await this.debug.stopForOwner(String(sender.webContents.id));
    this.closing = true;
    sender.close();
    return true;
  }
  destroy() {
    this.closing = true;
    if (this.open) this.window.destroy();
  }
}
module.exports = { InspectorWindow, inspectorMethods };
