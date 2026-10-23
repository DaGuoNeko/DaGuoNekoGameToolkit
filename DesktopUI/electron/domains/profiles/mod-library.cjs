const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite } = require("../../services.cjs");
const { removeModJson } = require("../../../shared/mod-removal.cjs");
const FORMAT = "DaGuoNekoGameToolkit.ModLibrary/1";
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const key = (value) => path.resolve(value).toLowerCase();
function nameOf(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 80 ||
    /[\0\r\n]/.test(value)
  )
    throw Error("模组名称应为 1–80 个字符");
  return value.trim();
}
function directoryOf(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.length > 4096 ||
    /[\0\r\n]/.test(value)
  )
    throw Error("请选择有效的模组绝对目录");
  return path.resolve(value);
}
class ModLibrary {
  constructor(store, profiles) {
    this.store = store;
    this.profiles = profiles;
    this.file = path.join(path.dirname(store.file), "mods.json");
    this.queue = Promise.resolve();
  }
  run(task) {
    const operation = this.queue.catch(() => {}).then(task);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async collect() {
    const entries = [],
      warnings = [];
    for (const p of this.store.value.projects) {
      try {
        const s = await this.profiles.read(p.id);
        if (!s.config) throw Error(s.error || "无法读取配置");
        for (const dir of s.resolvedModPaths)
          entries.push({
            name: (path.basename(dir) || dir).slice(0, 80),
            path: dir,
          });
      } catch (e) {
        warnings.push(`${p.name}：${e.message}`);
      }
    }
    return { entries, warnings };
  }
  merge(data, entries) {
    const paths = new Set(data.mods.map((m) => key(m.path)));
    let added = 0;
    for (const entry of entries) {
      if (paths.has(key(entry.path))) continue;
      if (data.mods.length >= 10000) throw Error("模组库最多保存 10000 个目录");
      data.mods.push({
        id: crypto.randomUUID(),
        name: nameOf(entry.name),
        path: directoryOf(entry.path),
      });
      paths.add(key(entry.path));
      added++;
    }
    return added;
  }
  async read() {
    let text;
    try {
      const stat = await fs.lstat(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8 * 1024 * 1024
      )
        throw Error("模组库文件无效，原文件已保留");
      text = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      const { entries, warnings } = await this.collect();
      const data = { format: FORMAT, mods: [] };
      this.merge(data, entries);
      text = JSON.stringify(data, null, 2) + "\n";
      if (Buffer.byteLength(text) > 8 * 1024 * 1024)
        throw Error("模组库超过 8 MB 上限");
      // Exclusive creation also protects against another instance creating it.
      await fs.writeFile(this.file, text, { flag: "wx" });
      return { data, revision: hash(text), warnings };
    }
    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      throw Error("模组库 JSON 损坏，原文件已保留，请检查 mods.json 或其备份");
    }
    if (
      data?.format !== FORMAT ||
      !Array.isArray(data.mods) ||
      data.mods.length > 10000
    )
      throw Error("无法识别模组库格式，原文件已保留");
    const ids = new Set(),
      paths = new Set();
    for (const m of data.mods) {
      if (
        !m ||
        typeof m.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(m.id) ||
        ids.has(m.id)
      )
        throw Error("模组库 ID 无效或重复");
      nameOf(m.name);
      directoryOf(m.path);
      if (paths.has(key(m.path))) throw Error("模组库目录重复");
      ids.add(m.id);
      paths.add(key(m.path));
    }
    return { data, revision: hash(text), warnings: [] };
  }
  async present(value) {
    const mods = [];
    for (const m of value.data.mods) {
      let available = false,
        error = "";
      try {
        available = (await fs.stat(m.path)).isDirectory();
      } catch (e) {
        if (!["ENOENT", "ENOTDIR"].includes(e.code)) error = e.message;
      }
      mods.push({ ...m, available, error });
    }
    return { mods, revision: value.revision, warnings: value.warnings };
  }
  list() {
    return this.run(async () => this.present(await this.read()));
  }
  folder({ id, profileId, index, expectedPath }) {
    return this.run(async () => {
      let directory;
      if (id) {
        const entry = (await this.read()).data.mods.find((m) => m.id === id);
        if (!entry) throw Error("模组已从库中移除，请刷新");
        directory = entry.path;
      } else {
        const snapshot = await this.profiles.read(profileId);
        if (!snapshot.config) throw Error(snapshot.error);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= snapshot.resolvedModPaths.length
        )
          throw Error("模组目录已变化，请重新载入配置");
        directory = snapshot.resolvedModPaths[index];
        if (
          typeof expectedPath !== "string" ||
          key(directory) !== key(expectedPath)
        )
          throw Error("模组目录已变化，请重新载入配置");
      }
      if (!(await fs.stat(directory)).isDirectory())
        throw Error("模组目录不存在或不是文件夹");
      return directory;
    });
  }
  async write(value, expected) {
    if (value.revision !== expected) throw Error("模组库已变化，请刷新后重试");
    const stat = await fs.lstat(this.file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("模组库文件已被替换");
    const before = await fs.readFile(this.file, "utf8");
    if (hash(before) !== expected)
      throw Error("模组库已被外部修改，请刷新后重试");
    await atomicWrite(this.file + ".bak", before);
    if (hash(await fs.readFile(this.file, "utf8")) !== expected)
      throw Error("模组库在保存期间变化，请刷新后重试");
    const text = JSON.stringify(value.data, null, 2) + "\n";
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw Error("模组库超过 8 MB 上限");
    await atomicWrite(this.file, text);
    value.revision = hash(text);
    return this.present(value);
  }
  save({ id, name, directory, revision }) {
    return this.run(async () => {
      const value = await this.read();
      const normalized = directoryOf(directory);
      name = nameOf(name);
      if (!(await fs.stat(normalized)).isDirectory())
        throw Error("请选择存在的模组目录");
      const item = id ? value.data.mods.find((m) => m.id === id) : null;
      if (id && !item) throw Error("模组已从库中移除，请刷新");
      if (
        value.data.mods.some(
          (m) => m.id !== id && key(m.path) === key(normalized),
        )
      )
        throw Error("这个模组目录已经在全局模组库中");
      if (item) Object.assign(item, { name, path: normalized });
      else this.merge(value.data, [{ name, path: normalized }]);
      return this.write(value, revision);
    });
  }
  remove(id, revision) {
    return this.run(() =>
      this.profiles.run(async () => {
        const value = await this.read();
        if (value.revision !== revision)
          throw Error("模组库已变化，请刷新后重试");
        const mod = value.data.mods.find((m) => m.id === id);
        if (!mod) throw Error("模组已从库中移除，请刷新");
        await this.store.queue;
        await Promise.all([...this.store.projectQueues.values()]);
        const plans = [];
        // Validate every profile before any mutation; an unreadable file must not
        // be silently treated as containing no references.
        for (const p of this.store.value.projects) {
          const snapshot = await this.profiles.read(p.id);
          if (!snapshot.config)
            throw Error(`无法清理启动配置“${p.name}”：${snapshot.error}`);
          const base = p.baseDirectory || p.root;
          const count = snapshot.resolvedModPaths.filter(
            (dir) => key(dir) === key(mod.path),
          ).length;
          if (count)
            plans.push({
              snapshot,
              count,
              raw: removeModJson(
                snapshot.raw,
                (dir) => key(path.resolve(base, dir)) === key(mod.path),
              ),
            });
        }
        const changes = [];
        try {
          for (const { snapshot, raw, count } of plans) {
            // Use the store directly inside the profile transaction: only remove
            // references, without normalizing unrelated profile settings.
            const saved = await this.store.saveProject(
              snapshot.project.id,
              snapshot.revision,
              undefined,
              raw,
            );
            changes.push({
              id: snapshot.project.id,
              name: snapshot.project.name,
              beforeRevision: snapshot.revision,
              revision: saved.revision,
              count,
            });
          }
          value.data.mods = value.data.mods.filter((m) => m.id !== id);
          return {
            ...(await this.write(value, revision)),
            removedPath: mod.path,
            changes,
            removedReferences: changes.reduce((sum, c) => sum + c.count, 0),
          };
        } catch (error) {
          // Keep the catalog entry so removal can be retried. Never roll back
          // over a concurrent external edit or disguise partial success.
          throw Error(
            `移除未完成：${error.message}。已清理 ${changes.length} 套配置${changes.length ? "（" + changes.map((c) => c.name).join("、") + "）" : ""}；请重新载入配置并刷新模组库后重试，模组文件未删除。`,
          );
        }
      }),
    );
  }
  addDirectories(directories, revision) {
    return this.run(async () => {
      if (
        !Array.isArray(directories) ||
        !directories.length ||
        directories.length > 1000
      )
        throw Error("请拖入 1–1000 个模组目录");
      const normalized = directories.map(directoryOf);
      for (const directory of normalized)
        if (!(await fs.stat(directory)).isDirectory())
          throw Error("请拖入模组目录，而不是文件");
      const value = await this.read();
      const added = this.merge(
        value.data,
        normalized.map((directory) => ({
          name: (path.basename(directory) || directory).slice(0, 80),
          path: directory,
        })),
      );
      const keys = new Set(normalized.map(key));
      return {
        ...(await this.write(value, revision)),
        added,
        selectedIds: value.data.mods
          .filter((m) => keys.has(key(m.path)))
          .map((m) => m.id),
      };
    });
  }
  importProfiles(revision) {
    return this.run(async () => {
      const value = await this.read(),
        collected = await this.collect();
      const added = this.merge(value.data, collected.entries);
      value.warnings = collected.warnings;
      return { ...(await this.write(value, revision)), added };
    });
  }
}
module.exports = { ModLibrary };
