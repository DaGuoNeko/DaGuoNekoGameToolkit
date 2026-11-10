const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { atomicWrite } = require("../../services.cjs");

const FORMAT = "DaGuoNekoGameToolkit.QuickLaunch/1";
const key = (value) => path.resolve(value).toLowerCase();

function oneLine(value) {
  return String(value || "").replaceAll("\r", " ").replaceAll("\n", " ").trim();
}

function cleanName(value) {
  const text = oneLine(value);
  if (!text || text.length > 40) throw Error("名称应为 1–40 个字符");
  return text;
}

function cleanNote(value) {
  const text = oneLine(value);
  if (text.length > 120) throw Error("备注不能超过 120 个字符");
  return text;
}

async function exeOf(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !/\.exe$/i.test(file))
    throw Error("请选择 .exe 程序");
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") throw Error("找不到这个程序，请重新选择");
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error("程序必须是普通 exe 文件");
  if (key(await fs.realpath(file)) !== key(file)) throw Error("程序路径被重定向，已停止");
  return path.resolve(file);
}

class QuickLaunch {
  constructor(root) {
    this.file = path.join(root, "quick-launch.json");
    this.queue = Promise.resolve();
  }
  run(task) {
    const operation = this.queue.catch(() => {}).then(task);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async read() {
    let text;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { format: FORMAT, items: [] };
      throw error;
    }
    const data = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (data?.format !== FORMAT || !Array.isArray(data.items) || data.items.length > 50)
      throw Error("快捷程序记录无法识别，原文件已保留");
    return data;
  }
  async write(data) {
    await atomicWrite(this.file, JSON.stringify(data, null, 2) + "\n");
  }
  async list() {
    return { items: (await this.read()).items };
  }
  save(item) {
    return this.run(async () => {
      const data = await this.read();
      const next = {
        id: typeof item.id === "string" && item.id ? item.id : crypto.randomUUID(),
        name: cleanName(item.name),
        note: cleanNote(item.note),
        path: await exeOf(item.path),
      };
      const index = data.items.findIndex((entry) => entry.id === next.id);
      if (item.id && index < 0) throw Error("这个程序已不在列表中，请刷新");
      if (index < 0 && data.items.length >= 50) throw Error("最多保存 50 个程序");
      if (index >= 0) data.items[index] = next;
      else data.items.push(next);
      await this.write(data);
      return { items: data.items };
    });
  }
  remove(id) {
    return this.run(async () => {
      const data = await this.read();
      const items = data.items.filter((entry) => entry.id !== id);
      if (items.length === data.items.length) throw Error("这个程序已不在列表中，请刷新");
      data.items = items;
      await this.write(data);
      return { items };
    });
  }
  async launch(id) {
    const item = (await this.read()).items.find((entry) => entry.id === id);
    if (!item) throw Error("这个程序已不在列表中，请刷新");
    const file = await exeOf(item.path);
    await new Promise((resolve, reject) => {
      const child = spawn(file, [], {
        cwd: path.dirname(file),
        detached: true,
        stdio: "ignore",
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", reject);
    });
    return true;
  }
}

module.exports = { QuickLaunch, exeOf };
