const fs = require("node:fs/promises");
const path = require("node:path");
const jsonc = require("jsonc-parser");
const ignored = new Set([
  ".git",
  ".miao",
  ".mcs",
  ".mcdev",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "release",
]);
const stamp = (s) => `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
async function packType(dir) {
  try {
    let file = path.join(dir, "manifest.json"),
      stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      file = path.join(dir, "pack_manifest.json");
      stat = await fs.lstat(file);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      return null;
    const errors = [],
      manifest = jsonc.parse(
        (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""),
        errors,
      );
    if (
      errors.length ||
      typeof manifest?.header?.uuid !== "string" ||
      !manifest.header.uuid ||
      !Array.isArray(manifest.header.version) ||
      !manifest.header.version.length ||
      !Array.isArray(manifest.modules)
    )
      return null;
    return (
      manifest.modules.find((m) => m.type === "data" || m.type === "resources")
        ?.type || null
    );
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}
async function behaviorRoots(root) {
  const type = await packType(root);
  if (type) return type === "data" ? [root] : [];
  const packs = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      ignored.has(entry.name.toLowerCase())
    )
      continue;
    const dir = path.join(root, entry.name);
    if ((await packType(dir)) === "data") packs.push(dir);
  }
  return packs;
}
async function collectScripts(config, base) {
  const entries = config.included_mod_dirs || [];
  const roots = entries
    .filter(
      (x) =>
        typeof x === "string" ||
        (x.enabled !== false &&
          (x.hot_reload !== false || x.toolbox_hot_reload === true)),
    )
    .map((x) =>
      path.resolve(
        base,
        typeof x === "string" ? x : x.toolbox_source_path || x.path,
      ),
    );
  if (config.world_source_path && config.world_source_path !== "auto")
    roots.push(path.resolve(base, config.world_source_path));
  if (config.world_source_path && config.world_source_path !== "auto") {
    const embedded = path.resolve(
      base,
      config.world_source_path,
      "behavior_packs",
    );
    try {
      if ((await fs.stat(embedded)).isDirectory()) roots.push(embedded);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const files = new Map(),
    packages = new Set(),
    visited = new Set();
  let count = 0;
  for (const root of roots) {
    const canonical = await fs.realpath(root);
    // Match MCDK's root/immediate-child manifest discovery. Nested staging
    // copies (such as st/) must never become reload candidates.
    const pending = await behaviorRoots(canonical);
    while (pending.length) {
      const dir = pending.pop(),
        key = dir.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++count > 75000)
          throw Error("模组目录扫描超过上限，请减少本次启用热更新的目录");
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name.toLowerCase())) pending.push(file);
        } else if (entry.isFile() && entry.name.endsWith(".py")) {
          if (files.size >= 10000)
            throw Error("Python 源文件超过 10000 个，已停止热更新");
          files.set(file.toLowerCase(), file);
          if (entry.name === "modMain.py") packages.add(dir);
        }
      }
    }
  }
  const modules = new Map();
  for (const file of files.values()) {
    let pkg = path.dirname(file);
    while (!packages.has(pkg) && path.dirname(pkg) !== pkg)
      pkg = path.dirname(pkg);
    if (!packages.has(pkg)) continue;
    const name = path
      .relative(path.dirname(pkg), file)
      .slice(0, -3)
      .split(path.sep)
      .join(".")
      .replace(/\.__init__$/, "");
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name))
      throw Error("不支持的脚本模块名称：" + name);
    if (
      modules.has(name) &&
      modules.get(name).file.toLowerCase() !== file.toLowerCase()
    )
      throw Error(
        `多个目录包含同名脚本模块，无法确定更新对象：${name}（${modules.get(name).file}；${file}）`,
      );
    const s = await fs.stat(file);
    modules.set(name, {
      name,
      file,
      stamp: stamp(s),
      modified: s.mtimeMs / 1000,
      runtimeFile: (() => {
        const entry = entries.find(
          (item) =>
            item.toolbox_source_path &&
            file
              .toLowerCase()
              .startsWith(
                path.resolve(item.toolbox_source_path).toLowerCase() +
                  path.sep,
              ),
        );
        return entry
          ? path.join(
              entry.path,
              path.relative(entry.toolbox_source_path, file),
            )
          : file;
      })(),
    });
  }
  return modules;
}
function indexCode(names) {
  if (Buffer.byteLength(JSON.stringify(names)) > 512 * 1024)
    throw Error("脚本模块列表过大");
  return `# DGN_RELOAD_INDEX
import sys, json
from common.utils import xupdate
_dgn_reload_names = json.loads(${JSON.stringify(JSON.stringify(names))})
_result = {'loadedAt': xupdate.LAST_UP_ALL_TIMESTAMP, 'loaded': [{'name': n, 'file': sys.modules[n].__file__} for n in _dgn_reload_names if n in sys.modules and getattr(sys.modules[n], '__file__', None)]}`;
}
function applyCode(names) {
  return `# DGN_RELOAD_APPLY
