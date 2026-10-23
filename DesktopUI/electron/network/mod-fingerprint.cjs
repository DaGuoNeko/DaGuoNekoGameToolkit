const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const jsonc = require("jsonc-parser");
const excluded = new Set([
  ".git",
  ".miao",
  "node_modules",
  "__pycache__",
  ".mcdev",
  "st",
]);
async function fingerprint(config) {
  const packages = [];
  const visited = new Set();
  let count = 0,
    total = 0;
  async function manifest(dir) {
    try {
      const errors = [],
        m = jsonc.parse(
          await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
          errors,
        );
      return !errors.length && m?.header?.uuid && Array.isArray(m.modules)
        ? m
        : null;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async function scan(dir, base, hash) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    );
    for (const ent of entries) {
      if (excluded.has(ent.name) || /\.py[co]$/.test(ent.name)) continue;
      const file = path.join(dir, ent.name);
      if (++count > 60000) throw Error("模组文件过多，无法核对联机版本");
      if (ent.isSymbolicLink())
        throw Error("联机模组内含目录链接，请先使用独立副本");
      if (ent.isDirectory()) await scan(file, base, hash);
      else if (ent.isFile()) {
        const stat = await fs.stat(file);
        total += stat.size;
        if (stat.size > 128 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024)
          throw Error("联机模组总量超出校验范围");
        const bytes = await fs.readFile(file),
          after = await fs.stat(file);
        if (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size)
          throw Error("模组正在修改，请保存后重试");
        hash.update(path.relative(base, file).replaceAll("\\", "/") + "\0");
        hash.update(crypto.createHash("sha256").update(bytes).digest());
      }
    }
  }
  for (const item of config.included_mod_dirs || []) {
    if (typeof item !== "string" && item.enabled === false) continue;
    const root = await fs.realpath(typeof item === "string" ? item : item.path);
    let roots = [root];
    if (!(await manifest(root))) {
      roots = [];
      for (const entry of await fs.readdir(root, { withFileTypes: true }))
        if (entry.isDirectory() && !excluded.has(entry.name))
          roots.push(path.join(root, entry.name));
    }
    for (const dir of roots) {
      const canonical = (await fs.realpath(dir)).toLowerCase();
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      const m = await manifest(dir);
      if (!m) continue;
      const hash = crypto.createHash("sha256");
      await scan(dir, dir, hash);
      packages.push({
        uuid: String(m.header.uuid),
        version: m.header.version,
        hash: hash.digest("hex"),
      });
    }
  }
  packages.sort((a, b) => a.uuid.localeCompare(b.uuid));
  if (new Set(packages.map((x) => x.uuid)).size !== packages.length)
    throw Error("存在重复模组 UUID，无法核对联机版本");
  return packages;
}
module.exports = { fingerprint };
