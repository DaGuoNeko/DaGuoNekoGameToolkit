const fs = require("node:fs/promises"),
  path = require("node:path"),
  jsonc = require("jsonc-parser");
const kinds = ["behavior", "resource"];
const storageName = ".toolbox-packs";
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const version = (value) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff);
const sameVersion = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePath = (a, b) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function stat(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function directory(dir) {
  const s = await stat(dir);
  if (!s) return false;
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    !samePath(await fs.realpath(dir), dir)
  )
    throw Error("内置模组目录不是普通目录：" + dir);
  return true;
}
async function readJson(file, embedded = true) {
  const s = await stat(file);
  if (!s) return null;
  if (
    !s.isFile() ||
    (embedded && s.isSymbolicLink()) ||
    s.size > 2 * 1024 * 1024
  )
    throw Error("模组描述或加载清单无效：" + file);
  const errors = [],
    data = jsonc.parse(
      (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""),
      errors,
      { allowTrailingComma: true },
    );
  if (errors.length || data === null || typeof data !== "object")
    throw Error("模组 JSON 无法解析：" + file);
  return data;
}
async function pack(dir, embedded = true) {
  if (embedded) await directory(dir);
  let filename = "manifest.json",
    manifest = await readJson(path.join(dir, filename), embedded);
  if (!manifest && embedded) {
    filename = "pack_manifest.json";
    manifest = await readJson(path.join(dir, filename));
  }
  if (!manifest) return null;
  const h = manifest.header;
  const type = manifest.modules?.find(
    (m) => m?.type === "data" || m?.type === "resources",
  )?.type;
  if (!h || !uuid(h.uuid) || !version(h.version) || !type)
    throw Error("模组 UUID、版本或类型无效：" + path.join(dir, filename));
  return {
    dir,
    filename,
    manifest,
    id: h.uuid.toLowerCase(),
    version: h.version,
    kind: type === "data" ? "behavior" : "resource",
  };
}
async function layout(root) {
  await directory(root);
  const managed = path.join(root, storageName),
    exists = await directory(managed);
  const plan = exists
    ? await readJson(path.join(managed, "pack-plan.json"))
    : null;
  if (exists && !plan && (await fs.readdir(managed)).length)
    throw Error("存档中的 .toolbox-packs 缺少有效登记，不能覆盖该目录");
  if (plan) validatePlan(plan);
  const containers = {};
  for (const kind of kinds) {
    const original = path.join(root, kind + "_packs"),
      target = path.join(managed, kind + "_packs");
    const from = await directory(original),
      to = exists && (await directory(target));
    if (from && to)
      throw Error("存档中同时存在两份内置模组目录，请检查：" + kind);
    containers[kind] = {
      original,
      target,
      from,
      to,
      active: to ? target : original,
    };
  }
  return { managed, exists, plan, containers };
}
async function scan(root) {
  const current = await layout(root);
  const all = new Map();
  for (const kind of kinds) {
    const container = current.containers[kind].active;
    if (!(await directory(container))) continue;
    const entries = await fs.readdir(container, { withFileTypes: true });
    if (entries.length > 1000) throw Error("存档内置模组目录过多");
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw Error("内置模组目录含链接：" + entry.name);
      if (!entry.isDirectory()) continue;
      const p = await pack(path.join(container, entry.name));
      if (!p) continue;
      if (p.kind !== kind)
        throw Error("内置模组类型与所在目录不一致：" + p.dir);
      if (all.has(p.id)) throw Error("存档内置模组 UUID 重复：" + p.id);
      all.set(p.id, p);
    }
  }
  return all;
}
function references(list, label) {
  if (!Array.isArray(list) || list.length > 200)
    throw Error(label + " 必须是最多 200 项的数组");
  const seen = new Set();
  return list.map((ref) => {
    if (!uuid(ref?.pack_id) || !version(ref.version))
      throw Error(label + " 中的 UUID 或版本无效");
    const id = ref.pack_id.toLowerCase();
    if (seen.has(id)) throw Error(label + " 中存在重复的模组 UUID：" + id);
    seen.add(id);
    return { pack_id: id, version: [...ref.version] };
  });
}
function validatePlan(plan) {
  if (plan?.format !== 1)
    throw Error("存档内置模组登记格式无效，请重新导入地图副本");
  return Object.fromEntries(
    kinds.map((k) => [k, references(plan[k], k + " 内置模组登记")]),
  );
}
// Keep the import-time enabled lists in the world index. MCDK rewrites its
// runtime manifests on every launch, so they cannot be our next-run baseline.
async function inspectWorldPacks(root) {
  const current = await layout(root);
  const available = await scan(root);
  if (current.plan) return current.plan;
  if (!available.size) return null;
  const plan = { format: 1 };
  for (const kind of kinds) {
    let list = await readJson(path.join(root, "world_" + kind + "_packs.json"));
    if (!list)
      list = await readJson(
        path.join(root, "netease_world_" + kind + "_packs.json"),
      );
    if (!list && [...available.values()].some((p) => p.kind === kind))
      throw Error(
        "地图含内置模组但缺少 world_" + kind + "_packs.json，请补齐加载清单",
      );
    plan[kind] = references(list || [], kind + " 存档加载清单");
  }
  return plan;
}
async function externalPacks(entries, root) {
  const result = [];
  const readPack = (dir) => {
    const relative = path.relative(root, path.resolve(dir));
    const owned =
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep);
    return pack(dir, owned);
  };
  for (const entry of entries) {
    if (typeof entry === "object" && entry.enabled === false) continue;
    const dir = typeof entry === "string" ? entry : entry.path;
    const own = await readPack(dir);
    if (own) {
      result.push(own);
      continue;
    }
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const p = await readPack(path.join(dir, item.name));
      if (p) result.push(p);
    }
  }
  return result;
}
async function prepareWorldPacks(
  root,
  plan,
  external,
  canMutate = async () => true,
  runDirectory,
) {
  const current = await layout(root);
  if (
    current.plan &&
    JSON.stringify(validatePlan(current.plan)) !==
      JSON.stringify(validatePlan(plan))
  )
    throw Error("存档内置模组登记与副本不一致，请重新导入正确副本");
  const rebase = (file) => {
    for (const kind of kinds) {
      const c = current.containers[kind];
      for (const base of [c.original, c.target]) {
        const relative = path.relative(base, path.resolve(file));
        if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
          return path.join(c.active, relative);
      }
    }
    return file;
  };
  const remap = (entries) =>
    entries.map((entry) =>
      typeof entry === "string"
        ? rebase(entry)
        : { ...entry, path: rebase(entry.path) },
    );
  external = remap(external);
  const refs = validatePlan(plan),
    available = await scan(root),
    outside = await externalPacks(external, root),
    selected = [],
    owned = [];
  for (const kind of kinds)
    for (const ref of refs[kind]) {
      const own = available.get(ref.pack_id);
      const other = outside.filter((p) => p.id === ref.pack_id);
      if (!own) {
        // A world can also require a separately configured addon; do not silently
        // discard its reference when only part of the bundle was supplied.
        if (
          !other.length ||
          other.some(
            (p) => p.kind !== kind || !sameVersion(p.version, ref.version),
          )
        )
          throw Error(
            "存档引用的模组缺失或版本不匹配：" +
              ref.pack_id +
              " @ " +
              ref.version.join(".") +
              "；请补齐地图内置包或在启动配置启用对应模组",
          );
        continue;
      }
      if (own.kind !== kind || !sameVersion(own.version, ref.version))
        throw Error(
          "内置模组与导入时清单的版本不一致：" +
            own.dir +
            "；请重新导入正确的地图副本",
        );
      if (other.some((p) => !samePath(p.dir, own.dir)))
        throw Error(
          "启动配置中的模组与地图内置包 UUID 冲突：" +
            ref.pack_id +
            "；请停用外部副本后重试",
        );
      if (!other.length) selected.push(own);
      owned.push(own);
    }
  if (selected.length + external.length > 200)
    throw Error("内置模组与启动配置合计超过 200 个模组目录");
  if (!runDirectory) {
    if (
      (!current.plan ||
        kinds.some((k) => current.containers[k].from) ||
        owned.some((p) => p.filename === "pack_manifest.json")) &&
      !(await canMutate())
    )
      throw Error("首次准备或更新内置模组前，请先保存并退出其他游戏");
    for (const p of owned)
      if (p.filename === "pack_manifest.json")
        await fs.writeFile(
          path.join(p.dir, "manifest.json"),
          JSON.stringify(p.manifest, null, 2) + "\n",
          { encoding: "utf8", flag: "wx" },
        );
    if (!current.plan) {
      if (!current.exists) await fs.mkdir(current.managed);
      await fs.writeFile(
        path.join(current.managed, "pack-plan.json"),
        JSON.stringify(plan, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    }
    for (const kind of kinds) {
      const c = current.containers[kind];
      if (c.from) await fs.rename(c.original, c.target);
    }
    const legacyPath = (file) => {
      for (const kind of kinds) {
        const c = current.containers[kind],
          child = path.relative(c.original, path.resolve(file));
        if (!path.isAbsolute(child) && child !== ".." && !child.startsWith(".." + path.sep))
          return path.join(c.target, child);
      }
      return file;
    };
    return [
      ...selected.map((p) => ({
        path: path.join(current.containers[p.kind].target, path.basename(p.dir)),
        enabled: true,
        hot_reload: p.kind !== "behavior",
        ...(p.kind === "behavior" ? { toolbox_hot_reload: true } : {}),
      })),
      ...external.map((entry) =>
        {
          const file = legacyPath(typeof entry === "string" ? entry : entry.path);
          const own = owned.find((p) => p.kind === "behavior" &&
            samePath(legacyPath(p.dir), file));
          const enabled = typeof entry === "string" ||
            (entry.enabled !== false && entry.hot_reload !== false);
          if (own && enabled)
            return { ...(typeof entry === "string" ? {} : entry), path: file,
              hot_reload: false, toolbox_hot_reload: true };
          return typeof entry === "string" ? file : { ...entry, path: file };
        },
      ),
    ];
  }
  return prepareWorldPacksInRunDirectory(
      root,
      current,
      plan,
      external,
      selected,
      [...available.values()],
      canMutate,
      runDirectory,
    );
}

async function prepareWorldPacksInRunDirectory(
  root,
  current,
  plan,
  external,
  selected,
  owned,
  canMutate,
  runDirectory,
) {
  if (typeof runDirectory !== "string" || !path.isAbsolute(runDirectory))
    throw Error("内置模组缺少独立运行目录");
  const relative = path.relative(root, runDirectory);
  if (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  )
    throw Error("内置模组运行目录不能位于原存档内");
  const sourcePath = (file) => {
    for (const kind of kinds) {
      const container = current.containers[kind];
      for (const base of [container.original, container.target]) {
        const child = path.relative(base, path.resolve(file));
        if (
          !path.isAbsolute(child) &&
          child !== ".." &&
          !child.startsWith(".." + path.sep)
        )
          return path.join(container.original, child);
      }
    }
    return file;
  };
  if (current.exists && !(await canMutate()))
    throw Error("迁移旧版内置模组前，请先保存并退出其他游戏");
  let ancestor = runDirectory;
  while (!(await stat(ancestor))) ancestor = path.dirname(ancestor);
  await directory(ancestor);
  await fs.mkdir(runDirectory, { recursive: true });
  await directory(runDirectory);
  const deployed = path.join(runDirectory, "world-packs");
  await fs.mkdir(deployed);
  await fs.writeFile(path.join(deployed, "pack-plan.json"), JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  if (current.exists) {
    const names = await fs.readdir(current.managed);
    if (
      names.some(
        (name) =>
          !["pack-plan.json", "behavior_packs", "resource_packs"].includes(
            name,
          ),
      )
    )
      throw Error("旧 .toolbox-packs 中有未知内容，已保留，请先检查");
    const backup = path.join(deployed, "migration-backup");
    await fs.mkdir(backup);
    if (current.plan)
      await fs.copyFile(path.join(current.managed, "pack-plan.json"), path.join(backup, "pack-plan.json"), fs.constants.COPYFILE_EXCL);
    const lists = kinds.flatMap((kind) => ["world_" + kind + "_packs.json", "netease_world_" + kind + "_packs.json"]);
    for (const name of lists) {
      const file = path.join(root, name);
      if (await stat(file)) {
        await readJson(file);
        await fs.copyFile(file, path.join(backup, name), fs.constants.COPYFILE_EXCL);
      }
    }
    try {
      for (const kind of kinds) {
        const container = current.containers[kind];
        if (!container.to) continue;
        if (await stat(container.original))
          throw Error("恢复目标已经存在，未覆盖：" + container.original);
        await directory(container.target);
        await fs.rename(container.target, container.original);
      }
      if (current.plan) {
        const { atomicWrite } = require("../../services.cjs");
        for (const kind of kinds) {
          await atomicWrite(path.join(root, "world_" + kind + "_packs.json"), JSON.stringify(plan[kind], null, 2) + "\n");
          const netease = path.join(root, "netease_world_" + kind + "_packs.json");
          if (await stat(netease)) await atomicWrite(netease, JSON.stringify(plan[kind], null, 2) + "\n");
        }
        await fs.unlink(path.join(current.managed, "pack-plan.json"));
      }
      await fs.rmdir(current.managed);
    } catch (error) {
      throw Error("旧包目录恢复未完成，已保留源码和清单备份，可修复后重试。备份：" + backup + "；" + error.message);
    }
  }
  const staged = new Map();
  const manifests = path.join(runDirectory, "pack-manifests");
  await fs.mkdir(manifests);
  const stage = async (pack) => {
    const source = sourcePath(pack.dir);
    if (staged.has(source)) return staged.get(source);
    const id = pack.id.replaceAll("-", "");
    const target = path.join(deployed, pack.kind + "_packs", id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(
      path.join(manifests, id + ".json"),
      JSON.stringify(pack.manifest, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    staged.set(source, target);
    return target;
  };
  const result = [];
  for (const pack of selected) {
    result.push({
      path: await stage(pack),
      toolbox_source_path: sourcePath(pack.dir),
      enabled: true,
      hot_reload: pack.kind !== "behavior",
      ...(pack.kind === "behavior" ? { toolbox_hot_reload: true } : {}),
    });
  }
  for (const entry of external) {
    const pathValue = sourcePath(typeof entry === "string" ? entry : entry.path);
    const duplicates = entry.enabled === false ? [] : owned.filter((pack) =>
      samePath(sourcePath(pack.dir), pathValue) || samePath(path.dirname(sourcePath(pack.dir)), pathValue),
    );
    if (duplicates.length) {
      for (const duplicate of duplicates)
      result.push({
        ...(typeof entry === "string" ? {} : entry),
        path: await stage(duplicate),
        toolbox_source_path: sourcePath(duplicate.dir),
        hot_reload:
          duplicate.kind !== "behavior" &&
          (typeof entry === "string" || entry.hot_reload !== false),
        ...(duplicate.kind === "behavior" &&
        (typeof entry === "string" || entry.hot_reload !== false)
          ? { toolbox_hot_reload: true }
          : {}),
      });
      continue;
    }
    result.push(
      typeof entry === "string" ? pathValue : { ...entry, path: pathValue },
    );
  }
  if (result.length > 200) throw Error("内置模组与启动配置合计超过 200 个模组目录");
  return result;
}

module.exports = {
  inspectWorldPacks,
  prepareWorldPacks,
};
