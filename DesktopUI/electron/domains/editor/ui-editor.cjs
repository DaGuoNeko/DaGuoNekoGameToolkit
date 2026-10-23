const fs = require("node:fs/promises"),
  path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { parseDocument, MAX_TEXT } = require("../../../shared/ui-document.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
class UiDocuments {
  constructor(root) {
    this.root = root;
    this.documents = new Map();
    this.queue = Promise.resolve();
  }
  async read(file) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT)
      throw Error("需要不超过 2 MiB 的普通 JSON 文件");
    if (
      path.resolve(file).toLowerCase() !==
      (await fs.realpath(file)).toLowerCase()
    )
      throw Error("暂不编辑目录链接中的 UI 文件");
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_TEXT) throw Error("UI 文件过大");
    const raw = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    parseDocument(raw);
    return { raw, revision: hash(bytes) };
  }
  async resourceRoot(id) {
    const record = this.documents.get(id);
    if (!record) throw Error("UI 文件未登记");
    let root = path.dirname(record.file);
    for (let i = 0; i < 5; i++) {
      try {
        const text = await fs.readFile(
          path.join(root, "manifest.json"),
          "utf8",
        );
        if (text.length > 1024 * 1024) throw Error("资源包 manifest 过大");
        const value = require("jsonc-parser").parse(text);
        if (value?.modules?.some((m) => m.type === "resources")) return root;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    return null;
  }
  async open(file) {
    file = path.resolve(file);
    if (!/\.jsonc?$/i.test(file)) throw Error("请选择 JsonUI JSON 文件");
    const value = await this.read(file);
    let record = [...this.documents.values()].find(
      (d) => d.file.toLowerCase() === file.toLowerCase(),
    );
    if (!record) {
      if (this.documents.size >= 32)
        throw Error("本次最多打开 32 个 UI 文件，请重新打开工具箱后继续");
      record = { id: randomUUID(), file };
      this.documents.set(record.id, record);
    }
    return { ...record, ...value, ...(await this.references(file)) };
  }
  async references(file) {
    const dependencies = [],
      warnings = [];
    const dir = path.dirname(file);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const candidates = entries.filter(
      (e) =>
        e.isFile() &&
        /\.jsonc?$/i.test(e.name) &&
        !e.name.startsWith("_") &&
        path.join(dir, e.name) !== file,
    );
    let total = 0;
    for (const entry of candidates.slice(0, 300)) {
      try {
        const value = await this.read(path.join(dir, entry.name));
        total += value.raw.length;
        if (total > 8 * MAX_TEXT) {
          warnings.push("依赖总大小达到 16 MiB，剩余文件未读取");
          break;
        }
        dependencies.push({ name: entry.name, data: parseDocument(value.raw) });
      } catch (error) {
        warnings.push(entry.name + "：" + error.message);
      }
    }
    if (candidates.length > 300) warnings.push("仅索引同目录前 300 个 UI 文件");
    return { dependencies, warnings };
  }
  save(args) {
    const task = this.queue.then(() => this._save(args));
    this.queue = task.catch(() => {});
    return task;
  }
  async _save({ id, raw, revision }) {
    parseDocument(raw);
    if (Buffer.byteLength(raw, "utf8") > MAX_TEXT)
      throw Error("UI 文件不能超过 2 MiB");
    const record = this.documents.get(id);
    if (!record) throw Error("UI 文件没有通过打开对话框授权");
    const current = await this.read(record.file);
    if (current.revision !== revision)
      throw Error(
        "文件已被其他程序修改，请另存副本或重新打开后合并；未覆盖磁盘文件",
      );
    const folder = path.join(this.root, "ui-editor-backups");
    await fs.mkdir(folder, { recursive: true });
    const backup = path.join(
      folder,
      Date.now() + "-" + randomUUID() + "-" + path.basename(record.file),
    );
    await fs.writeFile(backup, current.raw, { encoding: "utf8", flag: "wx" });
    const temp = record.file + ".dgn-" + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, raw, { encoding: "utf8", flag: "wx" });
      if ((await this.read(record.file)).revision !== revision)
        throw Error("保存期间文件发生变化，已取消覆盖");
      await fs.rename(temp, record.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { ...record, raw, revision: hash(Buffer.from(raw, "utf8")), backup };
  }
  async create(file, raw) {
    parseDocument(raw);
    file = path.resolve(file);
    if (!/\.jsonc?$/i.test(file))
      throw Error("文件扩展名必须为 .json 或 .jsonc");
    if (Buffer.byteLength(raw) > MAX_TEXT) throw Error("UI 文件过大");
    const parent = path.dirname(file);
    if (parent.toLowerCase() !== (await fs.realpath(parent)).toLowerCase())
      throw Error("暂不写入目录链接");
    // Save-as never overwrites existing files; regular save uses the revision check.
    await fs.writeFile(file, raw, { encoding: "utf8", flag: "wx" });
    return this.open(file);
  }
  async texture(id, name) {
    const record = this.documents.get(id);
    if (!record) throw Error("请先打开 UI 文件");
    if (
      typeof name !== "string" ||
      name.length > 500 ||
      !/^textures\/[a-zA-Z0-9_./\-\u0080-\uffff]+$/.test(name) ||
      name.split("/").includes("..")
    )
      throw Error("不是资源包内的贴图路径");
    // Only a selected file's enclosing resource pack is readable.
    let root = path.dirname(record.file),
      found = false;
    for (let i = 0; i < 5; i++) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(root, "manifest.json"), "utf8"),
        );
        if (manifest.modules?.some((m) => m.type === "resources")) {
          found = true;
          break;
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw Error("资源包 manifest 无法读取");
      }
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    if (!found) throw Error("未找到资源包 manifest");
    const file = path.resolve(
      root,
      name.replace(/\.(png|jpg|jpeg)$/i, "") + ".png",
    );
    const real = await fs.realpath(file);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("贴图越出资源包");
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error("贴图过大");
    return (
      "data:image/png;base64," + (await fs.readFile(real)).toString("base64")
    );
  }
}
module.exports = { UiDocuments };