import sys, json
from common.utils import xupdate
_dgn_reload_names = json.loads(${JSON.stringify(JSON.stringify(names))})
_dgn_reload_done = []
for _dgn_reload_name in _dgn_reload_names:
    try:
        if _dgn_reload_name not in sys.modules:
            raise RuntimeError('Module is no longer loaded')
        _dgn_reload_ok = xupdate.update(_dgn_reload_name)
        _dgn_reload_done.append({'name': _dgn_reload_name, 'ok': bool(_dgn_reload_ok)})
    except Exception as _dgn_reload_error:
        _dgn_reload_done.append({'name': _dgn_reload_name, 'ok': False, 'error': str(_dgn_reload_error)})
_result = _dgn_reload_done`;
}
class ScriptReloader {
  constructor() {
    this.applied = new Map();
  }
  forget(registrationId) {
    this.applied.delete(registrationId);
  }
  async reload(session, root, request, embeddedOnly = false) {
    const started = Date.now();
    const raw = await fs.readFile(path.join(root, ".mcdev.json"), "utf8");
    const config = require("../services.cjs").parseConfig(raw);
    if (embeddedOnly) {
      config.included_mod_dirs = config.included_mod_dirs.filter(
        (entry) => entry.toolbox_hot_reload === true,
      );
      config.world_source_path = null;
    }
    const modules = await collectScripts(config, root);
    if (!modules.size)
      return { updated: 0, checked: 0, elapsedMs: Date.now() - started };
    const index = await request(indexCode([...modules.keys()]));
    if (
      !index ||
      !Array.isArray(index.loaded) ||
      !Number.isFinite(index.loadedAt) ||
      index.loadedAt <= 0
    )
      throw Error("游戏未返回有效脚本加载基准，未执行热更新");
    let state = this.applied.get(session.registrationId);
    if (
      !state ||
      state.generation !== session.connectionGeneration ||
      state.loadedAt !== index.loadedAt
    ) {
      state = {
        generation: session.connectionGeneration,
        loadedAt: index.loadedAt,
        files: new Map(),
      };
      this.applied.set(session.registrationId, state);
    }
    const seen = new Set();
    const changed = (await Promise.all(index.loaded
      .map(async (loaded) => {
        if (
          !loaded ||
          !modules.has(loaded.name) ||
          typeof loaded.file !== "string" ||
          seen.has(loaded.name)
        )
          throw Error("游戏返回了未登记或重复的脚本模块");
        const name = loaded.name,
          item = modules.get(name);
        seen.add(name);
        let physical = false;
        if (path.isAbsolute(loaded.file)) {
          const file = path.resolve(loaded.file).replace(/\.py[co]$/, ".py");
          physical = file.toLowerCase() === item.file.toLowerCase() ||
            file.toLowerCase() === item.runtimeFile.toLowerCase();
          if (!physical) {
            try {
              physical = (await fs.realpath(file)).toLowerCase() === item.file.toLowerCase();
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
        }
        if (
          !physical &&
          loaded.file !== name &&
          loaded.file !== name + ".__init__"
        )
          throw Error("游戏模块来源与配置目录不一致，已停止热更新：" + name);
        return item;
      })))
      .filter(
        (item) =>
          item.modified > index.loadedAt &&
          state.files.get(item.file) !== item.stamp,
      )
      .sort(
        (a, b) =>
          a.name.split(".").length - b.name.split(".").length ||
          a.name.localeCompare(b.name),
      );
    if (changed.length > 256)
      throw Error(
        "超过 256 个已加载脚本发生变化，请使用重载游戏，避免长时间阻塞",
      );
    let updated = 0;
    for (let offset = 0; offset < changed.length; offset += 4) {
      const batch = changed.slice(offset, offset + 4);
      for (const item of batch)
        if (stamp(await fs.stat(item.file)) !== item.stamp)
          throw Error(
            `已更新 ${updated} 个模块；文件仍在变化，请保存后重试：${item.name}`,
          );
      let results;
      try {
        results = await request(applyCode(batch.map((item) => item.name)));
      } catch (e) {
        throw Error(
          `已确认更新 ${updated} 个模块；当前批次结果不确定：${e.message}。请检查游戏日志，勿连续重试。`,
        );
      }
      if (
        !Array.isArray(results) ||
        results.length !== batch.length ||
        results.some(
          (r, i) => r?.name !== batch[i].name || typeof r.ok !== "boolean",
        )
      )
        throw Error("热更新回包无效，请先检查游戏状态");
      const failed = [];
      results.forEach((result, i) => {
        if (result.ok) {
          state.files.set(batch[i].file, batch[i].stamp);
          updated++;
        } else
          failed.push(
            `${result.name}：${result.error || "游戏更新接口未确认成功"}`,
          );
      });
      if (failed.length)
        throw Error(`已更新 ${updated} 个模块；失败：${failed.join("；")}`);
    }
    return {
      updated,
      checked: index.loaded.length,
      elapsedMs: Date.now() - started,
    };
  }
}
module.exports = { ScriptReloader, collectScripts, indexCode, applyCode };
