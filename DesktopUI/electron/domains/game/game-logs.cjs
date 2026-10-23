const fs = require("node:fs/promises");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { SessionHistory } = require("./history.cjs");
const logName =
  /^(ContentLog|Debug_Log)\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(_\d+)?\.txt$/;
const CHUNK = 256 * 1024,
  INITIAL = 1024 * 1024;

async function ownedLogFiles(
  runtime,
  directory,
  worker,
  identity,
  exec = execFile,
) {
  let stdout;
  try {
    ({ stdout } = await exec(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(runtime, "automation/content-log-owner.ps1"),
        "-GameProcessId",
        String(identity.pid),
        "-LauncherProcessId",
        String(worker.session.pid),
        "-GamePath",
        path.resolve(worker.sourceSnapshot.config.game_executable_path),
        "-Directory",
        directory,
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 32768 },
    ));
  } catch (error) {
    stdout = error.stdout;
    if (!stdout) throw Error("原版日志归属检查失败：" + error.message);
  }
  const result = JSON.parse(stdout);
  if (!result.ok) throw Error("原版日志归属检查失败：" + result.error);
  if (
    !Array.isArray(result.files) ||
    result.files.length > 32 ||
    !result.files.every(
      (name) => typeof name === "string" && logName.test(name),
    ) ||
    !Number.isFinite(Date.parse(result.startedAt))
  )
    throw Error("原版日志助手返回了无效路径或进程身份");
  return result;
}

