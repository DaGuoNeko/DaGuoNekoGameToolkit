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
) {
  const current = await layout(root);
  if (
    current.plan &&
    JSON.stringify(validatePlan(current.plan)) !==
      JSON.stringify(validatePlan(plan))
  )
    throw Error("存档内置模组登记与副本不一致，请重新导入正确副本");
  const rebase = (file, moved = false) => {
    for (const kind of kinds) {
      const c = current.containers[kind],
        relative = path.relative(c.original, path.resolve(file));
      if (
        (c.to || (moved && c.from)) &&
        !path.isAbsolute(relative) &&
        relative !== ".." &&
        !relative.startsWith(".." + path.sep)
      )
        return path.join(c.target, relative);
    }
    return file;
  };
  const remap = (entries, moved) =>
    entries.map((entry) =>
      typeof entry === "string"
        ? rebase(entry, moved)
        : { ...entry, path: rebase(entry.path, moved) },
    );
  external = remap(external, false);
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
      owned.push(own);
      if (!other.length) selected.push(own);
    }
  if (selected.length + external.length > 200)
    throw Error("内置模组与启动配置合计超过 200 个模组目录");
  if (
    (!current.plan ||
      kinds.some((k) => current.containers[k].from) ||
      owned.some((p) => p.filename === "pack_manifest.json")) &&
    !(await canMutate())
  )
    throw Error("首次准备或更新内置模组前，请先保存并退出其他游戏");
  // All selection/conflict checks finish before changing any copied manifest.
  for (const p of owned)
    if (p.filename === "pack_manifest.json") {
      await fs.writeFile(
        path.join(p.dir, "manifest.json"),
        JSON.stringify(p.manifest, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    }
  // The Windows client prefixes imports for world-local behavior_packs but only
  // adds the pack itself to sys.path. MCDK's global registration avoids that
  // mismatch. Keep all packs within this world for copy/recycle/restore, with a
  // durable original list that also survives re-import of a managed world.
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
  return [
    ...selected.map((p) => ({
      path: rebase(p.dir, true),
      enabled: true,
      // MCDK 1.6.1 cannot resolve changed module names when the watched root
      // itself is a behavior pack. Use the desktop incremental reloader there.
      hot_reload: p.kind !== "behavior",
      ...(p.kind === "behavior" ? { toolbox_hot_reload: true } : {}),
    })),
    ...remap(external, true).map((entry) => {
      const dir = typeof entry === "string" ? entry : entry.path;
      const own = owned.find(
        (p) => p.kind === "behavior" && samePath(rebase(p.dir, true), dir),
      );
      if (
        !own ||
        (typeof entry === "object" &&
          (entry.enabled === false || entry.hot_reload === false))
      )
        return entry;
      return {
        ...(typeof entry === "string" ? { path: entry } : entry),
        hot_reload: false,
        toolbox_hot_reload: true,
      };
    }),
  ];
}
module.exports = { inspectWorldPacks, prepareWorldPacks };
