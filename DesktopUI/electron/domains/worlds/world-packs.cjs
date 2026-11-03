const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  jsonc = require("jsonc-parser");
const { atomicWrite } = require("../../services.cjs");
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
async function inspectWorldPackVersions(root, plan) {
  const refs = validatePlan(plan),
    available = await scan(root),
    current = { format: 1, behavior: [], resource: [] },
    issues = [];
  for (const kind of kinds)
    for (const ref of refs[kind]) {
      const own = available.get(ref.pack_id),
        actual = own ? [...own.version] : null;
      current[kind].push({
        pack_id: ref.pack_id,
        version: actual || [...ref.version],
      });
      if (!own) {
        issues.push({
          kind,
          status: "missing",
          packId: ref.pack_id,
          expected: [...ref.version],
          actual: null,
        });
        continue;
      }
      if (own.kind !== kind) {
        issues.push({
          kind,
          status: "type",
          packId: ref.pack_id,
          packName: path.basename(own.dir),
          expected: [...ref.version],
          actual,
          actualKind: own.kind,
        });
      } else if (!sameVersion(own.version, ref.version)) {
        issues.push({
          kind,
          status: "version",
          packId: ref.pack_id,
          packName: path.basename(own.dir),
          expected: [...ref.version],
          actual,
        });
      }
    }
  return { plan: current, issues };
}
async function packRevision(root, plan) {
  const current = await layout(root), files = [];
  for (const kind of kinds) {
    const container = current.containers[kind].active;
    if (!(await directory(container))) continue;
    const entries = await fs.readdir(container, { withFileTypes: true });
    if (entries.length > 1000) throw Error("存档内置模组目录过多");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw Error("内置模组目录含链接：" + entry.name);
      if (!entry.isDirectory()) continue;
      await directory(path.join(container, entry.name));
      for (const name of ["manifest.json", "pack_manifest.json"])
        files.push(path.join(container, entry.name, name));
    }
  }
  files.push(...kinds.flatMap(k => ["world_", "netease_world_"].map(prefix => path.join(root, prefix + k + "_packs.json"))),
    path.join(root, storageName, "pack-plan.json"));
  const hash = crypto.createHash("sha256").update(JSON.stringify([path.resolve(root), plan]));
  for (const file of files) hash.update(JSON.stringify([file, await packText(file)]));
  return hash.digest("hex");
}
async function packText(file) {
  const s = await stat(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.size > 2 * 1024 * 1024 ||
      !samePath(await fs.realpath(file), file)) throw Error("模组文件不是普通文件：" + file);
  const bytes = await fs.readFile(file);
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error("文件不是有效 UTF-8，未修改：" + file); }
}
function parsedText(text, file) {
  const errors = [], data = jsonc.parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object") throw Error("模组 JSON 无法解析：" + file);
  return data;
}
async function planFiles(root, plan, files) {
  const file = path.join(root, storageName, "pack-plan.json"), before = await packText(file);
  if (before !== null) files.push({ file, before,
    after: editJsonText(before, kinds.map(k => [[k], plan[k]])) });
}
async function writePackChanges(root, plan, files, commit, nextPlan, expected, check = async () => {}) {
  if (expected && await packRevision(root, plan) !== expected) throw Error("模组文件已变化，请重新检查后再确认");
  files = files.filter(f => f.before !== f.after);
  if (!files.length && JSON.stringify(plan) === JSON.stringify(nextPlan))
    return { changed: false, backupPath: null };
  const base = path.join(root, ".toolbox-pack-backups");
  if (!(await directory(base))) await fs.mkdir(base);
  const backupPath = path.join(base, crypto.randomUUID());
  await fs.mkdir(backupPath);
  // 独立备份目录避免覆盖上一次恢复点，也不向旧包容器加入迁移不认识的文件。
  await fs.writeFile(path.join(backupPath, "restore.json"), JSON.stringify({
    plan, nextPlan, files: files.map((f, index) => ({ path: path.relative(root, f.file), backup: index + ".bak", existed: f.before !== null })),
  }, null, 2), { encoding: "utf8", flag: "wx" });
  for (const [index, f] of files.entries())
    if (f.before !== null) await fs.writeFile(path.join(backupPath, index + ".bak"), f.before, { encoding: "utf8", flag: "wx" });
  const written = [];
  try {
    await check();
    if (expected && await packRevision(root, plan) !== expected) throw Error("模组文件已变化，请重新检查");
    for (const f of files) {
      await directory(path.dirname(f.file));
      if (await packText(f.file) !== f.before) throw Error("文件在保存期间变化：" + f.file);
      await atomicWrite(f.file, f.after);
      written.push(f);
    }
    await check();
    await commit(nextPlan);
  } catch (error) {
    const failures = [];
    for (const f of written.reverse()) {
      try {
        if (await packText(f.file) !== f.after) throw Error("文件已被外部修改");
        if (f.before === null) await fs.unlink(f.file);
        else await atomicWrite(f.file, f.before);
      } catch { failures.push(path.relative(root, f.file)); }
    }
    throw Error(error.message + (failures.length ? "；部分文件未回滚：" + failures.join("、") : "；已撤回本次文件修改") + "；备份：" + backupPath);
  }
  return { changed: true, backupPath };
}
async function manifestChanges(p, changes, files) {
  for (const name of ["manifest.json", "pack_manifest.json"]) {
    const file = path.join(p.dir, name), before = await packText(file);
    if (before === null) continue;
    const data = parsedText(before, file);
    if (String(data.header?.uuid).toLowerCase() !== p.id ||
        JSON.stringify(data.modules) !== JSON.stringify(p.manifest.modules))
      throw Error("同目录两份 manifest 身份不一致，请先核对：" + p.dir);
    files.push({ file, before, after: editJsonText(before, changes) });
  }
}
async function syncWorldPackVersions(root, plan, commit, check) {
  const expected = await packRevision(root, plan), inspected = await inspectWorldPackVersions(root, plan);
  if (inspected.issues.some(i => i.status !== "version")) throw Error("存在缺包或类型问题，请先补齐正确模组");
  const files = [];
  for (const kind of kinds) for (const prefix of ["world_", "netease_world_"]) {
    const file = path.join(root, prefix + kind + "_packs.json"), before = await packText(file);
    if (before === null) continue;
    const list = parsedText(before, file);
    references(list, file);
    const changes = [];
    list.forEach((ref, i) => {
      const next = inspected.plan[kind].find(r => r.pack_id === ref.pack_id.toLowerCase());
      if (next && !sameVersion(ref.version, next.version)) changes.push([[i, "version"], next.version]);
    });
    files.push({ file, before, after: editJsonText(before, changes) });
  }
  await planFiles(root, inspected.plan, files);
  return { ...await writePackChanges(root, plan, files, commit, inspected.plan, expected, check), updated: inspected.issues.length, issues: inspected.issues };
}
function issue(code, value) {
  return { code, ...value };
}
async function inspectWorldPackHealth(root, plan) {
  const issues = [];
  if (!plan) {
    plan = { format: 1 };
    for (const kind of kinds) {
      const list = await readJson(path.join(root, "world_" + kind + "_packs.json"))
        || await readJson(path.join(root, "netease_world_" + kind + "_packs.json"));
      plan[kind] = list || [];
      if (!list) issues.push(issue("missing-list", { kind }));
    }
  }
  let refs;
  try { refs = validatePlan(plan); }
  catch (error) { refs = { behavior: [], resource: [] }; issues.push(issue("invalid-list", { detail: error.message })); }
  const
    listed = new Map(),
    packs = [],
    headers = new Map(),
    modules = new Map();
  for (const kind of kinds)
    for (const ref of refs[kind])
      listed.set(ref.pack_id, { ...ref, kind });
  const current = await layout(root);
  for (const kind of kinds) {
    const container = current.containers[kind].active;
    if (!(await directory(container))) continue;
    const entries = await fs.readdir(container, { withFileTypes: true });
    if (entries.length > 1000) throw Error("存档内置模组目录过多");
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        issues.push(issue("pack-link", { kind, packName: entry.name }));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const dir = path.join(container, entry.name);
      let p;
      try {
        p = await pack(dir);
      } catch (error) {
        issues.push(issue("invalid-manifest", {
          kind,
          packName: entry.name,
          detail: error.message,
        }));
        continue;
      }
      if (!p) {
        issues.push(issue("missing-manifest", { kind, packName: entry.name }));
        continue;
      }
      const listedRef = listed.get(p.id),
        modulesList = (p.manifest.modules || []).map((m) => ({
          uuid: typeof m?.uuid === "string" ? m.uuid.toLowerCase() : null,
          type: m?.type || null,
          version: Array.isArray(m?.version) ? [...m.version] : null,
        })),
        dependencies = Array.isArray(p.manifest.dependencies)
          ? p.manifest.dependencies.map((d) => ({
              uuid: typeof d === "string" ? d.toLowerCase() : String(d?.uuid || "").toLowerCase(),
              moduleName: typeof d?.module_name === "string" ? d.module_name : null,
              version: d?.version ?? null,
            }))
          : [];
      const record = {
        kind,
        packName: path.basename(p.dir),
        name: p.manifest.header.name || path.basename(p.dir),
        path: p.dir,
        packId: p.id,
        manifestFile: p.filename,
        version: [...p.version],
        expectedVersion: listedRef?.version || null,
        enabled: !!listedRef && listedRef.kind === kind && p.kind === kind,
        modules: modulesList,
        dependencies,
      };
      packs.push(record);
      const headerList = headers.get(p.id) || [];
      headerList.push(record);
      headers.set(p.id, headerList);
      if (p.kind !== kind)
        issues.push(issue("pack-type", {
          kind,
          packName: record.packName,
          packId: p.id,
          expectedKind: kind,
          actualKind: p.kind,
        }));
      for (const module of modulesList) {
        if (!uuid(module.uuid)) {
          issues.push(issue("invalid-module-uuid", {
            kind,
            packName: record.packName,
          }));
          continue;
        }
        const moduleList = modules.get(module.uuid) || [];
        moduleList.push(record);
        modules.set(module.uuid, moduleList);
      }
      if (!listedRef)
        issues.push(issue("unlisted-pack", {
          kind,
          packName: record.packName,
          packId: p.id,
        }));
      else if (listedRef.kind !== kind)
        issues.push(issue("pack-type", {
          kind,
          packName: record.packName,
          packId: p.id,
          expectedKind: listedRef.kind,
        }));
      else if (!sameVersion(p.version, listedRef.version))
        issues.push(issue("version-mismatch", {
          kind,
          packName: record.packName,
          packId: p.id,
          expected: [...listedRef.version],
          actual: [...p.version],
        }));
    }
  }
  for (const kind of kinds)
    for (const ref of refs[kind])
      if (!headers.has(ref.pack_id))
        issues.push(issue("missing-pack", {
          kind,
          packId: ref.pack_id,
          expected: [...ref.version],
        }));
  for (const [packId, list] of headers)
    if (list.length > 1)
      issues.push(issue("duplicate-pack-uuid", {
        packId,
        packs: list.map((p) => p.packName),
      }));
  for (const [moduleId, list] of modules)
    if (list.length > 1 || headers.has(moduleId))
      issues.push(issue("duplicate-module-uuid", {
        moduleId,
        packs: list.map((p) => p.packName),
      }));
  for (const packRecord of packs)
    for (const dependency of packRecord.dependencies) {
      if (!uuid(dependency.uuid)) {
        if (!dependency.moduleName) issues.push(issue("invalid-dependency", { packName: packRecord.packName }));
        continue;
      }
      const target = headers.get(dependency.uuid)?.[0];
      if (!target)
        issues.push(issue("missing-dependency", {
          packName: packRecord.packName,
          dependency: dependency.uuid,
          expected: dependency.version,
        }));
      else if (dependency.version && !sameVersion(dependency.version, target.version))
        issues.push(issue("dependency-version", {
          packName: packRecord.packName,
          dependency: dependency.uuid,
          expected: dependency.version,
          actual: target.version,
        }));
      else if (packRecord.enabled && !target.enabled)
        issues.push(issue("disabled-dependency", { packName: packRecord.packName, dependency: dependency.uuid }));
    }
  let revision = null, readOnlyReason = null;
  try { revision = await packRevision(root, plan); } catch (error) { readOnlyReason = error.message; }
  if (issues.some(i => ["invalid-list", "pack-link", "invalid-manifest", "missing-manifest", "duplicate-pack-uuid", "duplicate-module-uuid", "invalid-module-uuid", "invalid-dependency", "pack-type"].includes(i.code)))
    readOnlyReason ||= "存在无法唯一识别的模组或无效清单，请先修复这些问题";
  return {
    ok: issues.length === 0,
    revision,
    readOnlyReason,
    packs,
    issues,
    summary: {
      total: packs.length,
      behavior: packs.filter((p) => p.kind === "behavior").length,
      resource: packs.filter((p) => p.kind === "resource").length,
      enabled: packs.filter((p) => p.enabled).length,
      issueCount: issues.length,
    },
  };
}
function editJsonText(text, edits) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  let next = text.slice(bom.length);
  for (const [pathValue, value] of edits) {
    const node = jsonc.findNodeAtLocation(jsonc.parseTree(next), pathValue);
    // 仅替换目标值；保留原文件注释、缩进、BOM 和换行。
    if (node && value !== undefined && !Array.isArray(value) && typeof value !== "object")
      next = next.slice(0, node.offset) + JSON.stringify(value) + next.slice(node.offset + node.length);
    else next = jsonc.applyEdits(next, jsonc.modify(next, pathValue, value, {
      formattingOptions: { insertSpaces: !/\n\t/.test(next), tabSize: 4, eol: next.includes("\r\n") ? "\r\n" : "\n" },
    }));
  }
  return bom + next;
}
async function rewriteWorldPackUuids(root, plan, targetPackId, commit, check) {
  const health = await inspectWorldPackHealth(root, plan);
  if (health.readOnlyReason) throw Error(health.readOnlyReason);
  if (targetPackId !== undefined && !uuid(targetPackId)) throw Error("无效的模组 UUID");
  const expected = await packRevision(root, plan), available = await scan(root),
    selected = targetPackId ? [available.get(targetPackId.toLowerCase())] : [...available.values()];
  if (!selected.length || selected.some(p => !p)) throw Error("指定的存档模组不存在");
  const used = new Set([...available.keys()]);
  for (const p of available.values()) for (const m of p.manifest.modules || []) {
    if (!uuid(m?.uuid) || used.has(m.uuid.toLowerCase()))
      throw Error("模块 UUID 无效或重复，无法唯一重绑：" + p.dir);
    used.add(m.uuid.toLowerCase());
  }
  const nextUuid = () => {
    let value;
    do value = crypto.randomUUID(); while (used.has(value));
    used.add(value);
    return value;
  };
  const headers = new Map(), modules = new Map();
  for (const p of selected) {
    headers.set(p.id, nextUuid());
    for (const m of p.manifest.modules) modules.set(m.uuid.toLowerCase(), nextUuid());
  }
  const files = [];
  for (const p of available.values()) {
    const changes = [];
    if (headers.has(p.id)) changes.push([["header", "uuid"], headers.get(p.id)]);
    p.manifest.modules.forEach((m, i) => {
      if (modules.has(m.uuid.toLowerCase())) changes.push([["modules", i, "uuid"], modules.get(m.uuid.toLowerCase())]);
    });
    if (p.manifest.dependencies !== undefined && !Array.isArray(p.manifest.dependencies))
      throw Error("依赖清单格式无效：" + p.dir);
    (p.manifest.dependencies || []).forEach((d, i) => {
      const id = typeof d === "string" ? d : d?.uuid, next = typeof id === "string" && headers.get(id.toLowerCase());
      if (next) changes.push([typeof d === "string" ? ["dependencies", i] : ["dependencies", i, "uuid"], next]);
    });
    if (changes.length) await manifestChanges(p, changes, files);
  }
  for (const kind of kinds) for (const prefix of ["world_", "netease_world_"]) {
    const file = path.join(root, prefix + kind + "_packs.json"), before = await packText(file);
    if (before === null) continue;
    const list = parsedText(before, file);
    references(list, file);
    const changes = [];
    list.forEach((ref, i) => {
      const next = headers.get(ref.pack_id.toLowerCase());
      if (next) changes.push([[i, "pack_id"], next]);
    });
    files.push({ file, before, after: editJsonText(before, changes) });
  }
  const refs = validatePlan(plan), nextPlan = { ...plan };
  for (const kind of kinds) nextPlan[kind] = refs[kind].map(ref => ({ ...ref, pack_id: headers.get(ref.pack_id) || ref.pack_id }));
  await planFiles(root, nextPlan, files);
  return { ...await writePackChanges(root, plan, files, commit, nextPlan, expected, check),
    updated: selected.length, mapping: [...headers, ...modules].map(([from, to]) => ({ from, to })), plan: nextPlan };
}
async function editWorldPack(root, plan, packId, values, commit, check) {
  if (!uuid(packId) || !values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).some(k => !["name", "version", "enabled"].includes(k)))
    throw Error("无效的模组编辑参数");
  if (values.enabled !== undefined && typeof values.enabled !== "boolean") throw Error("启用状态必须是布尔值");
  if (values.name !== undefined && (typeof values.name !== "string" || !values.name.trim() ||
      values.name.length > 80 || /[\0\r\n]/.test(values.name))) throw Error("模组名称应为 1–80 个字符");
  if (values.version !== undefined && !version(values.version)) throw Error("模组版本必须是三个非负整数");
  const expected = await packRevision(root, plan), refs = validatePlan(plan), available = await scan(root),
    id = packId.toLowerCase(), selected = available.get(id);
  if (!selected) throw Error("指定的存档模组不存在");
  const nextVersion = values.version || selected.version, files = [], changes = [];
  if (values.name !== undefined) changes.push([["header", "name"], values.name.trim()]);
  if (values.version !== undefined) changes.push([["header", "version"], nextVersion]);
  if (changes.length) await manifestChanges(selected, changes, files);
  const nextPlan = { ...plan, behavior: refs.behavior.map(r => ({ ...r })), resource: refs.resource.map(r => ({ ...r })) };
  const list = nextPlan[selected.kind], index = list.findIndex(ref => ref.pack_id === id);
  if (values.enabled === false && index >= 0) list.splice(index, 1);
  else if (index >= 0 && values.version !== undefined) list[index].version = [...nextVersion];
  else if (index < 0 && values.enabled === true) list.push({ pack_id: id, version: [...nextVersion] });
  validatePlan(nextPlan);
  if (values.version !== undefined || values.enabled !== undefined) {
    for (const prefix of ["world_", "netease_world_"]) {
      const file = path.join(root, prefix + selected.kind + "_packs.json"), original = await packText(file);
      if (original === null && prefix === "netease_world_") continue;
      const before = original || "[]", parsed = parsedText(before, file);
      references(parsed, file);
      const at = parsed.findIndex(ref => ref.pack_id.toLowerCase() === id), edits = [];
      if (values.enabled === false && at >= 0) edits.push([[at], undefined]);
      else if (at >= 0 && values.version !== undefined) edits.push([[at, "version"], nextVersion]);
      else if (at < 0 && values.enabled === true) edits.push([[parsed.length], { pack_id: id, version: [...nextVersion] }]);
      files.push({ file, before: original, after: editJsonText(before, edits) });
    }
    if (values.version !== undefined) for (const p of available.values()) {
      const edits = [];
      (Array.isArray(p.manifest.dependencies) ? p.manifest.dependencies : []).forEach((d, i) => {
        if (typeof d?.uuid === "string" && d.uuid.toLowerCase() === id && Array.isArray(d.version))
          edits.push([["dependencies", i, "version"], nextVersion]);
      });
      // 自依赖与包头编辑合并，避免同一文件重复写入。
      if (edits.length) {
        const dependencyFiles = [];
        await manifestChanges(p, edits, dependencyFiles);
        for (const f of dependencyFiles) {
          const existing = files.find(x => x.file === f.file);
          if (existing) existing.after = editJsonText(existing.after, edits);
          else files.push(f);
        }
      }
    }
  }
  await planFiles(root, nextPlan, files);
  return { ...await writePackChanges(root, plan, files, commit, nextPlan, expected, check), packId: id, plan: nextPlan };
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
  packRevision,
  inspectWorldPacks,
  inspectWorldPackHealth,
  inspectWorldPackVersions,
  editWorldPack,
  prepareWorldPacks,
  rewriteWorldPackUuids,
  syncWorldPackVersions,
};
