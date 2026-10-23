const fs = require("node:fs/promises");
const path = require("node:path");
const {
  discoverDebugFunctions,
  buildDebugFunctionInvocation,
} = require("./vendor/functionParser.cjs");
const { atomicWrite } = require("../services.cjs");
const crypto = require("node:crypto");
const ignored = new Set([
  ".git",
  ".mcdev",
  ".miao",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "__pycache__",
  "build",
  "dist",
  "release",
  "qumodlibs",
]);

class DebugFunctions {
  constructor(store) {
    this.store = store;
    this.file = path.join(path.dirname(store.file), "debug-functions.json");
    this.queue = Promise.resolve();
  }
  async discover(id) {
    const selected = this.store.project(id);
    if (selected.profile) {
      const snapshot = await this.store.readProject(id);
      if (!snapshot.config) throw Error(snapshot.error);
      const roots = [
        ...new Set(
          snapshot.config.included_mod_dirs
            .filter((x) => typeof x === "string" || x.enabled !== false)
            .map((x) =>
              path.resolve(
                selected.baseDirectory || selected.root,
                typeof x === "string" ? x : x.path,
              ),
            ),
        ),
      ];
      const entries = [];
      for (const root of roots)
        entries.push(
          ...(await this.discoverRoot({
            ...selected,
            root,
            name: path.basename(root),
          })),
        );
      return entries;
    }
    return this.discoverRoot(selected);
  }
  async discoverRoot(project) {
    const sources = [],
      pending = [project.root];
    let bytes = 0,
      count = 0;
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (++count > 50000) throw Error("项目目录过大，请选择较小的模组项目");
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name.toLowerCase())) pending.push(file);
        } else if (entry.isFile() && /\.py$/i.test(entry.name)) {
          const stat = await fs.stat(file);
          if (
            stat.size > 2 * 1024 * 1024 ||
            sources.length >= 10000 ||
            bytes + stat.size > 32 * 1024 * 1024
          )
            throw Error("Python 源码扫描达到大小上限");
          bytes += stat.size;
          sources.push({
            relativePath: path.relative(project.root, file).replace(/\\/g, "/"),
            content: await fs.readFile(file, "utf8"),
          });
        }
      }
    }
    return discoverDebugFunctions(project.name, sources).map((entry) => ({
      ...entry,
      absoluteFilePath: path.resolve(project.root, entry.relativeFilePath),
    }));
  }
  async document() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (
        !value ||
        value.version !== 1 ||
        !value.projects ||
        typeof value.projects !== "object"
      )
        throw Error("调试函数收藏文件格式无效，原文件已保留");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  }
  async list(id) {
    this.store.project(id);
    return (await this.document()).projects[id] || [];
  }
  save(id, candidate, removeId) {
    this.store.project(id);
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const document = await this.document(),
          current = document.projects[id] || [];
        if (removeId)
          document.projects[id] = current.filter(
            (item) => item.id !== removeId,
          );
        else {
          if (
            !candidate ||
            typeof candidate.label !== "string" ||
            !candidate.label.trim() ||
            candidate.label.length > 160 ||
            !["client", "server"].includes(candidate.target)
          )
            throw Error("调试函数名称或执行端无效");
          if (
            !Array.isArray(candidate.parameters) ||
            candidate.parameters.length > 64 ||
            JSON.stringify(candidate).length > 65536
          )
            throw Error("调试函数参数无效");
          for (const parameter of candidate.parameters)
            if (
              !/^[A-Za-z_]\w*$/.test(parameter.name) ||
              !["value", "varargs", "kwargs"].includes(parameter.kind)
            )
              throw Error("参数定义无效");
          // Validate identifiers without executing imports or user code.
          buildDebugFunctionInvocation({
            ...candidate,
            parameters: [],
            argumentConfigs: {},
          });
          const value = {
            ...candidate,
            id: candidate.id || crypto.randomUUID(),
            argumentConfigs: candidate.argumentConfigs || {},
          };
          const next = current.filter((item) => item.id !== value.id);
          if (next.length >= 200) throw Error("每个项目最多收藏 200 个函数");
          document.projects[id] = [...next, value];
        }
        await atomicWrite(this.file, JSON.stringify(document, null, 2));
        return document.projects[id];
      });
    this.queue = operation;
    return operation;
  }
}
module.exports = { DebugFunctions, buildDebugFunctionInvocation };
