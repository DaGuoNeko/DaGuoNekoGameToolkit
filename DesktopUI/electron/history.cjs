const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { once } = require("node:events");
const { logQuery, importantMessage } = require("../src/log-search.cjs");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const formatLine = (line) => `[${line.time}] [${line.stream}] ${line.text}\n`;

class SessionHistory {
  constructor(directory, report) {
    this.directory = directory;
    this.report = report;
    this.stream = null;
    this.finishing = Promise.resolve();
    this.queries = new Map();
  }
  file(id, extension = "log") {
    if (typeof id !== "string" || !uuid.test(id)) throw Error("无效历史会话");
    return path.join(this.directory, id + "." + extension);
  }
  async begin(metadata) {
    await this.finish();
    await fsp.mkdir(this.directory, { recursive: true });
    await fsp.writeFile(
      this.file(metadata.id, "json"),
      JSON.stringify(metadata),
      { flag: "wx" },
    );
    this.bytes = 0;
    this.limited = false;
    this.stream = fs.createWriteStream(this.file(metadata.id), {
      flags: "wx",
      encoding: "utf8",
    });
    this.stream.on("error", (error) =>
      this.report("历史日志写入失败：" + error.message),
    );
    await once(this.stream, "open");
  }
  append(entry) {
    if (!this.stream || this.stream.destroyed || this.limited) return;
    const line = formatLine(entry);
    const bytes = Buffer.byteLength(line);
    if (
      this.bytes + bytes > 50 * 1024 * 1024 ||
      this.stream.writableLength > 4 * 1024 * 1024
    ) {
      this.limited = true;
      this.stream.write(
        "[system] 历史记录达到大小或写入缓冲上限，后续输出仅在实时窗口显示。\n",
      );
      this.report(
        "本次历史日志已达到 50 MB 或写入缓冲上限；实时日志继续显示。",
      );
      return;
    }
    this.bytes += bytes;
    this.stream.write(line);
  }
  finish() {
    if (!this.stream) return this.finishing;
    const stream = this.stream;
    this.stream = null;
    this.finishing = new Promise((resolve) => {
      if (stream.closed) return resolve();
      stream.once("close", resolve);
      stream.end();
    });
    return this.finishing;
  }
  async flush() {
    const stream = this.stream;
    if (stream && !stream.destroyed)
      await new Promise((resolve, reject) =>
        stream.write("", (e) => (e ? reject(e) : resolve())),
      );
    await this.finishing;
  }
  async list() {
    let names;
    try {
      names = await fsp.readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const name of names.filter(
      (name) => name.endsWith(".json") && uuid.test(name.slice(0, -5)),
    )) {
      try {
        const metadata = JSON.parse(
          await fsp.readFile(path.join(this.directory, name), "utf8"),
        );
        const id = name.slice(0, -5);
        const stat = await fsp.stat(this.file(id));
        result.push({ ...metadata, id, bytes: stat.size });
      } catch (error) {
        if (!(error instanceof SyntaxError) && error.code !== "ENOENT")
          throw error;
      }
    }
    return result
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 100);
  }
  async read(id) {
    const { logs, total } = await this.query(id);
    return { logs, total };
  }
  async query(id, options = {}, limit = 2000) {
    const filter = logQuery(options),
      before = options.before;
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
      throw Error("日志分页位置无效");
    const file = this.file(id);
    await this.flush();
    let stat;
    try {
      stat = await fsp.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          logs: [],
          total: 0,
          matched: 0,
          hasOlder: false,
          missing: true,
        };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 52 * 1024 * 1024)
      throw Error("历史日志不是有效的有界普通文件");
    if (
      (await fsp.realpath(file)).toLowerCase() !==
      path.resolve(file).toLowerCase()
    )
      throw Error("历史日志路径已重定向");
    const key = JSON.stringify([
      id,
      filter.query,
      filter.level,
      filter.caseSensitive,
      before,
      limit,
    ]);
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const previous = this.queries.get(key);
    if (previous?.stamp === stamp) return previous.value;
    const value = this.scan(file, stat.size, filter, before, limit);
    this.queries.set(key, { stamp, value });
    while (this.queries.size > 8)
      this.queries.delete(this.queries.keys().next().value);
    try {
      return await value;
    } catch (error) {
      if (this.queries.get(key)?.value === value) this.queries.delete(key);
      throw error;
    }
  }
  async scan(file, size, filter, before, limit) {
    if (!size) return { logs: [], total: 0, matched: 0, hasOlder: false };
    const stream = fs.createReadStream(file, {
      encoding: "utf8",
      end: size - 1,
    });
    const lines = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    const tail = [];
    const groups = filter.level === "important" ? new Map() : null;
    let index = 0,
      matched = 0,
      eligible = 0;
    try {
      for await (const line of lines) {
        const match = /^\[([^\]]+)\] \[([^\]]+)\] (.*)$/.exec(line);
        const entry = {
          id: ++index,
          time: match?.[1] || "",
          stream: match?.[2] || "system",
          text: match?.[3] ?? line,
        };
        if (!filter.matches(entry)) continue;
        matched++;
        if (groups) {
          const text = importantMessage(entry),
            previous = groups.get(text);
          if (previous) {
            previous.occurrences++;
            previous.lastSeen = entry.time;
          } else
            groups.set(text, {
              ...entry,
              text,
              occurrences: 1,
              firstSeen: entry.time,
              lastSeen: entry.time,
            });
          continue;
        }
        if (before !== undefined && entry.id >= before) continue;
        eligible++;
        tail.push(entry);
        if (tail.length > limit * 2) tail.splice(0, limit);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (groups) {
      const messages = [...groups.values()];
      const available =
        before === undefined
          ? messages
          : messages.filter((entry) => entry.id < before);
      return {
        logs: available.slice(-limit),
        total: index,
        matched: messages.length,
        occurrences: matched,
        hasOlder: available.length > limit,
      };
    }
    return {
      logs: tail.slice(-limit),
      total: index,
      matched,
      hasOlder: eligible > limit,
    };
  }
  async export(id, target) {
    const source = this.file(id);
    if (
      path
        .resolve(target)
        .toLowerCase()
        .startsWith(path.resolve(this.directory).toLowerCase() + path.sep)
    )
      throw Error("请导出到历史日志目录以外的位置");
    await this.flush();
    await fsp.copyFile(source, target);
  }
  async deletionFiles(id) {
    const files = [this.file(id), this.file(id, "json")];
    try {
      const real = await fsp.realpath(this.directory);
      if (
        path.resolve(real).toLowerCase() !==
        path.resolve(this.directory).toLowerCase()
      )
        throw Error("日志目录已重定向，拒绝删除");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const result = [];
    for (const file of files) {
      try {
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw Error("历史日志不是普通文件，拒绝删除：" + path.basename(file));
        result.push({ file, bytes: stat.size });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return result;
  }
  async deletionCandidates() {
    let names;
    try {
      names = await fsp.readdir(this.directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    // Include old entries beyond the display cap and interrupted log/metadata
    // pairs, but never infer a deletion path from metadata contents.
    return [
      ...new Set(
        names
          .filter((name) => /\.(log|json)$/.test(name))
          .map((name) => name.replace(/\.(log|json)$/, ""))
          .filter((id) => uuid.test(id)),
      ),
    ];
  }
  async remove(id) {
    const files = await this.deletionFiles(id);
    for (const { file } of files) {
      try {
        await fsp.unlink(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return files.length > 0;
  }
}
module.exports = { SessionHistory, formatLine };
