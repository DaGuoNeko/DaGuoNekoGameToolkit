const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");
const { stripVTControlCharacters, promisify } = require("node:util");
const { spawn, execFile } = require("node:child_process");
const jsonc = require("jsonc-parser");
const exec = promisify(execFile);
const { SessionHistory } = require("./domains/game/history.cjs");
const { managedId, LIBRARY_NAME } = require("./domains/worlds/world-path.cjs");
const { reloadDefaults, validateReloadKeys } = require("./domains/reload/reload-options.cjs");
const { GameProcesses } = require("./domains/game/game-processes.cjs");
const { windowSizeDefaults, validateWindowSize } = require("./window-size.cjs");

const defaults = {
  AppearanceMode: "System",
  ThemeHue: 210,
  SidebarCollapsed: false,
  BgImagePath: "",
  BgImageOpacity: 0.06,
  BgImageBlur: 0,
  BgImageScale: 1,
  LauncherPath: "",
  GamePath: "",
  ReloadKeys: { ...reloadDefaults },
  AutomationEnabled: true,
  IndependentWorlds: true,
  GameWindowSize: { ...windowSizeDefaults },
};
const configDefaults = {
  included_mod_dirs: ["./"],
  game_executable_path: "",
  world_name: "大果喵开发测试",
  world_folder_name: "DAGUONEKO_DEV_WORLD",
  world_source_path: "auto",
  world_seed: null,
  world_type: 1,
  game_mode: 1,
  user_name: "developer",
  reset_world: false,
  auto_join_game: true,
  include_debug_mod: true,
  auto_hot_reload_mods: true,
  auto_hot_reload_ui: false,
  auto_hot_reload_shaders: false,
  auto_hot_reload_materials: false,
  auto_hot_reload_particles: false,
  enable_cheats: true,
  keep_inventory: true,
  do_weather_cycle: true,
  do_daylight_cycle: true,
  log_protocol: 0,
  debug_options: {
    reload_key: "82",
    reload_world_key: "",
    reload_addon_key: "",
    reload_shaders_key: "",
    reload_key_global: false,
  },
};
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
async function optionalRead(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, text, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function parseConfig(text) {
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
    throw Error("配置文件超过 2 MB");
  const errors = [];
  const value = jsonc.parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: false,
    disallowComments: false,
  });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw Error("配置格式无效，请检查 JSON；支持注释，不支持末尾多余逗号");
  return value;
}
function validateConfig(config) {
  const value = { ...configDefaults, ...config };
  if (
    !value.debug_options ||
    typeof value.debug_options !== "object" ||
    Array.isArray(value.debug_options)
  )
    throw Error("调试快捷键配置应为对象");
  value.debug_options = {
    ...configDefaults.debug_options,
    ...value.debug_options,
  };
  for (const key of [
    "reload_key",
    "reload_world_key",
    "reload_addon_key",
    "reload_shaders_key",
  ])
    if (
      typeof value.debug_options[key] !== "string" ||
      (value.debug_options[key] !== "" &&
        (!/^\d{1,3}$/.test(value.debug_options[key]) ||
          Number(value.debug_options[key]) < 1 ||
          Number(value.debug_options[key]) > 255))
    )
      throw Error("调试快捷键应为空或 1–255 的按键码：" + key);
  if (typeof value.debug_options.reload_key_global !== "boolean")
    throw Error("全局快捷键选项必须为开关值");
  for (const key of ["world_name", "world_folder_name", "user_name"])
    if (
      typeof value[key] !== "string" ||
      !value[key].trim() ||
      /[\0\r\n]/.test(value[key])
    )
      throw Error(`${key} 不能为空或包含换行`);
  if (value.world_folder_name.toLowerCase() === LIBRARY_NAME.toLowerCase())
    throw Error("存档目录不能使用存档库根目录，请从卡片选择具体存档");
  if (
    (!/^[a-zA-Z0-9_-]{1,80}$/.test(value.world_folder_name) &&
      !managedId(value.world_folder_name)) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.world_folder_name)
  )
    throw Error("存档目录名仅支持字母、数字、下划线和短横线，最多 80 字符");
  for (const key of ["world_type", "game_mode"])
    if (![0, 1, 2].includes(value[key])) throw Error(`${key} 必须为 0、1 或 2`);
  if (value.world_seed !== null && !Number.isSafeInteger(value.world_seed))
    throw Error("世界种子应为整数，或留空随机生成");
  for (const key of Object.keys(configDefaults).filter(
    (key) => typeof configDefaults[key] === "boolean",
  ))
    if (typeof value[key] !== "boolean") throw Error(`${key} 必须为开关值`);
  if (
    typeof value.game_executable_path !== "string" ||
    /[\0\r\n]/.test(value.game_executable_path)
  )
    throw Error("游戏程序路径无效");
  if (
    value.world_source_path !== null &&
    typeof value.world_source_path !== "string"
  )
    throw Error("地图源路径必须是文本");
  if (
    typeof value.world_source_path === "string" &&
    /[\0\r\n]/.test(value.world_source_path)
  )
    throw Error("地图源路径无效");
  if (![0, 1].includes(value.log_protocol))
    throw Error("日志协议必须为 0 或 1");
  if (value.experiment_options !== undefined) {
    if (
      !value.experiment_options ||
      typeof value.experiment_options !== "object" ||
      Array.isArray(value.experiment_options)
    )
      throw Error("实验性选项应为对象");
    for (const key of [
      "data_driven_biomes",
      "upcoming_creator_features",
      "experimental_creator_cameras",
      "gametest",
      "deferred_technical_preview",
    ])
      if (
        key in value.experiment_options &&
        typeof value.experiment_options[key] !== "boolean"
      )
        throw Error("实验性选项必须为开关值：" + key);
  }
  if (
    !Array.isArray(value.included_mod_dirs) ||
    value.included_mod_dirs.length > 200
  )
    throw Error("模组目录应为数组，最多 200 项");
  for (const item of value.included_mod_dirs) {
    const directory = typeof item === "string" ? item : item?.path;
    if (
      typeof directory !== "string" ||
      !directory.trim() ||
      /[\0\r\n]/.test(directory)
    )
      throw Error("模组目录路径不能为空");
    if (typeof item === "object")
      for (const key of ["enabled", "hot_reload"])
        if (key in item && typeof item[key] !== "boolean")
          throw Error(`模组目录的 ${key} 必须为开关值`);
  }
  return value;
}

