const fs = require("node:fs/promises"),
  path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn, execFile } = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const { atomicWrite } = require("./services.cjs");
const { TracyWindow } = require("./tracy-window.cjs");
const ps = path.join(
  process.env.SystemRoot,
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function discoverExecutables() {
  const { stdout } = await exec(
    ps,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name = 'tracy-profiler.exe'\" | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 10000 },
  );
  return [
    ...(stdout.trim() ? [].concat(JSON.parse(stdout)).filter(Boolean) : []),
    "D:/MCStudio/tracy/tracy-profiler.exe",
    "C:/MCStudio/tracy/tracy-profiler.exe",
  ];
}
function parseConnections(stdout) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const c = line.trim().split(/\s+/),
      local = /:(\d+)$/.exec(c[1] || ""),
      remote = /:(\d+)$/.exec(c[2] || "");
    if (c[0] !== "TCP" || !local || !remote) return [];
    return [
      {
        localPort: +local[1],
        remotePort: +remote[1],
        pid: Number(c[4]),
        state: c[3],
      },
    ];
  });
}
async function connections() {
  const { stdout } = await exec(
    path.join(process.env.SystemRoot, "System32/netstat.exe"),
    ["-ano", "-p", "tcp"],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseConnections(stdout);
}
async function assertPortFree(gamePid, port, read = connections) {
  const rows = await read();
  if (
    !rows.some(
      (r) =>
        r.pid === gamePid &&
        r.localPort === port &&
        ["LISTENING", "侦听"].includes(r.state),
    )
  )
    throw Error("所选游戏的 Tracy 端口已消失，请刷新会话");
  if (
    rows.some(
      (r) =>
        r.pid === gamePid &&
        r.localPort === port &&
        ["ESTABLISHED", "已建立"].includes(r.state),
    )
  )
    throw Error(
      "此游戏已有 Tracy 连接，请先在现有分析器断开或结束 Native 采样；不会抢占连接",
    );
}
class TracyProfiler extends EventEmitter {
  constructor(root, runtime, debug, options = {}) {
    super();
    Object.assign(this, { root, runtime, debug });
    this.spawn = options.spawn || spawn;
    this.discover = options.discover || discoverExecutables;
    this.readConnections = options.connections || connections;
    this.createWindow =
      options.createWindow || (() => new TracyWindow(runtime));
    this.queue = Promise.resolve();
    this.generation = 0;
    this.state = { phase: "stopped", mode: "embedded", message: "" };
  }
  snapshot() {
    return {
      ...this.state,
      generation: this.generation,
      pid: this.child?.pid || null,
      executable: this.executable || null,
    };
  }
  publish(patch) {
    Object.assign(this.state, patch);
    this.emit("state", this.snapshot());
    return this.snapshot();
  }
  run(fn) {
    const op = this.queue.then(fn);
    this.queue = op.catch(() => {});
    return op;
  }
  async validateExe(file) {
    if (
      typeof file !== "string" ||
      !path.isAbsolute(file) ||
      path.basename(file).toLowerCase() !== "tracy-profiler.exe"
    )
      throw Error("请选择 tracy-profiler.exe");
    const s = await fs.lstat(file);
    if (!s.isFile() || s.isSymbolicLink())
      throw Error("Tracy 程序必须为普通文件");
    return fs.realpath(file);
  }
  async resolveExe() {
    if (this.executable) return this.validateExe(this.executable);
    try {
      const c = JSON.parse(
        await fs.readFile(path.join(this.root, "tracy-profiler.json"), "utf8"),
      );
      this.executable = await this.validateExe(c.path);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!this.executable)
      for (const candidate of await this.discover()) {
        try {
          this.executable = await this.validateExe(candidate);
          break;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
    if (!this.executable)
      throw Error(
        "未找到官方 Tracy，请选择 MCStudio/tracy/tracy-profiler.exe（建议 0.11.1）",
      );
    return this.executable;
  }
  configure(file) {
    return this.run(async () => {
      this.executable = await this.validateExe(file);
      await atomicWrite(
        path.join(this.root, "tracy-profiler.json"),
        JSON.stringify({ path: this.executable }),
      );
      return this.publish({});
    });
  }
  async ensureFree(session, port) {
    if (
      [...this.debug.profiles.values()].some(
        (p) =>
          p.kind === "native" &&
          p.sessionId === session.id &&
          ["starting", "running", "collecting"].includes(p.status),
      )
    )
      throw Error("请先结束该会话的 Native 采样");
    await assertPortFree(session.minecraftPid, port, this.readConnections);
  }
  start(args, host) {
    return this.run(async () => {
      if (this.child)
        throw Error("已有 Tracy 窗口，请先保存并关闭后再打开另一份分析");
      const exe = await this.resolveExe();
      let argv = [],
        target = null;
      if (args.traceFile) {
        const stat = await fs.lstat(args.traceFile);
        if (
          !path.isAbsolute(args.traceFile) ||
          !/\.tracy$/i.test(args.traceFile) ||
          !stat.isFile() ||
          stat.isSymbolicLink()
        )
          throw Error("请选择有效的 .tracy 文件");
        argv = [args.traceFile];
      } else if (args.sessionId) {
        const session = this.debug.session(
          args.sessionId,
          args.generation,
          false,
        );
        const ports = (await this.debug.discoverPorts()).filter(
          (p) => p.pid === session.minecraftPid,
        );
        if (!ports.length)
          throw Error("所选游戏没有 Tracy 监听端口（8086–8105）");
        if (ports.length > 1)
          throw Error("该游戏有多个 Tracy 端口，请先在官方分析器检查目标");
        const port = ports[0].port;
        this.pendingGamePid = session.minecraftPid;
        try {
          await this.ensureFree(session, port);
          this.debug.session(args.sessionId, args.generation, false);
        } finally {
          this.pendingGamePid = null;
        }
        target = {
          sessionId: session.id,
          gamePid: session.minecraftPid,
          port,
          label: session.profileName || "游戏 PID " + session.minecraftPid,
        };
        argv = ["-a", "127.0.0.1", "-p", String(port)];
      }
      this.generation++;
      this.lastRect = null;
      this.publish({
        phase: "starting",
        mode: "embedded",
        target,
        traceFile: args.traceFile || null,
        message: "正在打开官方 Tracy…",
      });
      const child = this.spawn(exe, argv, {
        cwd: path.dirname(exe),
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) {
          this.unbind();
          this.child = null;
          this.native = null;
          this.publish({
            phase: "stopped",
            message: "Tracy 已关闭",
            target: null,
          });
        }
      });
      try {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
        this.native = this.createWindow();
        let hwnd = 0;
        for (let i = 0; i < 100; i++) {
          if (this.child !== child) throw Error("Tracy 在打开窗口前退出");
          hwnd = this.native.find(child.pid);
          if (hwnd) break;
          await delay(100);
        }
        if (!hwnd)
          throw Error("未找到 Tracy 主窗口，已保留独立进程，请检查官方程序");
        if (this.retiring || host.isDestroyed())
          throw Error("工具箱正在退出，Tracy 保留为独立窗口");
        this.native.attach(hwnd, child.pid, host);
        this.host = host;
        this.restore = () => this.scheduleBounds();
        for (const event of [
          "show",
          "restore",
          "move",
          "resize",
          "minimize",
          "hide",
        ])
          host.on(event, this.restore);
        return this.publish({
          phase: "open",
          message: "官方窗口已打开；连接状态与采样结果以 Tracy 内部显示为准",
        });
      } catch (e) {
        if (!child.pid) this.child = null;
        if (this.native?.host) this.native.detach();
        this.publish({
          phase: this.child ? "external" : "stopped",
          mode: "external",
          message: e.message,
        });
        throw e;
      }
    });
  }
  unbind() {
    clearTimeout(this.boundsTimer);
    this.boundsTimer = null;
    if (this.host && this.restore)
      for (const event of [
        "show",
        "restore",
        "move",
        "resize",
        "minimize",
        "hide",
      ])
        this.host.removeListener(event, this.restore);
    this.host = null;
    this.restore = null;
  }
  bounds({ generation, rect }) {
    if (
      this.retiring ||
      generation !== this.generation ||
      this.state.mode !== "embedded"
    )
      return;
    this.lastRect = rect;
    this.scheduleBounds();
  }
  scheduleBounds() {
    if (this.retiring || !this.host || this.state.mode !== "embedded") return;
    const immediate =
      !this.lastRect || !this.host.isVisible() || this.host.isMinimized();
    if (immediate) {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = null;
      this.flushBounds();
    } else if (!this.boundsTimer) {
      this.boundsTimer = setTimeout(() => {
        this.boundsTimer = null;
        this.flushBounds();
      }, 16);
    }
  }
  flushBounds() {
    if (this.retiring || !this.host || this.state.mode !== "embedded") return;
    try {
      this.native?.bounds(this.lastRect, this.host);
    } catch (error) {
      this.publish({ message: "Tracy 窗口同步失败：" + error.message });
    }
  }
  mode(args, host) {
    return this.run(async () => {
      if (
        args.generation !== this.generation ||
        !this.child ||
        !this.native?.hwnd
      )
        throw Error("Tracy 窗口已变化，请刷新");
      if (!["embedded", "external"].includes(args.mode))
        throw Error("无效窗口模式");
      if (args.mode === this.state.mode) return this.snapshot();
      if (args.mode === "external") {
        clearTimeout(this.boundsTimer);
        this.boundsTimer = null;
        this.native.detach();
      } else {
        this.native.attach(this.native.hwnd, this.child.pid, host);
        this.native.bounds(this.lastRect, host);
      }
      return this.publish({ mode: args.mode });
    });
  }
  close(args) {
    return this.run(async () => {
      if (!this.child) return this.snapshot();
      if (args.generation !== this.generation || args.confirmed !== true)
        throw Error("请确认已保存 Tracy 分析数据");
      if (!this.native?.hwnd) throw Error("请在独立 Tracy 窗口中关闭分析器");
      this.native.detach();
      this.publish({ mode: "external" });
      this.native.requestClose();
      return this.publish({
        message:
          "已请求关闭；若 Tracy 弹出保存提示，请在独立窗口完成。游戏不会关闭。",
      });
    });
  }
  prepareExit() {
    this.retiring = true;
    this.native?.detach();
    this.unbind();
  }
  async dispose() {
    await this.queue;
    // Keep unexported capture data alive in an ordinary window on app exit.
    this.prepareExit();
    this.child?.unref();
    this.child = null;
    this.native = null;
  }
}
module.exports = { TracyProfiler, assertPortFree, parseConnections };
