const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  os = require("node:os");
const { watch } = require("node:fs");
const jsonc = require("jsonc-parser");
const { collectScripts } = require("../debug/script-reload.cjs");
const { atomicWrite } = require("../services.cjs");
const VERSION = "python-files-v1",
  PAGE = 16,
  CHUNK = 12288,
  FILE_MAX = 2 * 1024 * 1024,
  TOTAL_MAX = 64 * 1024 * 1024;
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const hash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const inside = (root, file) => {
  const relative = path.relative(root.toLowerCase(), file.toLowerCase());
  return (
    relative &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
};
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const pyJson = (value) =>
  JSON.stringify(JSON.stringify(value)).replace(
    /[^\x00-\x7f]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
function moduleFor(relative) {
  return relative
    .slice(0, -3)
    .replaceAll("/", ".")
    .replace(/\.__init__$/, "");
}
function validEntry(e) {
  return (
    e &&
    uuid(e.pack) &&
    Array.isArray(e.version) &&
    e.version.length === 3 &&
    e.version.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) &&
    typeof e.relative === "string" &&
    e.relative.length < 512 &&
    /^(?:[A-Za-z_]\w*\/)+[A-Za-z_]\w*\.py$/.test(e.relative) &&
    e.relative
      .split("/")
      .every((p) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) &&
    e.name === moduleFor(e.relative) &&
    hash(e.sha256) &&
    hash(e.id) &&
    e.id === digest(e.pack + "/" + e.relative) &&
    Number.isInteger(e.bytes) &&
    e.bytes >= 0 &&
    e.bytes <= FILE_MAX
  );
}
async function ordinary(root, file) {
  if (!same(root, file) && !inside(root, file))
    throw Error("脚本路径超出已验证的下载包");
  const s = await fs.lstat(file);
  if (s.isSymbolicLink() || !same(await fs.realpath(file), file))
    throw Error("脚本或目录被链接重定向");
  return s;
}
async function manifest(dir, allowLegacy = false) {
  let file = path.join(dir, "manifest.json");
  try {
    let s;
    try {
      s = await ordinary(dir, file);
    } catch (error) {
      if (!allowLegacy || error.code !== "ENOENT") throw error;
      file = path.join(dir, "pack_manifest.json");
      s = await ordinary(dir, file);
    }
    if (!s.isFile() || s.size > 2 * 1024 * 1024)
      throw Error("模组描述文件无效");
    const errors = [],
      m = jsonc.parse(await fs.readFile(file, "utf8"), errors, {
        allowTrailingComma: true,
      });
    if (
      errors.length ||
      !uuid(m?.header?.uuid?.toLowerCase()) ||
      !m.modules?.some((x) => x.type === "data")
    )
      return null;
    return { pack: m.header.uuid.toLowerCase(), version: m.header.version };
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
    throw e;
  }
}
class ScriptSyncHost {
  constructor(config, base, guard) {
    Object.assign(this, { config, base, guard });
    this.snapshots = new Map();
    this.cache = new Map();
    this.watchers = new Map();
    this.dirty = true;
    this.closed = false;
    this.status = { phase: "preparing", message: "正在准备脚本同步" };
  }
  async build() {
    this.guard();
    const modules = await collectScripts(this.config, this.base),
      entries = [],
      buffers = new Map(),
      roots = new Map();
    let total = 0;
    for (const mod of modules.values()) {
      let dir = path.dirname(mod.file),
        m;
      while (path.dirname(dir) !== dir) {
        m = await manifest(dir, true);
        if (m) break;
        dir = path.dirname(dir);
      }
      if (!m) throw Error("找不到脚本所属的行为包：" + mod.name);
      roots.set(dir, m);
      const s = await ordinary(dir, mod.file);
      if (!s.isFile() || s.size > FILE_MAX)
        throw Error("单个联机脚本超过 2 MiB");
      let saved = this.cache.get(mod.file);
      if (!saved || saved.stamp !== mod.stamp) {
        const bytes = await fs.readFile(mod.file),
          after = await fs.stat(mod.file);
        if (
          s.mtimeMs !== after.mtimeMs ||
          s.ctimeMs !== after.ctimeMs ||
          s.size !== after.size
        )
          throw Error("脚本仍在保存，请稍后再试");
        saved = { stamp: mod.stamp, bytes, sha256: digest(bytes) };
        this.cache.set(mod.file, saved);
      }
      total += saved.bytes.length;
      if (total > TOTAL_MAX) throw Error("房间 Python 源码超过 64 MiB");
      const relative = path.relative(dir, mod.file).replaceAll(path.sep, "/"),
        e = {
          ...m,
          relative,
          name: mod.name,
          sha256: saved.sha256,
          bytes: saved.bytes.length,
          id: digest(m.pack + "/" + relative),
        };
      if (!validEntry(e))
        throw Error("不支持的联机脚本路径或包版本：" + mod.name);
      entries.push(e);
      buffers.set(e.id, saved.bytes);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    const structure = JSON.stringify(
      entries.map(({ id, pack, version, relative, name }) => ({
        id,
        pack,
        version,
        relative,
        name,
      })),
    );
    if (this.structure && structure !== this.structure)
      throw Error(
        "包版本或脚本文件清单发生变化，请重新创建房间并加入；当前仅支持修改已有 Python 文件",
      );
    this.structure = structure;
    const revision = digest(JSON.stringify(entries));
    this.guard();
    if (this.closed) throw Error("脚本同步已关闭");
    for (const dir of roots.keys())
      if (!this.watchers.has(dir)) {
        const w = watch(
          dir,
          { recursive: true, persistent: false },
          (_event, file) => {
            if (file == null || /\.py$|manifest\.json$/i.test(String(file))) {
              this.dirty = true;
              this.changedAt = Date.now();
            }
          },
        );
        w.on("error", (e) => {
          this.error = e.message;
          this.dirty = true;
        });
        this.watchers.set(dir, w);
      }
    this.guard();
    if (this.closed) throw Error("脚本同步已关闭");
    if (this.error) throw Error("脚本同步监听异常：" + this.error);
    this.snapshots.set(revision, { revision, entries, buffers });
    while (this.snapshots.size > 2)
      this.snapshots.delete(this.snapshots.keys().next().value);
    this.current = revision;
    this.dirty = false;
    this.builtAt = Date.now();
    this.status = {
      phase: "ready",
      revision,
      files: entries.length,
      message: "已开启联机 Python 热更新",
    };
    return this.snapshots.get(revision);
  }
  async currentSnapshot() {
    if (this.closed) throw Error("脚本同步已关闭");
    if (
      this.current &&
      Date.now() - this.builtAt < 10000 &&
      (!this.dirty || Date.now() - (this.changedAt || 0) < 600)
    )
      return this.snapshots.get(this.current);
    if (!this.building)
      this.building = this.build().finally(() => {
        this.building = null;
      });
    return this.building;
  }
  async list(data) {
    if (this.config.auto_hot_reload_mods === false) {
      this.status = {
        phase: "paused",
        message: "房主已关闭 Python 自动热更新",
      };
      return { version: VERSION, paused: true };
    }
    const snap = data.revision
      ? this.snapshots.get(data.revision)
      : await this.currentSnapshot();
    if (!snap) throw Error("脚本快照已更新，请重新同步");
    const offset = data.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > snap.entries.length)
      throw Error("无效脚本分页");
    return {
      version: VERSION,
      revision: snap.revision,
      total: snap.entries.length,
      ...(data.known === snap.revision
        ? { unchanged: true }
        : { entries: snap.entries.slice(offset, offset + PAGE) }),
    };
  }
  chunk(data) {
    const snap = this.snapshots.get(data.revision),
      bytes = snap?.buffers.get(data.id);
    if (!bytes) throw Error("脚本快照或文件不存在");
    if (
      !Number.isInteger(data.offset) ||
      data.offset < 0 ||
      data.offset > bytes.length
    )
      throw Error("无效脚本分片");
    const end = Math.min(bytes.length, data.offset + CHUNK);
    return {
      offset: data.offset,
      next: end,
      data: bytes.subarray(data.offset, end).toString("base64"),
    };
  }
  close() {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.snapshots.clear();
    this.cache.clear();
  }
}
function indexCode(names) {
  return `import sys, json\n_dgn_sync_names=json.loads(${pyJson(names)})\n_result={'paths':list(sys.path),'loaded':[n for n in _dgn_sync_names if n in sys.modules and getattr(sys.modules[n],'__file__',None)]}`;
}
function compileCode(files) {
  return `import json\n_dgn_sync_files=json.loads(${pyJson(files)})\nfor _dgn_sync_f in _dgn_sync_files:\n    with open(_dgn_sync_f['file'],'rb') as _dgn_sync_stream:\n        compile(_dgn_sync_stream.read(),_dgn_sync_f['name'],'exec')\n_result=True`;
}
function applyCode(names) {
  return `import sys, json\nfrom common.utils import xupdate\n_dgn_sync_names=json.loads(${pyJson(names)})\n_dgn_sync_results=[]\nfor _dgn_sync_n in _dgn_sync_names:\n    if _dgn_sync_n not in sys.modules:\n        raise RuntimeError('Module unloaded during room sync')\n    _dgn_sync_results.append({'name':_dgn_sync_n,'ok':bool(xupdate.update(_dgn_sync_n))})\n_result=_dgn_sync_results`;
}
class ScriptSyncGuest {
  constructor({ request, code, guard, directory, cacheRoots }) {
    Object.assign(this, { request, code, guard, directory });
    this.cacheRoots = cacheRoots || [
      path.join(process.env.APPDATA, "MinecraftPE_Netease/packcache"),
      path.join(os.tmpdir(), "minecraftpe/resource_pack_download_cache"),
    ];
    this.status = { phase: "waiting", message: "等待房主脚本同步" };
    this.ownedHashes = new Map();
    this.pendingRuntime = new Set();
    this.closed = false;
  }
  check() {
    this.guard();
    if (this.closed) throw Error("联机脚本同步已停止");
  }
  async catalog() {
    const known = this.failed || this.applied;
    let response = await this.request("scripts.list", { known });
    this.check();
    if (response.version === VERSION && response.paused === true)
      return { paused: true };
    if (
      response.version === VERSION &&
      response.unchanged === true &&
      hash(known) &&
      response.revision === known
    )
      return { revision: known };
    const revision = response.revision,
      total = response.total,
      entries = [];
    if (
      response.version !== VERSION ||
      !hash(revision) ||
      !Number.isInteger(total) ||
      total < 0 ||
      total > 10000
    )
      throw Error("房主脚本清单无效");
    while (true) {
      if (
        response.version !== VERSION ||
        response.revision !== revision ||
        response.total !== total ||
        !Array.isArray(response.entries) ||
        response.entries.length > PAGE ||
        (!response.entries.length && entries.length < total)
      )
        throw Error("脚本分页不一致");
      entries.push(...response.entries);
      if (entries.length >= total) break;
      response = await this.request("scripts.list", {
        revision,
        offset: entries.length,
      });
      this.check();
    }
    if (
      entries.length !== total ||
      entries.some((e) => !validEntry(e)) ||
      new Set(entries.map((e) => e.id)).size !== total ||
      new Set(entries.map((e) => e.name)).size !== total ||
      entries.reduce((n, e) => n + e.bytes, 0) > TOTAL_MAX ||
      digest(JSON.stringify(entries)) !== revision
    )
      throw Error("脚本清单校验失败");
    return { revision, entries };
  }
  async destinations(paths, entries) {
    if (!Array.isArray(paths) || paths.length > 2048)
      throw Error("游戏未返回有效包路径");
    const wanted = new Set(entries.map((e) => e.pack)),
      found = new Map();
    for (const item of paths) {
      if (typeof item !== "string" || !path.isAbsolute(item)) continue;
      const dir = path.resolve(item),
        base = this.cacheRoots.find((root) => inside(path.resolve(root), dir));
      if (!base) continue;
      await ordinary(path.resolve(base), dir);
      const m = await manifest(dir);
      if (!m || !wanted.has(m.pack)) continue;
      if (found.has(m.pack) && !same(found.get(m.pack).dir, dir))
        throw Error("当前游戏加载了多份同 UUID 的包，已停止同步");
      found.set(m.pack, { ...m, dir });
    }
    const out = new Map();
    for (const e of entries) {
      const p = found.get(e.pack);
      if (!p || JSON.stringify(p.version) !== JSON.stringify(e.version))
        throw Error("当前游戏缺少对应原生下载包：" + e.pack);
      const file = path.join(p.dir, ...e.relative.split("/"));
      const s = await ordinary(p.dir, file);
      if (!s.isFile() || s.size > FILE_MAX) throw Error("来宾脚本文件无效");
      out.set(e.id, { file, root: p.dir });
    }
    return out;
  }
  async download(revision, e) {
    const chunks = [];
    let offset = 0;
    while (offset < e.bytes) {
      const part = await this.request("scripts.chunk", {
        revision,
        id: e.id,
        offset,
      });
      this.check();
      if (
        part.offset !== offset ||
        typeof part.data !== "string" ||
        part.data.length > CHUNK * 2 ||
        !Number.isInteger(part.next)
      )
        throw Error("脚本分片无效");
      const b = Buffer.from(part.data, "base64");
      if (
        b.length === 0 ||
        b.length > CHUNK ||
        part.next !== offset + b.length ||
        part.next > e.bytes
      )
        throw Error("脚本分片长度不一致");
      chunks.push(b);
      offset = part.next;
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== e.bytes || digest(bytes) !== e.sha256)
      throw Error("脚本 SHA-256 校验失败");
    return bytes;
  }
  async tick() {
    if (this.closed) return;
    let revision;
    try {
      this.check();
      if (this.ackPending) await this.ack(this.ackPending);
      const catalog = await this.catalog();
      if (catalog.paused) {
        this.status = {
          phase: "paused",
          message: "房主已关闭 Python 自动热更新",
        };
        return;
      }
      revision = catalog.revision;
      if (revision === this.failed) return;
      if (revision === this.applied && !this.pendingRuntime.size) {
        if (this.failed) {
          this.failed = null;
          await this.ack({
            ...this.lastSuccess,
            files: 0,
            updated: 0,
            message: "房主已恢复到最近成功同步的脚本",
          });
        }
        return;
      }
      this.status = {
        phase: "syncing",
        revision,
        message: "正在同步房主 Python 脚本",
      };
      const index = await this.code(
        indexCode(catalog.entries.map((e) => e.name)),
      );
      this.check();
      if (
        !Array.isArray(index?.loaded) ||
        index.loaded.some((n) => !catalog.entries.some((e) => e.name === n))
      )
        throw Error("游戏已加载模块回执无效");
      const destinations = await this.destinations(
          index.paths,
          catalog.entries,
        ),
        changed = [];
      for (const e of catalog.entries) {
        const dst = destinations.get(e.id),
          before = await fs.readFile(dst.file);
        const current = digest(before),
          owned = this.ownedHashes.get(e.id);
        if (owned && owned !== current)
          throw Error("来宾下载包已被其他操作修改，已停止覆盖：" + e.name);
        if (current !== e.sha256 || this.pendingRuntime.has(e.id))
          changed.push({
            e,
            ...dst,
            before,
            bytes:
              current === e.sha256 ? before : await this.download(revision, e),
          });
      }
      if (changed.length > 256)
        throw Error("本次变更超过 256 个脚本，请分批更新或重新加入");
      const staging = path.join(this.directory, revision);
      await fs.mkdir(staging, { recursive: true });
      await ordinary(this.directory, staging);
      this.stagingRevisions ||= [];
      if (!this.stagingRevisions.includes(revision))
        this.stagingRevisions.push(revision);
      while (this.stagingRevisions.length > 2) {
        const old = this.stagingRevisions.shift(),
          dir = path.join(this.directory, old);
        if (!hash(old) || path.dirname(dir) !== this.directory)
          throw Error("临时脚本目录无效");
        await ordinary(this.directory, dir);
        await fs.rm(dir, { recursive: true, force: false });
      }
      for (const f of changed) {
        this.check();
        const staged = path.join(staging, f.e.id + ".py");
        await fs.writeFile(staged, f.bytes);
        await fs.writeFile(path.join(staging, f.e.id + ".before"), f.before);
        if (
          (await this.code(compileCode([{ name: f.e.name, file: staged }]))) !==
          true
        )
          throw Error("游戏未确认脚本语法校验");
      }
      for (const f of changed) {
        this.check();
        await ordinary(f.root, f.file);
        if (digest(await fs.readFile(f.file)) !== digest(f.before))
          throw Error("来宾脚本在准备更新期间发生变化");
        await atomicWrite(f.file, f.bytes);
        this.ownedHashes.set(f.e.id, f.e.sha256);
        this.pendingRuntime.add(f.e.id);
      }
      const loaded = changed.filter((f) => index.loaded.includes(f.e.name));
      let updated = 0;
      for (let offset = 0; offset < loaded.length; offset += 4) {
        this.check();
        const names = loaded.slice(offset, offset + 4).map((f) => f.e.name),
          result = await this.code(applyCode(names));
        this.check();
        if (
          !Array.isArray(result) ||
          result.length !== names.length ||
          result.some((r, i) => r.name !== names[i] || r.ok !== true)
        )
          throw Error("游戏未确认所有脚本热更新成功");
        updated += names.length;
      }
      this.check();
      for (const f of changed) this.pendingRuntime.delete(f.e.id);
      for (const e of catalog.entries) this.ownedHashes.set(e.id, e.sha256);
      this.applied = revision;
      this.failed = null;
      this.status = {
        phase: "synced",
        revision,
        files: changed.length,
        updated,
        message: `已同步 ${changed.length} 个文件，热更新 ${updated} 个已加载模块`,
      };
      this.lastSuccess = this.status;
      await this.ack(this.status);
    } catch (error) {
      if (this.closed) return;
      this.failed = revision;
      this.status = {
        phase: "error",
        revision,
        message: error.message.slice(0, 1000),
      };
      await this.ack(this.status);
    }
  }
  async ack(status) {
    this.ackPending = status;
    try {
      await this.request("scripts.ack", status);
      this.check();
      this.ackPending = null;
      this.status = status;
    } catch (error) {
      if (!this.closed)
        this.status = {
          ...status,
          phase: "ack_pending",
          message:
            status.message + "；回执待发送：" + error.message.slice(0, 200),
        };
    }
  }
  close() {
    this.closed = true;
  }
}
module.exports = {
  VERSION,
  ScriptSyncHost,
  ScriptSyncGuest,
  validEntry,
  digest,
  indexCode,
  applyCode,
  compileCode,
};
