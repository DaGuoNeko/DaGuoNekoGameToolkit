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
  async createRecord(name, copyId) {
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
      }),
    );
    return this.read(id);
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
