const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const CHANNELS = {
  测试端: "MinecraftPE_Netease",
  正式端: "MinecraftPC_Netease_PB",
};
const key = (value) => path.resolve(value).toLowerCase();

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(root) {
  if (!(await exists(root))) return [];
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
    .map((entry) => entry.name);
}

async function listGlobalConfigs(roaming, channel, player) {
  const selectedChannel = Object.hasOwn(CHANNELS, channel) ? channel : "测试端";
  const root = path.join(roaming, CHANNELS[selectedChannel], "storge", "stream", "users");
  const directories = new Map();
  if (await exists(root)) {
    for (const name of await listDirectories(root)) {
      if (name.toLowerCase() === "config") directories.set(name, path.join(root, name));
      else if (await exists(path.join(root, name, "config")))
        directories.set(name, path.join(root, name, "config"));
    }
  }
  const players = [...directories.keys()];
  const selected = players.includes(player) ? player : players[0] || "";
  const entries = [];
  if (selected) {
    for (const file of await fs.readdir(directories.get(selected), { withFileTypes: true })) {
      if (file.isSymbolicLink() || !file.isFile()) continue;
      const location = path.join(directories.get(selected), file.name);
      if (file.name.toLowerCase().endsWith(".bak")) continue;
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      entries.push({
        name: file.name,
        path: location,
        modified: stat.mtime.toISOString(),
        size: stat.size,
      });
    }
    entries.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
  }
  return { root, channel: selectedChannel, players, player: selected, entries, missing: !(await exists(root)) };
}

class NeteaseConfigs {
  constructor(roaming) {
    this.roaming = roaming;
    this.allowed = new Set();
  }
  async list(channel, player) {
    const result = await listGlobalConfigs(this.roaming, channel, player);
    this.allowed = new Set(result.entries.map((item) => key(item.path)));
    return result;
  }
  known(file) {
    return typeof file === "string" && this.allowed.has(key(file));
  }
  location(file) {
    if (!this.known(file)) throw Error("此路径不属于当前配置列表");
    return path.resolve(file);
  }
  async read(file) {
    const location = await this.regularFile(this.location(file));
    const stat = await fs.lstat(location);
    if (stat.size > 1024 * 1024) throw Error("文件超过 1 MB，请在外部编辑");
    return {
      text: await fs.readFile(location, "utf8"),
      modified: stat.mtime.toISOString(),
      size: stat.size,
    };
  }
  async save(file, text, modified) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
      throw Error("内容超过 1 MB");
    const location = await this.regularFile(this.location(file));
    const stat = await fs.lstat(location);
    if (stat.mtime.toISOString() !== modified)
      throw Error("文件已被其他程序修改，请重新打开后再保存");
    const original = await fs.readFile(location, "utf8");
    if (isJson(original) && !isJson(text))
      throw Error("原文件是 JSON，保存内容必须是有效 JSON");
    await fs.copyFile(location, location + ".bak");
    const temporary = location + "." + crypto.randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, text, "utf8");
      await fs.rename(temporary, location);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const next = await fs.lstat(location);
    return { modified: next.mtime.toISOString(), size: next.size };
  }
  async regularFile(location) {
    const stat = await fs.lstat(location);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error("只能编辑普通文件");
    if (key(await fs.realpath(location)) !== key(location)) throw Error("文件路径被重定向，已停止");
    return location;
  }
}

function isJson(text) {
  try {
    JSON.parse(String(text).replace(/^\uFEFF/, ""));
    return true;
  } catch {
    return false;
  }
}

module.exports = { CHANNELS, listGlobalConfigs, NeteaseConfigs };
