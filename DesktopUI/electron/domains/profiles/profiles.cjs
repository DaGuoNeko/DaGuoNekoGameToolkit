const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  jsonc = require("jsonc-parser");
const {
  configDefaults,
  parseConfig,
  validateConfig,
  atomicWrite,
} = require("../../services.cjs");
const WORLD_KEYS = [
  "world_name",
  "world_folder_name",
  "world_source_path",
  "world_seed",
  "world_type",
  "game_mode",
  "reset_world",
  "auto_join_game",
  "enable_cheats",
  "keep_inventory",
  "do_weather_cycle",
  "do_daylight_cycle",
  "experiment_options",
];
const isWorld = (key) => WORLD_KEYS.includes(key);
const { ID: WORLD_ID } = require("../worlds/world-path.cjs");
const revisionOf = (text) => crypto.createHash("sha256").update(text).digest("hex");
function withDebugMod(raw) {
  return jsonc.applyEdits(
    raw,
    jsonc.modify(raw, ["include_debug_mod"], true, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}
function profileDefaults() {
  return Object.fromEntries(
    Object.entries({ ...configDefaults, included_mod_dirs: [] }).filter(
      ([key]) => !isWorld(key) && key !== "debug_options",
    ),
  );
}
function profileName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    /[\0\r\n]/.test(name)
  )
    throw Error("配置名称应为 1–80 个字符");
  return name.trim();
}
function resolvePaths(config, base) {
  const value = structuredClone(config);
  value.included_mod_dirs = (value.included_mod_dirs || []).map((item) =>
    typeof item === "string"
      ? path.resolve(base, item)
      : { ...item, path: path.resolve(base, item.path) },
  );
  if (value.game_executable_path)
    value.game_executable_path = path.resolve(base, value.game_executable_path);
  if (value.skin_info?.skin)
    value.skin_info = {
      ...value.skin_info,
      skin: path.resolve(base, value.skin_info.skin),
    };
  return value;
}
class Profiles {
  constructor(store) {
    this.store = store;
    this.directory = path.join(path.dirname(store.file), "profiles");
    this.queue = Promise.resolve();
  }
  run(task) {
    const result = this.queue.catch(() => {}).then(task);
    this.queue = result;
    return result;
  }
  async read(id) {
    const snapshot = await this.store.readProject(id);
    if (!snapshot.config) return snapshot;
    const raw = parseConfig(snapshot.raw);
    if (Object.keys(raw).some(isWorld))
      return {
        ...snapshot,
        config: null,
        error: "启动配置中含世界参数，请在完整 JSON 中移除，并在存档设置中管理",
      };
    if (!Object.hasOwn(raw, "included_mod_dirs"))
      snapshot.config.included_mod_dirs = [];
    snapshot.resolvedModPaths = snapshot.config.included_mod_dirs.map((item) =>
      path.resolve(
        snapshot.project.baseDirectory || snapshot.project.root,
        typeof item === "string" ? item : item.path,
      ),
    );
    return snapshot;
  }
  async initialize() {
    const old = this.store.value.projects.filter((p) => !p.profile);
    if (old.length) {
      await fs.copyFile(
        this.store.file,
        this.store.file + ".before-profiles-" + Date.now() + ".bak",
      );
      for (const p of old) {
        const snapshot = await this.store.readProject(p.id),
          base = p.root;
        let raw = snapshot.raw.replace(/^\uFEFF/, "");
        const legacyWorld = snapshot.config
          ? Object.fromEntries(WORLD_KEYS.map((k) => [k, snapshot.config[k]]))
          : null;
        if (snapshot.config) {
          const parsed = parseConfig(raw),
            absolute = resolvePaths(snapshot.config, base);
          for (const key of WORLD_KEYS)
            raw = jsonc.applyEdits(
              raw,
              jsonc.modify(raw, [key], undefined, {}),
            );
          for (const key of ["included_mod_dirs", "game_executable_path"])
            raw = jsonc.applyEdits(
              raw,
              jsonc.modify(raw, [key], absolute[key], {
                formattingOptions: { insertSpaces: true, tabSize: 2 },
              }),
            );
        }
        const folder = path.join(
          this.directory,
          crypto.createHash("sha256").update(p.id).digest("hex"),
        );
        await atomicWrite(path.join(folder, ".mcdev.json"), raw);
        await this.store.mutate((next) => {
          const item = next.projects.find((x) => x.id === p.id);
          Object.assign(item, {
            root: folder,
            baseDirectory: base,
            profile: true,
            legacyWorld,
          });
        });
      }
    }
    if (!this.store.value.projects.length) await this.create("默认配置");
  }
  create(name, copyId) {
    return this.run(() => this.createRecord(name, copyId));
  }
  createAutomatic(name, worldId) {
    if (!WORLD_ID.test(worldId)) throw Error("自动配置的存档 ID 无效");
    return this.run(() => this.createRecord(name, undefined, worldId));
  }
  async createRecord(name, copyId, worldId) {
    name = profileName(name);
    const id = crypto.randomUUID(),
      folder = path.join(this.directory, id);
    const source = copyId ? await this.read(copyId) : null;
    if (source && !source.config) throw Error(source.error);
    const raw = source
      ? withDebugMod(source.raw.replace(/^\uFEFF/, ""))
      : JSON.stringify(profileDefaults(), null, 2) + "\n";
    await atomicWrite(path.join(folder, ".mcdev.json"), raw);
    await this.store.mutate((next) =>
      next.projects.push({
        id,
        name: profileName(name),
        root: folder,
        baseDirectory: source?.project.baseDirectory || folder,
        profile: true,
        ...(worldId ? { automaticImport: { worldId, name, revision: revisionOf(raw) } } : {}),
      }),
    );
    return this.read(id);
  }
  reconcileAutomatic(worlds, inUse = () => false) {
    return this.run(async () => {
      await this.store.queue;
      await Promise.all([...this.store.projectQueues.values()]);
      const active = this.store.value.projects;
      const archived = this.store.value.recycledProfiles || [];
      const plans = [];
      for (const p of [...active, ...archived]) {
        const origin = p.automaticImport;
        if (!origin) continue;
        const wasArchived = archived.some(item => item.id === p.id);
        const expected = path.join(this.directory, p.id);
        if (!/^[a-f0-9-]{36}$/.test(p.id) || !WORLD_ID.test(origin.worldId) ||
            typeof p.root !== "string" || path.resolve(p.root).toLowerCase() !== expected.toLowerCase())
          throw Error("自动配置来源记录无效，未清理配置");
        const references = worlds.filter(w => (w.profileId || w.projectId) === p.id ||
          (w.copying && w.id === origin.worldId && w.profileId === "__auto_import__"));
        let pristine = false;
        try {
          const dir = await fs.lstat(p.root);
          const file = path.join(p.root, ".mcdev.json");
          const stat = await fs.lstat(file);
          if (dir.isSymbolicLink() || !dir.isDirectory() || stat.isSymbolicLink() || !stat.isFile() ||
              (await fs.realpath(p.root)).toLowerCase() !== expected.toLowerCase() || stat.size > 2 * 1024 * 1024)
            throw Error("自动配置文件被重定向或不是普通文件，未清理配置");
          pristine = p.name === origin.name && revisionOf(await fs.readFile(file, "utf8")) === origin.revision;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        // 修改过、无法核验或仍在使用的配置属于独立用户数据，不自动回收。
        const keep = !pristine || references.some(w => !w.deletedAt && !w.purging);
        let destination = keep ? "active" : references.length ? "archived" : "remove";
        if (destination === (wasArchived ? "archived" : "active")) continue;
        // 只为确实需要回收的配置查询进程，正常启动不为每份配置重复枚举系统进程。
        const used = destination !== "active" && await inUse(p.id);
        if (used) destination = "active";
        if (destination === (wasArchived ? "archived" : "active")) continue;
        plans.push({ profile: p, wasArchived, destination, used });
      }
      if (!plans.length) return false;
      const expectedRevision = await this.store.settingsRevision();
      await this.store.mutate(next => {
        for (const plan of plans) {
          const p = plan.profile;
          const current = (plan.wasArchived ? next.recycledProfiles : next.projects).find(item => item.id === p.id);
          if (JSON.stringify(current) !== JSON.stringify(p)) throw Error("配置登记已变化，未覆盖");
          if (plan.used && plan.destination !== "active") continue;
          next.projects = next.projects.filter(item => item.id !== p.id);
          next.recycledProfiles = next.recycledProfiles.filter(item => item.id !== p.id);
          if (plan.destination === "active") next.projects.push(p);
          if (plan.destination === "archived") next.recycledProfiles.push(p);
        }
      }, expectedRevision);
      return true;
    });
  }
  rename(id, name) {
    return this.run(async () => {
      this.store.project(id);
      await this.store.mutate((next) => {
        next.projects.find((p) => p.id === id).name = profileName(name);
      });
      return this.store.value.projects;
    });
  }
  save(id, revision, patch, raw) {
    if (typeof raw === "string") raw = raw.replace(/^\uFEFF/, "");
    const value = raw !== undefined ? parseConfig(raw) : patch;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("无效配置");
    if (Object.keys(value).some(isWorld))
      throw Error("启动配置不再保存世界参数，请在存档设置中修改");
    if (raw !== undefined) raw = withDebugMod(raw);
    else patch = { ...patch, include_debug_mod: true };
    return this.run(() =>
      this.store
        .saveProject(id, revision, patch, raw)
        .then(() => this.read(id)),
    );
  }
  remove(id) {
    return this.run(async () => {
      await this.store.removeProject(id);
      return this.store.value.projects;
    });
  }
}
module.exports = { Profiles, WORLD_KEYS, profileDefaults, resolvePaths };
