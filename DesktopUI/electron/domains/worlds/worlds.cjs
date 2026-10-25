const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite, validateConfig } = require("../../services.cjs");
const { LIBRARY_NAME, ID, managedId, folderFor } = require("./world-path.cjs");
const { loadWorldInfo } = require("./world-info.cjs");
const { openWorldZip } = require("./world-zip.cjs");
const { inspectWorldPacks, prepareWorldPacks } = require("./world-packs.cjs");
const { AUTO_IMPORT_PROFILE } = require("../../../shared/world-import-model.cjs");
const { validateModIds } = require("../reload/quick-test.cjs");
const FORMAT = "DaGuoNekoGameToolkit.WorldLibrary/1";
const RULE_KEYS = [
  "enable_cheats",
  "keep_inventory",
  "do_weather_cycle",
  "do_daylight_cycle",
  "experiment_options",
];
const rules = (value) =>
  Object.fromEntries(
    RULE_KEYS.filter((key) => value?.[key] !== undefined).map((key) => [
      key,
      value[key],
    ]),
  );
const revision = (text) =>
  crypto.createHash("sha256").update(text).digest("hex");
function stamped(value, text) {
  Object.defineProperty(value, "_revision", {
    value: revision(text),
    writable: true,
    enumerable: false,
  });
  return value;
}
const same = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function stat(file) {
  try {
    return await fs.lstat(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function title(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 80 ||
    /[\0\r\n]/.test(value)
  )
    throw Error("存档名称应为 1–80 个字符");
  return value.trim();
}
class WorldLibrary {
  constructor(store, root, options = {}) {
    this.store = store;
    this.worldsRoot = path.resolve(root);
    this.root = path.join(this.worldsRoot, LIBRARY_NAME);
    this.file = path.join(this.root, "worlds.json");
    this.queue = Promise.resolve();
    this.appDataOverride = options.appDataOverride || null;
    this.busy = options.busy || (() => false);
    this.mutationGuard = options.mutationGuard;
    this.createImportProfile = options.createImportProfile;
    this.gameRunning =
      options.gameRunning ||
      async function () {
        return false;
      };
  }
  run(task) {
    const result = this.queue.catch(() => {}).then(task);
    this.queue = result;
    return result;
  }
  async safeDirectory(dir, create = false) {
    if (create) await fs.mkdir(dir, { recursive: true });
    const s = await stat(dir);
    if (!s) return false;
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      !same(await fs.realpath(dir), dir)
    )
      throw Error("存档目录被重定向或不是普通目录，已停止操作");
    return true;
  }
  async read(create = false) {
    if (!(await this.safeDirectory(this.worldsRoot, create)))
      return { format: FORMAT, worlds: [] };
    if (!(await this.safeDirectory(this.root, create)))
      return { format: FORMAT, worlds: [] };
    const s = await stat(this.file);
    if (!s) {
      if ((await fs.readdir(this.root)).length)
        throw Error("专属存档目录已有未登记内容，请先检查目录");
      const value = { format: FORMAT, worlds: [] };
      const text = JSON.stringify(value, null, 2);
      if (create) {
        await atomicWrite(this.file, text);
        return stamped(value, text);
      }
      return value;
    }
    if (!s.isFile() || s.isSymbolicLink() || s.size > 4 * 1024 * 1024)
      throw Error("存档索引无效");
    let value, text;
    try {
      text = await fs.readFile(this.file, "utf8");
      value = JSON.parse(text);
    } catch {
      throw Error("存档索引损坏，已保留原文件");
    }
    if (
      value.format !== FORMAT ||
      !Array.isArray(value.worlds) ||
      value.worlds.length > 10000
    )
      throw Error("无法识别存档索引");
    const ids = new Set();
    for (const w of value.worlds) {
      if (
        !ID.test(w.id) ||
        ids.has(w.id) ||
        typeof w.projectId !== "string" ||
        typeof w.projectRoot !== "string"
      )
        throw Error("存档索引记录无效");
      ids.add(w.id);
      title(w.name);
      if (
        w.linkedPath !== undefined &&
        (typeof w.linkedPath !== "string" || !path.isAbsolute(w.linkedPath))
      )
        throw Error("原目录存档路径无效");
    }
    return stamped(value, text);
  }
  async write(value) {
    if (!(await this.safeDirectory(this.root)))
      throw Error("存档库目录已被移除，请刷新");
    const s = await stat(this.file);
    if (!s?.isFile() || s.isSymbolicLink())
      throw Error("存档索引已被替换，请检查");
    const before = await fs.readFile(this.file, "utf8");
    if (revision(before) !== value._revision)
      throw Error("存档索引已被外部修改，请刷新后重试");
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024)
      throw Error("存档索引超过 4 MiB，未保存本次修改");
    await atomicWrite(this.file + ".bak", before);
    if (revision(await fs.readFile(this.file, "utf8")) !== value._revision)
      throw Error("存档索引在保存期间变化，请刷新");
    await atomicWrite(this.file, text);
    value._revision = revision(text);
  }
  owns(w, project) {
    if (!project) return true;
    if (w.profileId) return w.profileId === project.id;
    return w.projectId === project.id || same(w.projectRoot, project.root);
  }
  find(data, project, id) {
    if (!ID.test(id)) throw Error("无效存档 ID");
    const w = data.worlds.find((w) => w.id === id && this.owns(w, project));
    if (!w) throw Error("该存档不属于当前项目");
    return w;
  }
  location(id, trash = false) {
    if (!ID.test(id)) throw Error("无效存档 ID");
    return path.join(this.root, ...(trash ? [".trash", id] : [id]));
  }
  async inspect(w) {
    if (w.linkedPath) {
      await this.checkLinkedMount(w);
      const present = await this.safeDirectory(w.linkedPath);
      const level = present
        ? await stat(path.join(w.linkedPath, "level.dat"))
        : null;
      if (level && (!level.isFile() || level.isSymbolicLink()))
        throw Error("存档 level.dat 无效");
      return {
        path: w.linkedPath,
        present,
        inTrash: false,
        deleted: !!w.deletedAt,
        ready: !!level,
        modifiedAt: level?.mtime.toISOString() || null,
      };
    }
    const location = this.location(w.id),
      recycled = this.location(w.id, true);
    if (await stat(path.dirname(recycled)))
      await this.safeDirectory(path.dirname(recycled));
    const present = await this.safeDirectory(location),
      inTrash = await this.safeDirectory(recycled);
    if (present && inTrash)
      throw Error("存档和回收站同时存在同名数据，请先检查");
    const level = present ? await stat(path.join(location, "level.dat")) : null;
    if (level && (!level.isFile() || level.isSymbolicLink()))
      throw Error("存档 level.dat 无效");
    return {
      path: location,
      present,
      inTrash,
      deleted: !!w.deletedAt || inTrash,
      ready: !!level,
      modifiedAt: level?.mtime.toISOString() || null,
    };
  }
  async checkLinkedMount(w) {
    const mount = this.location(w.id),
      s = await stat(mount);
    if (!s) return false;
    // Only this registered root junction is allowed. Descendant links remain forbidden.
    if (
      !s.isSymbolicLink() ||
      !same(
        path.resolve(path.dirname(mount), await fs.readlink(mount)),
        w.linkedPath,
      )
    )
      throw Error("原目录存档的运行入口已被替换，请检查存档库");
    return true;
  }
  async mountLinked(w) {
    if (
      !(await this.safeDirectory(w.linkedPath)) ||
      !(await stat(path.join(w.linkedPath, "level.dat")))?.isFile()
    )
      throw Error("原存档目录不存在或缺少 level.dat，请恢复原路径后启动");
    await this.noLinks(w.linkedPath);
    if (!(await this.checkLinkedMount(w)))
      await fs.symlink(w.linkedPath, this.location(w.id), "junction");
  }
  async detachLinked(w) {
    // unlink removes only the validated junction, never its target directory.
    if (await this.checkLinkedMount(w)) await fs.unlink(this.location(w.id));
  }
  async idle(dataMutation = false) {
    if (this.busy()) throw Error("请先停止当前启动会话，再管理存档");
    if (dataMutation && (await this.gameRunning()))
      throw Error(
        "检测到游戏仍在运行，请保存并退出游戏后再复制、删除、清空回收站或恢复存档",
      );
  }
  async mutable(ids) {
    if (this.mutationGuard) await this.mutationGuard(ids);
    else await this.idle(true);
  }
  async noLinks(root) {
    await this.safeDirectory(root);
    const pending = [root];
    let count = 0;
    while (pending.length) {
      const dir = pending.pop();
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++count > 250000) throw Error("存档文件过多，请先手动检查");
        const file = path.join(dir, entry.name),
          s = await fs.lstat(file);
        if (s.isSymbolicLink()) throw Error("存档中含目录链接，已停止操作");
        if (s.isDirectory()) {
          await this.safeDirectory(file);
          pending.push(file);
        } else if (!s.isFile()) throw Error("存档包含非普通文件");
      }
    }
  }
  list(projectId) {
    return this.run(async () => {
      const project = projectId ? this.store.project(projectId) : null,
        data = await this.read();
      const worlds = [];
      for (const w of data.worlds.filter((w) => this.owns(w, project))) {
        try {
          worlds.push({
            ...w,
            profileId: w.profileId || w.projectId,
            options: this.options(w),
            ...(await this.inspect(w)),
          });
        } catch (e) {
          worlds.push({
            ...w,
            path: w.linkedPath || this.location(w.id),
            deleted: !!w.deletedAt,
            error: e.message,
          });
        }
      }
      return { root: this.root, worlds };
    });
  }
  create(projectId, options) {
    return this.run(async () => {
      const snapshot = await this.store.readProject(projectId);
      if (snapshot.missing) throw Error(snapshot.error);
      const name = title(options.name);
      const config = validateConfig({
        ...snapshot.config,
        ...rules(options.options),
        world_seed: options.seed ?? null,
        world_type: options.worldType ?? 1,
        game_mode: options.gameMode ?? 1,
      });
      const data = await this.read(true),
        id = "w_" + crypto.randomUUID().replaceAll("-", "");
      const w = {
        id,
        name,
        projectId,
        profileId: projectId,
        projectRoot: snapshot.project.root,
        createdAt: new Date().toISOString(),
        seed: config.world_seed,
        worldType: config.world_type,
        gameMode: config.game_mode,
        options: rules(config),
      };
      data.worlds.push(w);
      await this.write(data);
      return w;
    });
  }
  rename(projectId, id, name) {
    return this.run(async () => {
      const data = await this.read(),
        w = this.find(
          data,
          projectId ? this.store.project(projectId) : null,
          id,
        );
      w.name = title(name);
      await this.write(data);
      return true;
    });
  }
  select(projectId, id, revision, confirmedResetDisabled = false) {
    return this.run(async () => {
      await this.idle();
      const project = this.store.project(projectId),
        data = await this.read();
      const w = this.find(data, project, id),
        info = await this.inspect(w);
      if (info.deleted || w.copying)
        throw Error("该存档在回收站或尚未复制完成");
      const snapshot = await this.store.readProject(projectId);
      if (!snapshot.config) throw Error(snapshot.error);
      if (snapshot.config.reset_world && !confirmedResetDisabled)
        throw Error("当前配置启用了重建世界，请确认改为保留存档进度");
      return this.store.saveProject(projectId, revision, {
        world_folder_name: folderFor(id),
        world_name: w.name,
        world_seed: w.seed ?? null,
        world_type: w.worldType ?? 1,
        game_mode: w.gameMode ?? 1,
        world_source_path: w.sourcePath ?? null,
        reset_world: false,
        auto_join_game: true,
      });
    });
  }
  async checkLaunch(projectId, config) {
    const id = managedId(config.world_folder_name);
    if (!id) return null;
    const data = await this.read(),
      w = this.find(data, projectId ? this.store.project(projectId) : null, id),
      info = await this.inspect(w);
    if (info.deleted || w.copying)
      throw Error(
        "当前存档已删除或未复制完成，请在存档卡片中选择其他存档或恢复",
      );
    if (info.present && !info.ready)
      throw Error("存档目录缺少 level.dat，请检查后再启动，避免覆盖数据");
    if (w.linkedPath) {
      if (config.reset_world || config.world_source_path)
        throw Error("直接使用原目录时禁止重建或覆盖存档");
      if (!info.ready)
        throw Error("原存档目录不存在或缺少 level.dat，请恢复原路径后启动");
      await this.mountLinked(w);
    }
    if (info.present) await this.noLinks(info.path);
    return w;
  }
  recycle(projectId, id, confirmed) {
    return this.run(async () => {
      if (confirmed !== true) throw Error("请先确认删除存档");
      await this.mutable([id]);
      const data = await this.read(),
        w = this.find(
          data,
          projectId ? this.store.project(projectId) : null,
          id,
        ),
        info = await this.inspect(w);
      if (info.deleted) throw Error("该存档已在回收站");
      if (w.linkedPath) {
        await this.detachLinked(w);
        w.deletedAt = new Date().toISOString();
        await this.write(data);
        return true;
      }
      const target = this.location(id, true);
      await this.safeDirectory(path.dirname(target), true);
      if (info.present) {
        await this.noLinks(info.path);
        await fs.rename(info.path, target);
      }
      w.deletedAt = new Date().toISOString();
      try {
        await this.write(data);
      } catch (e) {
        if (info.present) await fs.rename(target, info.path);
        throw e;
      }
      return true;
    });
  }
  restore(projectId, id) {
    return this.run(async () => {
      await this.mutable([id]);
      const data = await this.read(),
        w = this.find(
          data,
          projectId ? this.store.project(projectId) : null,
          id,
        ),
        info = await this.inspect(w);
      if (!info.deleted) throw Error("该存档不在回收站");
      if (w.purging)
        throw Error("该存档已开始永久删除，不能恢复，请重试永久删除");
      if (w.linkedPath) {
        if (!info.ready)
          throw Error("原存档目录不存在或缺少 level.dat，请先恢复原路径");
        delete w.deletedAt;
        await this.write(data);
        return true;
      }
      if (info.present) throw Error("原位置已有数据，不能覆盖恢复");
      if (info.inTrash) {
        await this.noLinks(this.location(id, true));
        await fs.rename(this.location(id, true), info.path);
      }
      delete w.deletedAt;
      try {
        await this.write(data);
      } catch (e) {
        if (info.inTrash) await fs.rename(info.path, this.location(id, true));
        throw e;
      }
      return true;
    });
  }
  purge(ids, confirmed) {
    return this.run(async () => {
      if (confirmed !== true)
        throw Error("请先确认永久删除存档，此操作不可恢复");
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 10000 ||
        new Set(ids).size !== ids.length
      )
        throw Error("无效的待删除存档列表");
      await this.mutable(ids);
      const data = await this.read();
      // Validate the entire confirmed selection before destroying any data.
      // Never enumerate the trash directory as a source of deletion targets.
      const validate = async (w) => {
        const info = await this.inspect(w);
        if (!info.deleted)
          throw Error("只能永久删除回收站中的存档，请刷新后重试");
        if (w.linkedPath) return { target: null, present: false };
        if (info.present) throw Error("原位置仍有存档数据，已停止永久删除");
        const target = this.location(w.id, true);
        if (
          path.dirname(target) !== path.join(this.root, ".trash") ||
          path.dirname(path.dirname(target)) !== this.root
        )
          throw Error("永久删除路径超出回收站范围");
        if (info.inTrash) await this.noLinks(target);
        return { target, present: info.inTrash };
      };
      const records = ids.map((id) => this.find(data, null, id));
      for (const w of records) await validate(w);
      let deleted = 0;
      for (const w of records) {
        try {
          await this.mutable([w.id]);
          await validate(w);
          if (w.linkedPath) await this.detachLinked(w);
          // A durable tombstone prevents restoring partially deleted worlds
          // after an I/O error or application termination. Retrying is safe.
          w.purging = true;
          w.deletedAt ||= new Date().toISOString();
          await this.write(data);
          const { target, present } = await validate(w);
          if ((await this.read())._revision !== data._revision)
            throw Error("存档索引已被外部修改，请刷新后重试");
          if (present) await fs.rm(target, { recursive: true, force: false });
          data.worlds = data.worlds.filter((item) => item.id !== w.id);
          await this.write(data);
          deleted++;
        } catch (e) {
          throw Error(
            `已永久删除 ${deleted} 个存档；处理“${w.name}”时停止：${e.message}。请刷新回收站检查并重试。`,
          );
        }
      }
      return { deleted };
    });
  }
  copyCurrent(projectId, name, revision) {
    return this.run(async () => {
      await this.idle(true);
      const snapshot = await this.store.readProject(projectId);
      if (!snapshot.config || snapshot.revision !== revision)
        throw Error("项目配置已变化，请重新载入后复制");
      const config = snapshot.config;
      await this.checkLaunch(projectId, config);
      const source = path.resolve(this.worldsRoot, config.world_folder_name),
        relative = path.relative(this.worldsRoot, source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw Error("源存档路径不安全");
      if (
        !(await this.safeDirectory(source)) ||
        !(await stat(path.join(source, "level.dat")))?.isFile()
      )
        throw Error("当前配置的存档尚不存在");
      await this.noLinks(source);
      const data = await this.read(true),
        id = "w_" + crypto.randomUUID().replaceAll("-", "");
      const w = {
        id,
        name: title(name),
        projectId,
        projectRoot: snapshot.project.root,
        createdAt: new Date().toISOString(),
        seed: config.world_seed,
        worldType: config.world_type,
        gameMode: config.game_mode,
        copying: true,
        sourcePath: config.world_source_path,
      };
      data.worlds.push(w);
      await this.write(data);
      // On failure keep the registered partial copy for explicit recycling; never
      // remove or move the original save, and never launch an incomplete copy.
      await fs.cp(source, this.location(id), {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      delete w.copying;
      await this.write(data);
      return w;
    });
  }
  async openPath(projectId, id) {
    const project = projectId ? this.store.project(projectId) : null,
      data = await this.read(true);
    if (!id) return this.root;
    const w = this.find(data, project, id),
      info = await this.inspect(w);
    if (info.deleted && info.inTrash) return this.location(id, true);
    return info.present ? info.path : this.root;
  }
  options(w) {
    const legacy =
      this.store.value.projects.find(
        (p) => p.id === (w.profileId || w.projectId),
      )?.legacyWorld || {};
    return {
      enable_cheats: legacy.enable_cheats ?? true,
      keep_inventory: legacy.keep_inventory ?? true,
      do_weather_cycle: legacy.do_weather_cycle ?? true,
      do_daylight_cycle: legacy.do_daylight_cycle ?? true,
      ...(legacy.experiment_options
        ? { experiment_options: legacy.experiment_options }
        : {}),
      ...rules(w.options),
      game_mode: w.gameMode ?? 1,
      world_type: w.worldType ?? 1,
      world_seed: w.seed ?? null,
    };
  }
  migrateProfiles() {
    return this.run(async () => {
      const data = await this.read();
      let changed = false;
      for (const w of data.worlds) {
        if (!w.profileId) {
          w.profileId = w.projectId;
          changed = true;
        }
        if (!w.options) {
          w.options = rules(this.options(w));
          changed = true;
        }
      }
      if (changed) await this.write(data);
    });
  }
  update(id, values) {
    return this.run(async () => {
      const data = await this.read(),
        w = this.find(data, null, id);
      if (values.profileId) this.store.project(values.profileId);
      const options = { ...this.options(w), ...values.options };
      validateConfig(options);
      const info = await this.inspect(w);
      if (
        info.ready &&
        (options.world_seed !== (w.seed ?? null) ||
          options.world_type !== (w.worldType ?? 1))
      )
        throw Error("世界已生成，不能修改种子或世界类型");
      const allowed = [
        "enable_cheats",
        "keep_inventory",
        "do_weather_cycle",
        "do_daylight_cycle",
        "experiment_options",
      ];
      w.options = Object.fromEntries(
        allowed
          .filter((key) => options[key] !== undefined)
          .map((key) => [key, options[key]]),
      );
      w.seed = options.world_seed;
      w.gameMode = options.game_mode;
      w.worldType = options.world_type;
      if (values.profileId) w.profileId = values.profileId;
      if (values.name !== undefined) w.name = title(values.name);
      await this.write(data);
      return true;
    });
  }
  saveQuickTest(id, modIds) {
    const checked = validateModIds(modIds);
    return this.run(async () => {
      const data = await this.read(),
        w = this.find(data, null, id);
      if (w.deletedAt || w.copying) throw Error("存档已删除或复制未完成");
      w.quickTestModIds = checked;
      await this.write(data);
    });
  }
  launchWorld(id, profileId, quickTest = false) {
    return this.run(async () => {
      const data = await this.read(),
        w = this.find(data, null, id),
        info = await this.inspect(w);
      if (!quickTest && (w.profileId || w.projectId) !== profileId)
        throw Error("存档绑定的启动配置已变化，请刷新后启动");
      if (info.deleted || w.copying) throw Error("存档已删除或复制未完成");
      if (w.linkedPath && !info.ready)
        throw Error("原存档目录不存在或缺少 level.dat，请恢复原路径后启动");
      if (info.ready && w.embeddedPacks === undefined) {
        const plan = await inspectWorldPacks(info.path);
        if (plan) {
          w.embeddedPacks = plan;
          await this.write(data);
        }
      }
      return { ...w, options: this.options(w) };
    });
  }
  prepareWorldPacks(id, plan, external, exclusiveHost = false, runDirectory) {
    return this.run(async () => {
      const w = this.find(await this.read(), null, id),
        info = await this.inspect(w);
      if (!info.ready || info.deleted || w.copying)
        throw Error("内置模组对应的存档不可用");
      if (JSON.stringify(w.embeddedPacks) !== JSON.stringify(plan))
        throw Error("存档内置模组登记已变化，请刷新后重试");
      await this.noLinks(info.path);
      return prepareWorldPacks(
        info.path,
        plan,
        external,
        async () => exclusiveHost || !(await this.gameRunning()),
        runDirectory,
      );
    });
  }
  importWorld(profileId, name, source, mode = "copy") {
    return this.run(async () => {
      await this.idle(true);
      if (!["copy", "linked"].includes(mode)) throw Error("无效的存档导入方式");
      const automatic = profileId === AUTO_IMPORT_PROFILE;
      const profile = automatic ? null : this.store.project(profileId);
      if (automatic && !this.createImportProfile)
        throw Error("自动匹配配置不可用，请重新打开工具箱");
      if (typeof source !== "string" || !path.isAbsolute(source))
        throw Error("请选择存档文件夹或 ZIP");
      source = path.resolve(source);
      const fromLibrary = path.relative(
          this.root.toLowerCase(),
          source.toLowerCase(),
        ),
        toLibrary = path.relative(
          source.toLowerCase(),
          this.root.toLowerCase(),
        );
      const within = (relative) =>
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep);
      if (within(fromLibrary) || within(toLibrary))
        throw Error("导入源不能是存档库、库内内容或存档库的上级目录");
      const sourceStat = await stat(source);
      if (
        !sourceStat ||
        sourceStat.isSymbolicLink() ||
        !same(await fs.realpath(source), source)
      )
        throw Error("导入源不存在或被目录链接重定向");
      let archive, registered, createdProfile;
      try {
        let metadata;
        if (mode === "linked" && !sourceStat.isDirectory())
          throw Error("直接使用原目录仅支持文件夹，ZIP 请先解压或选择复制导入");
        if (sourceStat.isFile() && /\.(?:zip|mcworld)$/i.test(source)) {
          archive = await openWorldZip(source);
          metadata = archive.metadata;
        } else if (sourceStat.isDirectory()) {
          await this.safeDirectory(source);
          await this.noLinks(source);
          if (!(await stat(path.join(source, "level.dat")))?.isFile())
            throw Error("目录中缺少 level.dat");
          metadata = await loadWorldInfo(path.join(source, "level.dat"));
        } else throw Error("只支持存档文件夹、ZIP 或 MCWORLD 文件");
        const data = await this.read(true),
          id = "w_" + crypto.randomUUID().replaceAll("-", "");
        if (
          mode === "linked" &&
          data.worlds.some((item) => {
            if (!item.linkedPath) return false;
            return (
              within(
                path.relative(
                  item.linkedPath.toLowerCase(),
                  source.toLowerCase(),
                ),
              ) ||
              within(
                path.relative(
                  source.toLowerCase(),
                  item.linkedPath.toLowerCase(),
                ),
              )
            );
          })
        )
          throw Error(
            "该原目录或其上下级目录已经登记，请使用已有卡片或先移除回收站中的登记",
          );
        const linkedPlan =
          mode === "linked" ? await inspectWorldPacks(source) : null;
        const w = {
          id,
          name: title(name),
          projectId: profileId,
          profileId,
          projectRoot: profile ? profile.baseDirectory || profile.root : "",
          createdAt: new Date().toISOString(),
          ...metadata,
          ...(mode === "linked" ? { linkedPath: source } : {}),
          copying: true,
        };
        data.worlds.push(w);
        await this.write(data);
        registered = w.name;
        if (mode === "linked") {
          if (linkedPlan) w.embeddedPacks = linkedPlan;
        } else if (archive) {
          await archive.extract(this.location(id), (dir) =>
            this.safeDirectory(dir),
          );
          await archive.close();
          archive = null;
        } else
          await fs.cp(source, this.location(id), {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            filter: async (file) => {
              const s = await fs.lstat(file);
              if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
                throw Error("存档含链接或非普通文件，已停止复制");
              if (s.isDirectory()) await this.safeDirectory(file);
              return true;
            },
          });
        const importedPath = w.linkedPath || this.location(id);
        await this.noLinks(importedPath);
        const embedded = await inspectWorldPacks(importedPath);
        if (embedded) w.embeddedPacks = embedded;
        await this.idle(true);
        // Create only after the copied save and pack list have been validated.
        // A failed copy never creates an unrelated empty configuration.
        if (automatic) {
          createdProfile = await this.createImportProfile(w.name);
          const selected = this.store.project(createdProfile.project.id);
          w.profileId = selected.id;
          w.projectId = selected.id;
          w.projectRoot = selected.baseDirectory || selected.root;
        }
        delete w.copying;
        await this.write(data);
        return w;
      } catch (e) {
        if (registered)
          throw Error(
            `导入“${registered}”未完成，已保留未完成卡片，可移入回收站后重试：${e.message}${createdProfile ? "；已创建启动配置“" + createdProfile.project.name + "”，可在启动配置页查看" : ""}`,
          );
        throw e;
      } finally {
        if (archive) await archive.close();
      }
    });
  }
}
module.exports = { WorldLibrary };
