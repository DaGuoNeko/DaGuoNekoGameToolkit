const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { atomicWrite } = require("../../services.cjs");
const {
  optionFields,
  validateOverrides,
} = require("../../../shared/game-options-model.cjs");
const digest = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");
const MAX_BYTES = 2 * 1024 * 1024;
async function readFile(file) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw Error("游戏设置文件不是普通文件：" + file);
    if (stat.size > MAX_BYTES) throw Error("游戏设置文件超过 2 MB，未修改");
    handle = await fs.open(file, "r");
    const data = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(
        data,
        size,
        data.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw Error("游戏设置文件超过 2 MB，未修改");
    const buffer = data.subarray(0, size);
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { buffer, text: buffer.toString("utf8"), revision: digest(buffer) };
  } catch (e) {
    if (e.code === "ENOENT") return { buffer: null, text: "", revision: null };
    throw e;
  } finally {
    await handle?.close();
  }
}
function valuesOf(text) {
  const values = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
  }
  return values;
}
function patchOptions(text, overrides) {
  const remaining = new Set(Object.keys(overrides)),
    changed = new Set();
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let result = text.replace(
    /(^|\n)(\uFEFF?)([^\r\n:]+):([^\r\n]*)/g,
    (all, start, bom, key, value) => {
      if (!Object.hasOwn(overrides, key)) return all;
      remaining.delete(key);
      if (value === overrides[key]) return all;
      changed.add(key);
      return start + bom + key + ":" + overrides[key];
    },
  );
  for (const key of remaining) {
    if (result && !result.endsWith("\n")) result += eol;
    result += key + ":" + overrides[key] + eol;
    changed.add(key);
  }
  return { text: result, changed: [...changed] };
}
class GameOptions {
  constructor(directory, optionsFile, { isRunning = async () => false } = {}) {
    this.file = path.join(directory, "game-options.json");
    this.optionsFile = optionsFile;
    this.backups = path.join(directory, "game-options-backups");
    this.isRunning = isRunning;
    this.queue = Promise.resolve();
  }
  run(fn) {
    const task = this.queue.catch(() => {}).then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  async template() {
    const source = await readFile(this.file);
    if (!source.buffer) return { ...source, overrides: {} };
    const data = JSON.parse(source.text.replace(/^\uFEFF/, ""));
    if (data.version !== 1) throw Error("游戏设置模板版本不支持，原文件已保留");
    return { ...source, overrides: validateOverrides(data.overrides) };
  }
  async snapshot() {
    await this.queue;
    const template = await this.template();
    let current = {},
      fileError = "";
    try {
      current = valuesOf((await readFile(this.optionsFile)).text);
    } catch (e) {
      fileError = e.message;
    }
    return {
      revision: template.revision,
      overrides: template.overrides,
      current: Object.fromEntries(
        optionFields
          .filter((f) => Object.hasOwn(current, f.key))
          .map((f) => [f.key, current[f.key]]),
      ),
      optionsFile: this.optionsFile,
      backupDirectory: this.backups,
      fileError,
      running: await this.isRunning(),
    };
  }
  async save(revision, overrides) {
    const valid = validateOverrides(overrides);
    await this.run(async () => {
      const original = await this.template();
      if (original.revision !== revision)
        throw Error("游戏设置已被其他窗口修改，请重新载入后再保存");
      if (original.buffer) await atomicWrite(this.file + ".bak", original.text);
      if ((await readFile(this.file)).revision !== revision)
        throw Error("游戏设置文件发生变化，请重新载入");
      await atomicWrite(
        this.file,
        JSON.stringify({ version: 1, overrides: valid }, null, 2) + "\n",
      );
    });
    return this.snapshot();
  }
  prepare() {
    return this.run(async () => {
      const { overrides } = await this.template();
      if (!Object.keys(overrides).length)
        return { changed: [], optionsFile: this.optionsFile };
      // options.txt is shared by this game build even when the child's APPDATA is isolated.
      const original = await readFile(this.optionsFile);
      if (!original.buffer)
        throw Error(
          "未找到游戏 options.txt，请先启动游戏生成设置，再使用启动覆盖",
        );
      const patched = patchOptions(original.text, overrides);
      if (!patched.changed.length)
        return { changed: [], optionsFile: this.optionsFile };
      if (await this.isRunning())
        throw Error(
          "有开发测试端正在运行，无法改写共享游戏设置。请先退出相关测试端，或将游戏设置恢复为不覆盖后再启动",
        );
      await fs.mkdir(this.backups, { recursive: true });
      const backup = path.join(
        this.backups,
        "options-" + Date.now() + "-" + crypto.randomUUID() + ".txt",
      );
      await fs.writeFile(backup, original.buffer, { flag: "wx" });
      if ((await readFile(this.optionsFile)).revision !== original.revision)
        throw Error("options.txt 已被其他程序修改，未覆盖，请重试");
      if (await this.isRunning())
        throw Error(
          "开发测试端已开始运行，未改写共享设置，请退出相关测试端后重试",
        );
      if ((await readFile(this.optionsFile)).revision !== original.revision)
        throw Error("options.txt 已被其他程序修改，未覆盖，请重试");
      await atomicWrite(this.optionsFile, patched.text);
      const readback = await readFile(this.optionsFile);
      if (readback.text !== patched.text)
        throw Error("游戏设置写入后发生变化，已停止启动，请检查备份");
      return {
        changed: patched.changed,
        optionsFile: this.optionsFile,
        backup,
      };
    });
  }
  prepareIsolated(optionsFile) {
    return this.run(async () => {
      const { overrides } = await this.template();
      const own = await readFile(optionsFile);
      const original = own.buffer ? own : await readFile(this.optionsFile);
      const patched = patchOptions(original.text, overrides);
      const backup = optionsFile + ".before-start.bak";
      if (own.buffer && patched.text !== own.text)
        await atomicWrite(backup, own.text);
      if (!own.buffer || patched.text !== own.text)
        await atomicWrite(optionsFile, patched.text);
      return {
        changed: patched.changed,
        optionsFile,
        backup: own.buffer ? backup : "首次创建独立设置",
      };
    });
  }
}
module.exports = { GameOptions, patchOptions, valuesOf };
