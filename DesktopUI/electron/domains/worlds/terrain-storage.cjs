const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { atomicWrite } = require("../../services.cjs");
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function safeRoot(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(root)).toLowerCase() !== path.resolve(root).toLowerCase())
    throw Error("地形任务目录被重定向，已停止操作");
}
async function copySnapshot(source, destination, check = () => {}) {
  if (path.resolve(destination).toLowerCase().startsWith(path.resolve(source).toLowerCase() + path.sep))
    throw Error("快照目录不能位于来源内部");
  const entries = [];
  async function scan(dir, relative = "") {
    if ((await fs.realpath(dir)).toLowerCase() !== path.resolve(dir).toLowerCase()) throw Error("来源含重定向目录");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      check();
      const name = path.join(relative, entry.name), file = path.join(source, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw Error("来源含链接，不能创建可靠快照");
      if (stat.isDirectory()) await scan(file, name);
      else if (stat.isFile()) {
        entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
        if (entries.length > 250000) throw Error("来源文件过多");
      } else throw Error("来源含特殊文件");
    }
  }
  await scan(source);
  await fs.mkdir(destination);
  for (const entry of entries) {
    check();
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to, require("node:fs").constants.COPYFILE_EXCL);
    const stat = await fs.lstat(from);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || stat.mtimeMs !== entry.mtime)
      throw Error("复制期间来源发生变化，请保存并关闭来源游戏后重试");
  }
  const initial = JSON.stringify(entries);
  entries.length = 0;
  await scan(source);
  if (initial !== JSON.stringify(entries)) throw Error("复制期间来源文件列表发生变化");
  return { files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) };
}
function file(root, name) {
  if (!/^[a-z0-9-]{1,100}$/.test(name)) throw Error("地形数据文件名无效");
  return path.join(root, name + ".json.gz");
}
async function writeData(root, name, value) {
  await safeRoot(root);
  const bytes = await gzip(Buffer.from(JSON.stringify(value)));
  await atomicWrite(file(root, name), bytes);
  return { name, digest: hash(bytes) };
}
async function readData(root, entry) {
  await safeRoot(root);
  const target = file(root, entry.name), stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw Error("地形数据文件无效");
  const bytes = await fs.readFile(target);
  if (!entry.digest || hash(bytes) !== entry.digest) throw Error("地形数据校验失败，未继续操作");
  return JSON.parse((await gunzip(bytes, { maxOutputLength: 64 * 1024 * 1024 })).toString("utf8"));
}
module.exports = { copySnapshot, writeData, readData };
