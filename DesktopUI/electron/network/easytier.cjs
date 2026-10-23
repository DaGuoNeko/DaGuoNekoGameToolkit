const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const { prepareComponents } = require("./components.cjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const powershell = () =>
  path.join(
    process.env.SystemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
async function freePort(host = "127.0.0.1") {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
class EasyTier {
  constructor(runtime, cacheRoot) {
    this.runtime = path.join(runtime, "network");
    this.cacheRoot = cacheRoot;
    this.abort = new AbortController();
    this.queue = Promise.resolve();
    this.stopped = false;
  }
  async verify() {
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.runtime, "manifest.json"), "utf8"),
    );
    const required = [
      "easytier-core.exe",
      "easytier-cli.exe",
      "wintun.dll",
      "WinDivert64.sys",
      "Packet.dll",
      "network-helper.exe",
    ];
    if (
      manifest.version !== "2.7.0-8b7f1f01" ||
      required.some(
        (file) => !/^[a-f0-9]{64}$/.test(manifest.files?.[file] || ""),
      )
    )
      throw Error("网络组件清单不完整，请重新安装完整工具箱");
    for (const [file, expected] of Object.entries(manifest.files)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) throw Error("网络组件清单无效");
      const actual = crypto
        .createHash("sha256")
        .update(await fs.readFile(path.join(this.runtime, file)))
        .digest("hex");
      if (actual !== expected) throw Error("网络组件校验失败：" + file);
    }
    return manifest.version;
  }
  async start(config) {
    if (this.cacheRoot)
      this.runtime = await prepareComponents(
        this.runtime,
        this.cacheRoot,
        this.abort.signal,
      );
    await this.verify();
    if (this.stopped) throw Error("联机操作已取消");
    const pipe = "dgn-network-" + crypto.randomBytes(16).toString("hex"),
      token = crypto.randomBytes(32).toString("hex");
    const { stdout } = await exec(
      powershell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p=Get-Process -Id ${process.pid}; @{ticks=$p.StartTime.ToUniversalTime().Ticks.ToString();sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const identity = JSON.parse(stdout);
    if (this.stopped) throw Error("联机操作已取消");
    try {
      await exec(
        powershell(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(this.runtime, "launch.ps1"),
          "-Helper",
          path.join(this.runtime, "network-helper.exe"),
          "-Pipe",
          pipe,
          "-Token",
          token,
          "-ParentId",
          String(process.pid),
          "-ParentTicks",
          identity.ticks,
          "-Sid",
          identity.sid,
        ],
        { windowsHide: true, timeout: 100000 },
      );
    } catch {
      throw Error("网络组件未获得 Windows 授权，或启动被取消");
    }
    let socket;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      try {
        socket = await new Promise((resolve, reject) => {
          const s = net.connect("\\\\.\\pipe\\" + pipe);
          s.once("error", reject);
          s.once("connect", () => {
            s.removeListener("error", reject);
            resolve(s);
          });
        });
        break;
      } catch (e) {
        if (!["ENOENT", "ECONNREFUSED", "EACCES"].includes(e.code)) throw e;
        await delay(200);
      }
    }
    if (!socket) throw Error("网络助手未就绪，请检查 Windows 安全提示");
    this.socket = socket;
    this.helperConnected = true;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 524288) {
        socket.destroy(Error("网络助手响应过大"));
        return;
      }
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const pending = this.pending;
        this.pending = null;
        if (pending) {
          try {
            pending.resolve(JSON.parse(line));
          } catch (e) {
            pending.reject(e);
          }
        }
      }
    });
    socket.on("error", (e) => {
      this.pending?.reject(e);
      this.pending = null;
    });
    socket.on("close", () => {
      this.pending?.reject(Error("网络助手已断开"));
      this.pending = null;
    });
    const ready = this.receive(10000);
    socket.write(token + "\n");
    await ready;
    if (this.stopped) {
      await this.stop();
      throw Error("联机操作已取消");
    }
    this.instance = config.instance;
    await this.call({ op: "start", ...config, rpcPort: await freePort() });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !this.stopped) {
      try {
        const state = await this.status();
        const address = state.node?.ipv4_addr;
        const expected = config.ip.split(".").slice(0, 3).join(".") + ".";
        const validDynamic =
          config.dynamicIp &&
          typeof address === "string" &&
          address.startsWith(expected) &&
          /^10\.\d+\.\d+\.(?:\d+)\/24$/.test(address) &&
          Number(address.split(".")[3].split("/")[0]) >= 2 &&
          Number(address.split(".")[3].split("/")[0]) <= 254;
        if (
          state.node?.inst_id === config.instance &&
          (validDynamic || (!config.dynamicIp && address === config.ip + "/24"))
        ) {
          await freePort(address.split("/")[0]);
          return state;
        }
      } catch (e) {
        this.lastError = e.message;
      }
      await delay(500);
    }
    await this.stop();
    throw Error("虚拟网络未就绪：" + (this.lastError || "未获得虚拟地址"));
  }
  receive(timeout = 40000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy();
        reject(Error("网络助手响应超时"));
      }, timeout);
      this.pending = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }
  call(data) {
    const op = this.queue.then(async () => {
      if (!this.socket || this.socket.destroyed) throw Error("网络助手未连接");
      const response = this.receive();
      this.socket.write(JSON.stringify(data) + "\n");
      const r = await response;
      if (!r.ok) throw Error(r.error);
      return r.result;
    });
    this.queue = op.catch(() => {});
    return op;
  }
  status() {
    return this.call({ op: "status" });
  }
  invite(id, ttl) {
    return this.call({ op: "invite", id, ttl });
  }
  revoke(id) {
    return this.call({ op: "revoke", id });
  }
  async stop() {
    this.cancel();
    if (this.stopConfirmed) return;
    if (this.socket && !this.socket.destroyed) {
      // Keep a responsive helper connected after a failed cleanup so its
      // remaining owned resources can actually be retried.
      await this.call({ op: "stop" });
      this.stopConfirmed = true;
      this.socket.end();
      this.socket.destroy();
    } else if (this.helperConnected) {
      throw Error(
        "网络助手已断开，未收到清理完成回执；请检查本次网络进程和防火墙规则",
      );
    }
  }
  cancel() {
    this.stopped = true;
    this.abort.abort();
  }
}
module.exports = { EasyTier, freePort, delay };