class WorkspaceStore {
  constructor(directory) {
    this.file = path.join(directory, "settings.json");
    this.value = { settings: structuredClone(defaults), projects: [] };
    this.queue = Promise.resolve();
    this.projectQueues = new Map();
    this.warning = "";
  }
  async load() {
    const text = await optionalRead(this.file);
    if (text) {
      let stored;
      try {
        stored = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!stored || typeof stored !== "object" || Array.isArray(stored))
          throw new SyntaxError("设置根节点无效");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const backup = this.file + ".corrupt-" + Date.now() + ".bak";
        await fs.copyFile(this.file, backup);
        this.warning =
          "设置文件损坏，已保留原文件并备份到 " +
          backup +
          "。本次使用默认设置。";
        return this.value;
      }
      this.value.projects = Array.isArray(stored.projects)
        ? stored.projects.filter(
            (p) =>
              p &&
              typeof p.id === "string" &&
              typeof p.root === "string" &&
              path.isAbsolute(p.root),
          )
        : [];
      for (const [key, value] of Object.entries(stored.settings || {}))
        if (
          Object.hasOwn(defaults, key) &&
          typeof value === typeof defaults[key]
        )
          this.value.settings[key] = value;
      if (stored.settings?.ReloadKeys === undefined) {
        let keys = { ...reloadDefaults };
        for (const project of this.value.projects) {
          try {
            const raw = await optionalRead(
              path.join(project.root, ".mcdev.json"),
            );
            if (!raw) continue;
            const options = parseConfig(raw).debug_options;
            if (
              !options ||
              typeof options !== "object" ||
              Array.isArray(options)
            )
              continue;
            const bindings = Object.fromEntries(
              Object.keys(reloadDefaults)
                .filter(
                  (key) =>
                    key !== "reload_key_global" && Object.hasOwn(options, key),
                )
                .map((key) => [key, options[key]]),
            );
            if (!Object.keys(bindings).length) continue;
            keys = validateReloadKeys(bindings);
            break;
          } catch {
            /* Optional legacy import: unreadable/invalid profiles stay untouched. */
          }
        }
        const upgraded = {
          ...stored,
          settings: { ...stored.settings, ReloadKeys: keys },
        };
        if ((await optionalRead(this.file)) !== text)
          throw Error("设置文件在迁移快捷键期间变化，请重新打开工具箱");
        await fs.copyFile(
          this.file,
          this.file + ".before-global-reload-" + Date.now() + ".bak",
        );
        if ((await optionalRead(this.file)) !== text)
          throw Error("设置文件在备份期间变化，请重新打开工具箱");
        await atomicWrite(this.file, JSON.stringify(upgraded, null, 2));
        this.value.settings.ReloadKeys = keys;
      } else {
        try {
          this.value.settings.ReloadKeys = validateReloadKeys(
            stored.settings.ReloadKeys,
          );
        } catch (error) {
          this.value.settings.ReloadKeys = { ...reloadDefaults };
          this.warning =
            "全局快捷键设置无效，原文件已保留；本次使用默认按键，请到设置中重新保存。";
        }
      }
      if (stored.settings?.GamePath === undefined && !this.warning) {
        const candidates = [stored.settings?.BlankGamePath];
        for (const project of this.value.projects) {
          try {
            const raw = await optionalRead(
              path.join(project.root, ".mcdev.json"),
            );
            const value = raw && parseConfig(raw).game_executable_path;
            if (typeof value === "string" && value.trim())
              candidates.push(
                path.resolve(project.baseDirectory || project.root, value),
              );
          } catch {
            /* Optional migration source: leave unreadable profiles untouched. */
          }
        }
        let selected = "";
        for (const candidate of candidates) {
          if (
            typeof candidate !== "string" ||
            !path.isAbsolute(candidate) ||
            !/\.exe$/i.test(candidate) ||
            /[\0\r\n]/.test(candidate)
          )
            continue;
          try {
            if ((await fs.stat(candidate)).isFile()) {
              selected = candidate;
              break;
            }
          } catch {
            /* A missing legacy executable cannot become the global default. */
          }
        }
        const current = await optionalRead(this.file),
          upgraded = JSON.parse(current.replace(/^\uFEFF/, ""));
        upgraded.settings = { ...upgraded.settings, GamePath: selected };
        await fs.copyFile(
          this.file,
          this.file + ".before-global-game-" + Date.now() + ".bak",
        );
        if ((await optionalRead(this.file)) !== current)
          throw Error("设置在迁移全局游戏程序期间变化，请重新打开工具箱");
        await atomicWrite(this.file, JSON.stringify(upgraded, null, 2));
        this.value.settings.GamePath = selected;
      }
      try {
        this.value.settings.GameWindowSize = validateWindowSize(
          this.value.settings.GameWindowSize,
        );
      } catch {
        this.value.settings.GameWindowSize = { ...windowSizeDefaults };
        this.warning = [
          this.warning,
          "默认游戏窗口大小无效，本次使用 1280×720；请到设置中重新保存。",
        ]
          .filter(Boolean)
          .join("\n");
      }
      const originalGame = stored.settings?.GamePath;
      if (
        originalGame !== undefined &&
        (typeof originalGame !== "string" ||
          (originalGame &&
            (!path.isAbsolute(originalGame) ||
              !/\.exe$/i.test(originalGame) ||
              /[\0\r\n]/.test(originalGame))))
      ) {
        this.value.settings.GamePath = "";
        this.warning +=
          " 全局游戏程序路径无效，原文件已保留，请在设置中重新选择。";
      }
    }
    if (
      !["System", "Light", "Dark"].includes(this.value.settings.AppearanceMode)
    )
      this.value.settings.AppearanceMode = "System";
    for (const [key, min, max] of [
      ["BgImageOpacity", 0, 1],
      ["BgImageBlur", 0, 30],
      ["BgImageScale", 1, 2],
      ["ThemeHue", 0, 360],
    ])
      if (
        !Number.isFinite(this.value.settings[key]) ||
        this.value.settings[key] < min ||
        this.value.settings[key] > max
      )
        this.value.settings[key] = defaults[key];
    return this.value;
  }
  mutate(update) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.value);
      update(next);
      await atomicWrite(this.file, JSON.stringify(next, null, 2));
      this.value = next;
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  updateSettings(patch) {
    return this.mutate((next) => {
      for (const [key, value] of Object.entries(patch)) {
        if (key === "GameWindowSize") {
          next.settings.GameWindowSize = validateWindowSize(value);
          continue;
        }
        if (
          key === "GamePath" &&
          (typeof value !== "string" ||
            (value &&
              (!path.isAbsolute(value) ||
                !/\.exe$/i.test(value) ||
                /[\0\r\n]/.test(value))))
        )
          throw Error("请选择全局游戏程序的 EXE 绝对路径，或清空选择");
        if (key === "ReloadKeys") {
          next.settings.ReloadKeys = validateReloadKeys(
            value,
            next.settings.ReloadKeys,
          );
          continue;
        }
        if (
          !Object.hasOwn(defaults, key) ||
          typeof value !== typeof defaults[key] ||
          (typeof value === "string" && value.length > 4096)
        )
          throw Error("无效设置：" + key);
        next.settings[key] = value;
      }
      if (!["System", "Light", "Dark"].includes(next.settings.AppearanceMode))
        throw Error("无效主题");
      for (const [key, min, max] of [
        ["BgImageOpacity", 0, 1],
        ["BgImageBlur", 0, 30],
        ["BgImageScale", 1, 2],
        ["ThemeHue", 0, 360],
      ])
        if (
          !Number.isFinite(next.settings[key]) ||
          next.settings[key] < min ||
          next.settings[key] > max
        )
          throw Error("无效设置：" + key);
    });
  }
  async addProject(root) {
    root = path.resolve(root);
    if (!(await fs.stat(root)).isDirectory()) throw Error("请选择项目文件夹");
    return this.mutate((next) => {
      const old = next.projects.find(
        (p) => p.root.toLowerCase() === root.toLowerCase(),
      );
      if (old) return;
      next.projects.push({
        id: crypto.randomUUID(),
        name: path.basename(root),
        root,
      });
    });
  }
  project(id) {
    const p = this.value.projects.find((p) => p.id === id);
    if (!p) throw Error("项目不存在，请重新选择");
    return p;
  }
  removeProject(id) {
    this.project(id);
    return this.mutate((next) => {
      next.projects = next.projects.filter((p) => p.id !== id);
    });
  }
  async relocateProject(id, root) {
    root = path.resolve(root);
    if (!(await fs.stat(root)).isDirectory()) throw Error("请选择项目目录");
    return this.mutate((next) => {
      const project = next.projects.find((p) => p.id === id);
      if (!project) throw Error("项目不存在");
      if (
        next.projects.some(
          (p) => p.id !== id && p.root.toLowerCase() === root.toLowerCase(),
        )
      )
        throw Error("该目录已经登记");
      project.root = root;
      project.name = path.basename(root);
    });
  }
  async readProject(id) {
    const project = this.project(id);
    const file = path.join(project.root, ".mcdev.json");
    try {
      if (!(await fs.stat(project.root)).isDirectory())
        throw Object.assign(Error("项目目录不存在"), { code: "ENOTDIR" });
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      return {
        project,
        file,
        config: null,
        raw: "",
        exists: false,
        revision: null,
        missing: true,
        error: "项目目录不存在，请重新定位或从列表移除。",
      };
    }
    const text = await optionalRead(file);
    const raw =
      text === null ? JSON.stringify(configDefaults, null, 2) + "\n" : text;
    let config = null,
      error = "";
    try {
      config = validateConfig(parseConfig(raw));
    } catch (cause) {
      error = cause.message;
    }
    return {
      project,
      file,
      raw,
      config,
      revision: text === null ? null : hash(text),
      exists: text !== null,
      error,
      hasBackup: (await optionalRead(file + ".dgn-launcher.bak")) !== null,
    };
  }
  saveProject(id, revision, patch, raw) {
    const previous = this.projectQueues.get(id) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => this.writeProject(id, revision, patch, raw));
    this.projectQueues.set(id, operation);
    operation
      .finally(() => {
        if (this.projectQueues.get(id) === operation)
          this.projectQueues.delete(id);
      })
      .catch(() => {});
    return operation;
  }
  async readBackup(id) {
    const text = await optionalRead(
      path.join(this.project(id).root, ".mcdev.json.dgn-launcher.bak"),
    );
    if (text === null) throw Error("没有可用备份");
    validateConfig(parseConfig(text));
    return text;
  }
  async writeProject(id, revision, patch, raw) {
    const project = this.project(id);
    if (!(await fs.stat(project.root)).isDirectory())
      throw Error("项目目录不存在");
    const file = path.join(project.root, ".mcdev.json");
    const before = await optionalRead(file);
    if ((before === null ? null : hash(before)) !== revision)
      throw Error("配置已被外部程序修改，请重新载入后再保存");
    let text =
      before === null
        ? JSON.stringify(configDefaults, null, 2) + "\n"
        : before.replace(/^\uFEFF/, "");
    if (raw !== undefined) {
      if (typeof raw !== "string") throw Error("配置内容应为文本");
      text = raw;
    } else {
      parseConfig(text);
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw Error("缺少配置更新");
      for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(configDefaults, key) && key !== "experiment_options")
          throw Error("请通过完整配置编辑此字段：" + key);
        text = jsonc.applyEdits(
          text,
          jsonc.modify(text, [key], value, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
          }),
        );
      }
    }
    validateConfig(parseConfig(text));
    if (before !== null) {
      let suffix = ".dgn-launcher.bak";
      try {
        validateConfig(parseConfig(before));
      } catch {
        suffix = ".invalid-" + crypto.randomUUID() + ".bak";
      }
      await atomicWrite(file + suffix, before);
    }
    // Recheck after backup I/O so an external editor is not silently overwritten.
    const current = await optionalRead(file);
    if ((current === null ? null : hash(current)) !== revision)
      throw Error("配置在保存期间发生变化，请重新载入");
    await atomicWrite(file, text);
    return this.readProject(id);
  }
}