class GameLogs {
  constructor({
    directory,
    archiveDirectory,
    runtime,
    workers,
    identity,
    discover = ownedLogFiles,
    interval = 1000,
    discoveryInterval = 10000,
  }) {
    Object.assign(this, {
      directory,
      runtime,
      workers,
      identity,
      discover,
      interval,
      discoveryInterval,
    });
    this.archive = new SessionHistory(archiveDirectory, () => {});
    this.records = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.timer = setInterval(
      () =>
        this.tick().catch((error) => {
          this.error = error.message;
        }),
      interval,
    );
    this.timer.unref();
  }
  run(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  record(worker) {
    const id = worker.session.id;
    if (!this.records.has(id)) {
      const r = {
        id,
        logs: [],
        streams: { content: [], engine: [], system: [] },
        serial: 0,
        epoch: 0,
        files: new Map(),
        cursors: new Map(),
        phase: "waiting",
        message: "等待游戏打开内容日志文件",
        discoveredAt: 0,
        initialized: false,
        finished: false,
      };
      r.history = new SessionHistory(this.archive.directory, (message) => {
        r.error = message;
      });
      this.records.set(id, r);
    }
    return this.records.get(id);
  }
  snapshot(id, level = "all") {
    if (!["all", "content", "engine", "system", "errors"].includes(level))
      throw Error("无效原版日志类型");
    const r = this.records.get(id);
    return {
      sessionId: id,
      level,
      logs: (r?.streams[level] || r?.logs)?.slice(-2000) || [],
      epoch: r?.epoch || 0,
      revision: r?.serial || 0,
      phase: r?.phase || "waiting",
      message:
        r?.message ||
        "等待本客户端的原版日志；请在游戏的创作者设置中开启内容日志文件。",
      files: r ? [...r.files.keys()] : [],
      error: r?.error || this.error || "",
    };
  }
  append(r, stream, text) {
    if (!text.trim()) return;
    const entry = {
      id: ++r.serial,
      time: new Date().toISOString(),
      stream,
      text: text.replace(/\0/g, "").slice(0, 16384),
    };
    r.logs.push(entry);
    if (r.logs.length > 4000) r.logs.splice(0, r.logs.length - 2000);
    const group = r.streams[stream];
    if (group) {
      group.push(entry);
      if (group.length > 4000) group.splice(0, group.length - 2000);
    }
    r.history.append(entry);
  }
  async openFile(name, owner, cursor, directory = this.directory) {
    if (!logName.test(name)) throw Error("原版日志文件名无效");
    const root = await fs.realpath(directory),
      file = path.join(directory, name);
    if (
      path.resolve(root).toLowerCase() !== path.resolve(directory).toLowerCase()
    )
      throw Error("原版日志目录已重定向");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("原版日志不是普通文件");
    const handle = await fs.open(file, "r");
    const actual = await handle.stat();
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) {
      await handle.close();
      throw Error("原版日志在打开时已变化");
    }
    const offset = Math.max(0, actual.size - INITIAL);
    if (cursor && cursor.ino === actual.ino && cursor.dev === actual.dev)
      return { ...cursor, handle };
    return {
      handle,
      offset,
      skip: offset > 0,
      pending: "",
      decoder: new StringDecoder("utf8"),
      owner,
      kind: name.startsWith("ContentLog") ? "content" : "engine",
      ino: actual.ino,
      dev: actual.dev,
    };
  }
  async read(r, file, final = false) {
    const stat = await file.handle.stat();
    if (stat.size < file.offset) {
      file.offset = 0;
      file.pending = "";
      file.decoder = new StringDecoder("utf8");
      file.skip = false;
      this.append(r, "system", "原版日志被截断，已从文件开头继续读取。");
    }
    // Bounded reads avoid blocking on very large native debug logs.
    const count = Math.min(CHUNK, Math.max(0, stat.size - file.offset));
    if (count) {
      const buffer = Buffer.alloc(count);
      const { bytesRead } = await file.handle.read(
        buffer,
        0,
        count,
        file.offset,
      );
      file.offset += bytesRead;
      file.pending += file.decoder.write(buffer.subarray(0, bytesRead));
      const lines = file.pending.split(/\r?\n/);
      file.pending = lines.pop();
      for (const line of lines) {
        if (file.skip) {
          file.skip = false;
          continue;
        }
        this.append(r, file.kind, line);
      }
      if (file.pending.length > 16384) {
        this.append(r, file.kind, file.pending);
        file.pending = "";
        file.skip = false;
      }
    }
    if (final && file.offset >= stat.size) {
      this.append(r, file.kind, file.pending + file.decoder.end());
      file.pending = "";
    }
    if (r.logs.length > 2000) r.logs.splice(0, r.logs.length - 2000);
  }
  async closeFiles(r) {
    for (const [name, f] of r.files) {
      r.cursors.set(name, { ...f, handle: undefined });
      await f.handle.close();
    }
    r.files.clear();
  }
  tick() {
    // Skip queued timer ticks when a process query is still in flight.
    if (this.closed || this.ticking) return Promise.resolve();
    this.ticking = true;
    return this.run(async () => {
      for (const worker of this.workers()) {
        if (this.closed) break;
        if (!worker.session) continue;
        let r = this.records.get(worker.session.id);
        if (!worker.session.running) {
          if (r && !r.finished) await this.finishRecord(r);
          continue;
        }
        r = this.record(worker);
        if (r.finished) continue;
        try {
          const identity = this.identity(worker);
          if (!identity) {
            r.message = "等待本客户端的游戏进程身份";
            continue;
          }
          const signature = JSON.stringify(identity);
          if (r.signature && signature !== r.signature) {
            await this.closeFiles(r);
            r.phase = "error";
            r.message = "客户端进程身份已变化，已停止原版日志采集";
            r.finished = true;
            await r.history.finish();
            continue;
          }
          if (Date.now() - r.discoveredAt >= this.discoveryInterval) {
            r.discoveredAt = Date.now();
            let directory = r.directory || this.directory;
            let owned = await this.discover(
              this.runtime,
              directory,
              worker,
              identity,
            );
            const privateDirectory =
              worker.worlds?.appDataOverride &&
              path.join(
                worker.worlds.appDataOverride,
                "MinecraftPE_Netease",
                "logs",
              );
            if (!owned.files.length) {
              for (const candidate of [
                ...new Set([this.directory, privateDirectory].filter(Boolean)),
              ]) {
                if (candidate === directory) continue;
                const alternate = await this.discover(
                  this.runtime,
                  candidate,
                  worker,
                  identity,
                );
                if (alternate.files.length) {
                  owned = alternate;
                  directory = candidate;
                  break;
                }
              }
            }
            if (
              this.closed ||
              !worker.session.running ||
              JSON.stringify(this.identity(worker)) !== signature
            )
              continue;
            if (r.startedAt && r.startedAt !== owned.startedAt)
              throw Error("原版日志的进程创建时间已变化");
            r.startedAt = owned.startedAt;
            r.signature = signature;
            if (r.directory && directory !== r.directory) {
              await this.closeFiles(r);
              r.cursors.clear();
            }
            r.directory = directory;
            if (owned.files.length && !r.initialized) {
              await r.history.begin({
                id: r.id,
                projectId: worker.session.projectId,
                projectName: worker.session.projectName,
                worldId: worker.session.worldId,
                worldName: worker.session.worldName,
                startedAt: worker.session.startedAt,
                channel: "game",
              });
              r.initialized = true;
            }
            for (const [name, f] of r.files) {
              if (!owned.files.includes(name)) {
                await this.read(r, f, true);
                r.cursors.set(name, { ...f, handle: undefined });
                await f.handle.close();
                r.files.delete(name);
              }
            }
            for (const name of owned.files) {
              const previous = r.files.get(name);
              if (previous) {
                const current = await fs.lstat(path.join(directory, name));
                if (!current.isFile() || current.isSymbolicLink())
                  throw Error("原版日志路径已变化");
                if (
                  current.ino === previous.ino &&
                  current.dev === previous.dev
                )
                  continue;
                await this.read(r, previous, true);
                await previous.handle.close();
                r.files.delete(name);
                r.cursors.delete(name);
              }
              const f = await this.openFile(
                name,
                owned.startedAt,
                r.cursors.get(name),
                directory,
              );
              r.files.set(name, f);
              this.append(
                r,
                "system",
                "已按游戏 PID 确认日志来源：" +
                  name +
                  (f.offset ? "（文件较大，从末尾 1 MiB 开始读取）" : ""),
              );
            }
            r.error = "";
            r.phase = r.files.size ? "capturing" : "waiting";
            r.message = r.files.size
              ? "正在读取本客户端的原版内容 / 引擎日志"
              : "游戏尚未打开日志文件，请在创作者设置中开启内容日志文件。";
          }
          for (const file of r.files.values()) await this.read(r, file);
        } catch (error) {
          r.phase = "error";
          r.message = error.message;
          await this.closeFiles(r);
        }
      }
    }).finally(() => {
      this.ticking = false;
    });
  }
  async finishRecord(r) {
    if (r.finished) return;
    try {
      for (const f of r.files.values()) {
        for (let i = 0; i < 4; i++) {
          await this.read(r, f, true);
          if (f.offset >= (await f.handle.stat()).size) break;
        }
        if (f.offset < (await f.handle.stat()).size)
          this.append(
            r,
            "system",
            "退出时日志增长过快，尾部未全部归档；原始文件保留在游戏日志目录。",
          );
      }
    } catch (error) {
      r.error = error.message;
    } finally {
      await this.closeFiles(r);
      await r.history.finish();
      r.finished = true;
      r.phase = "ended";
      r.message = "客户端已结束，显示已采集的原版日志";
    }
  }
  finish(id) {
    return this.run(async () => {
      const r = this.records.get(id);
      if (r) await this.finishRecord(r);
    });
  }
  clear(id) {
    const r = this.records.get(id);
    if (r) {
      r.logs = [];
      r.streams = { content: [], engine: [], system: [] };
      r.epoch++;
    }
  }
  async forget(id) {
    await this.finish(id);
    this.records.delete(id);
  }
  async dispose() {
    this.closed = true;
    clearInterval(this.timer);
    await this.run(async () => {
      for (const r of this.records.values()) await this.finishRecord(r);
    });
  }
}
module.exports = { GameLogs, ownedLogFiles, logName };