class Launcher extends EventEmitter {
  constructor(store, runtime, options = {}) {
    super();
    this.store = store;
    this.runtime = runtime;
    this.spawn = options.spawn || spawn;
    this.detectRunning = options.detectRunning || this.gameIsRunning;
    this.bridge = options.bridge || null;
    this.worlds = options.worlds || null;
    this.beforeSpawn = options.beforeSpawn;
    this.session = null;
    this.logs = [];
    this.serial = 0;
    this.starting = false;
    this.stopping = null;
    this.epoch = 0;
    this.revision = 0;
    this.historyError = "";
    this.history = new SessionHistory(
      path.join(path.dirname(store.file), "logs"),
      (message) => {
        this.historyError = message;
        this.publish();
      },
    );
    this.kill =
      options.kill ||
      ((pid) =>
        exec(
          path.join(process.env.SystemRoot, "System32", "taskkill.exe"),
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 },
        ));
  }
  state() {
    return {
      session: this.session ? { ...this.session, child: undefined } : null,
      logs: this.logs.slice(),
      epoch: this.epoch,
      revision: this.revision,
      starting: this.starting,
      stopping: !!this.stopping,
      historyError: this.historyError,
    };
  }
  publish() {
    this.revision++;
    this.emit("state", this.state());
  }
  log(stream, text) {
    const entry = {
      id: ++this.serial,
      time: new Date().toISOString(),
      stream,
      text: stripVTControlCharacters(text).replace(/\0/g, "").slice(0, 16384),
    };
    this.logs.push(entry);
    this.revision++;
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    this.emit("log", entry);
    this.history.append(entry);
  }
  async gameIsRunning(file) {
    return (await new GameProcesses().pids(file)).length > 0;
  }
  async start(id, expectedRevision, confirmedReset = false) {
    if (this.starting || this.stopping || this.session?.running)
      throw Error("已有启动会话，请先停止或等待游戏退出");
    this.starting = true;
    this.publish();
    const task = () => this.startPrepared(id, expectedRevision, confirmedReset);
    return this.worlds ? this.worlds.run(task) : task();
  }
  async startPrepared(id, expectedRevision, confirmedReset) {
    let bridgeRegistration;
    try {
      await this.store.projectQueues.get(id);
      const snapshot = await this.store.readProject(id);
      if (!snapshot.config) throw Error(snapshot.error);
      if (snapshot.revision !== expectedRevision || !snapshot.exists)
        throw Error("请先保存当前项目配置，再启动游戏");
      const config = snapshot.config;
      const selectedWorld = this.worlds
        ? await this.worlds.checkLaunch(id, config)
        : null;
      if (config.reset_world && !confirmedReset)
        throw Error("已启用重建测试世界，请先确认后再启动");
      const runtime = this.store.value.settings.LauncherPath || this.runtime;
      if (
        !path.isAbsolute(runtime) ||
        !/\.exe$/i.test(runtime) ||
        !(await fs.stat(runtime)).isFile()
      )
        throw Error("找不到有效的 mcdk.exe，请检查设置");
      if (!config.game_executable_path.trim())
        throw Error("请先选择游戏程序，避免启动器进入交互式版本选择");
      const game = path.resolve(
        snapshot.project.root,
        config.game_executable_path,
      );
      if (!/\.exe$/i.test(game) || !(await fs.stat(game)).isFile())
        throw Error("游戏程序不存在，请重新选择");
      for (const item of config.included_mod_dirs) {
        if (typeof item === "object" && item.enabled === false) continue;
        const directory = path.resolve(
          snapshot.project.root,
          typeof item === "string" ? item : item.path,
        );
        if (!(await fs.stat(directory)).isDirectory())
          throw Error("模组目录不存在：" + directory);
      }
      const secondary = await this.detectRunning(game);
      if (selectedWorld && secondary)
        throw Error(
          "请先保存并退出已运行的游戏，再启动所选存档；附加启动不会进入指定存档",
        );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.toUpperCase().startsWith("MCDEV_"),
        ),
      );
      if (this.worlds?.appDataOverride) {
        env.APPDATA = this.worlds.appDataOverride;
        env.LOCALAPPDATA = path.join(
          path.dirname(this.worlds.appDataOverride),
          "game-local-data",
        );
      }
      Object.assign(env, { MCDEV_IS_PLUGIN_ENV: "1", MCDEV_OUTPUT_MODE: "1" });
      if (secondary)
        Object.assign(env, {
          MCDEV_IS_SUBPROCESS_MODE: "1",
          MCDEV_AUTO_JOIN_GAME: "0",
        });
      if (this.bridge) {
        bridgeRegistration = await this.bridge.prepareLaunch(id);
        Object.assign(env, bridgeRegistration.environment);
      }
      this.logs = [];
      this.epoch++;
      this.historyError = "";
      const metadata = {
        id: crypto.randomUUID(),
        projectId: id,
        projectName: snapshot.project.name,
        worldId: selectedWorld?.id,
        worldName: config.world_name,
        startedAt: new Date().toISOString(),
      };
      await this.history.begin(metadata);
      if ((await this.store.readProject(id)).revision !== snapshot.revision)
        throw Error("配置在准备启动期间发生变化，请重新载入");
      if (this.beforeSpawn) {
        const applied = await this.beforeSpawn();
        if (applied.changed.length)
          this.log(
            "stdout",
            "[工具箱] 已应用启动前游戏设置（" +
              applied.changed.length +
              " 项）；备份：" +
              applied.backup,
          );
      }
      const spawnedChild = this.spawn(runtime, [], {
        cwd: snapshot.project.root,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Native isolation prepares a suspended launcher asynchronously. Keep
      // normal spawn synchronous so its next-tick spawn event cannot be lost.
      const child =
        typeof spawnedChild?.then === "function"
          ? await spawnedChild
          : spawnedChild;
      const session = (this.session = {
        ...metadata,
        bridgeRegistrationId: bridgeRegistration?.registrationId,
        running: true,
        pid: child.pid,
        secondary,
        stopped: false,
        code: null,
        child,
      });
      this.publish();
      this.log(
        "system",
        `正在启动 ${snapshot.project.name}${secondary ? "（检测到已有游戏，使用附加启动模式）" : ""}`,
      );
      for (const [stream, pipe] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ]) {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        const append = (chunk, flush = false) => {
          pending += chunk;
          const lines = pending.split(/\r?\n|\r/);
          pending = lines.pop();
          for (const line of lines) if (line) this.log(stream, line);
          if (pending.length > 16384 || flush) {
            if (pending) this.log(stream, pending);
            pending = "";
          }
        };
        pipe.on("data", (chunk) => append(decoder.write(chunk)));
        pipe.on("end", () => append(decoder.end(), true));
      }
      child.on("error", (error) => {
        session.error = error.message;
        session.code = -1;
        this.log("stderr", error.message);
        this.publish();
      });
      child.on("close", (code) => {
        session.running = false;
        session.code = session.error ? -1 : code;
        session.endedAt = new Date().toISOString();
        if (session.bridgeRegistrationId)
          this.bridge.releaseLaunch(session.bridgeRegistrationId);
        this.log(
          "system",
          session.error
            ? `启动失败：${session.error}`
            : session.stopped
              ? "会话已停止"
              : `会话已结束（退出码 ${code}）`,
        );
        this.history.finish();
        this.publish();
      });
      await new Promise((resolve, reject) => {
        const spawned = () => {
          child.removeListener("error", failed);
          resolve();
        };
        const failed = (error) => {
          child.removeListener("spawn", spawned);
          reject(error);
        };
        child.once("spawn", spawned);
        child.once("error", failed);
        child.start?.();
      });
      return this.state();
    } catch (error) {
      if (bridgeRegistration && !this.session?.running)
        this.bridge.releaseLaunch(bridgeRegistration.registrationId);
      if (!this.session?.running) await this.history.finish();
      throw error;
    } finally {
      this.starting = false;
      this.publish();
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    if (this.starting) return Promise.reject(Error("正在准备启动，请稍后停止"));
    this.stopping = this.stopOwned().finally(() => {
      this.stopping = null;
      this.publish();
    });
    this.publish();
    return this.stopping;
  }
  async shutdown() {
    if (this.worlds) await this.worlds.queue.catch(() => {});
    await this.store.queue;
    await Promise.all([...this.store.projectQueues.values()]);
    if (this.starting)
      await new Promise((resolve) => {
        const ready = () => {
          if (!this.starting) {
            this.removeListener("state", ready);
            resolve();
          }
        };
        this.on("state", ready);
        ready();
      });
    await this.stop();
    await this.history.finish();
  }
  async stopOwned() {
    const current = this.session;
    if (!current?.running) {
      await this.history.finish();
      return this.state();
    }
    if (current.child.exitCode !== null || current.child.signalCode) {
      await new Promise((resolve) => current.child.once("close", resolve));
      await this.history.finish();
      return this.state();
    }
    if (!Number.isInteger(current.child.pid) || current.child.pid <= 0)
      throw Error("启动进程尚未就绪");
    if (current.bridgeRegistrationId) {
      try {
        await this.bridge.stopForLaunch(current.bridgeRegistrationId);
      } catch (error) {
        this.log("system", error.message);
      }
      if (!current.running) {
        await this.history.finish();
        return this.state();
      }
    }
    let onClose;
    const exited = new Promise((resolve) => {
      onClose = resolve;
      current.child.once("close", onClose);
    });
    current.stopped = true;
    try {
      await this.kill(current.child.pid);
    } catch (error) {
      // taskkill /T can report a vanished descendant while the owned launcher's
      // close event is still queued. Wait for that event; do not infer exit from
      // localized taskkill text or treat a live/denied process as stopped.
      let settle;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          settle = setTimeout(resolve, 750);
        }),
      ]);
      clearTimeout(settle);
      if (current.running) {
        current.stopped = false;
        current.child.removeListener("close", onClose);
        this.log("stderr", "停止进程失败：" + error.message);
        throw Error(
          `无法停止本次客户端（启动器 PID ${current.child.pid}）：${error.code ? "错误码 " + error.code + "；" : ""}请确认游戏已退出后重试`,
        );
      }
    }
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error("停止超时，请检查运行日志")),
            8000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      current.child.removeListener("close", onClose);
      if (current.running) current.stopped = false;
    }
    await this.history.finish();
    return this.state();
  }
  clearLogs() {
    this.logs = [];
    this.epoch++;
    this.publish();
    return this.state();
  }
}
module.exports = {
  WorkspaceStore,
  Launcher,
  configDefaults,
  parseConfig,
  validateConfig,
  atomicWrite,
};
