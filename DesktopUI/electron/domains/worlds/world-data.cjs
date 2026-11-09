const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const nbt = require("prismarine-nbt");
const { Database } = require("@jsprismarine/leveldb");
const { safeDirectory, readFile, extractArchive, levelFormat, parseAnvilChunk } = require("./map-preview.cjs");
const { parseNbtRecord, MAX_BYTES } = require("./world-data-codec.cjs");
const { businessObjects, references } = require("../../../shared/world-data-model.cjs");
const { ContentIndex } = require("../profiles/content-index.cjs");

async function sourceFiles(root) {
  const files = [];
  async function visit(relative) {
    const dir = path.join(root, relative);
    if (!await fs.lstat(dir).catch(e => { if (e.code === "ENOENT") return null; throw e; })) return;
    await safeDirectory(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = path.join(relative, entry.name), stat = await fs.lstat(path.join(root, name));
      if (stat.isSymbolicLink()) throw Error("存档数据包含链接");
      if (stat.isDirectory()) { await visit(name); continue; }
      if (!stat.isFile()) throw Error("存档数据包含特殊文件");
      files.push([name, stat.size, stat.mtimeMs, stat.ctimeMs]);
      if (files.length > 100000) throw Error("存档数据文件超过读取限制");
    }
  }
  for (const dir of ["db", "region", "entities", "DIM-1", "DIM1", "playerdata", "data", "behavior_packs", "resource_packs"]) await visit(dir);
  const stat = await fs.lstat(path.join(root, "level.dat"));
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error("level.dat 无效");
  files.push(["level.dat", stat.size, stat.mtimeMs, stat.ctimeMs]);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}

async function scanWorldData({ source, dataRoot, scope = "all", onProgress = () => {} }) {
  if (typeof source !== "string" || !path.isAbsolute(source)) throw Error("请选择存档来源");
  if (!["all", "gameplay", "world", "entities"].includes(scope)) throw Error("数据读取范围无效");
  let root = source;
  if (/\.(zip|mcworld)$/i.test(source)) {
    await fs.mkdir(dataRoot, { recursive: true });
    await safeDirectory(dataRoot);
    root = path.join(dataRoot, "world");
    onProgress("解压只读来源", 0, null);
    await extractArchive(source, root);
  }
  await safeDirectory(root);
  const before = await sourceFiles(root);
  const level = await readFile(path.join(root, "level.dat"), MAX_BYTES);
  const format = levelFormat(level), objects = [], issues = [], statistics = { keys: 0, records: 0, ignored: 0, failed: 0 };
  let bytes = 0, truncated = false;
  const add = object => {
    const size = Buffer.byteLength(JSON.stringify(object));
    if (objects.length >= 20000 || bytes + size > 24 * 1024 * 1024) { truncated = true; return; }
    bytes += size; objects.push(object);
  };
  const fail = (key, error) => { statistics.failed++; if (issues.length < 200) issues.push({ key, message: error.message }); };
  function record(parsed, key, offset, kind, dimension = null) {
    const value = parsed.value;
    const position = Array.isArray(value.Pos) ? value.Pos : [value.x, value.y, value.z];
    const positioned = position.length === 3 && position.every(Number.isFinite);
    dimension = value.DimensionId ?? value.LastDimensionId ?? dimension;
    if (kind === "blockEntity" && typeof value.Command === "string") kind = "command";
    else if (kind === "blockEntity" && (Array.isArray(value.Items) || Array.isArray(value.ChestItems))) kind = "container";
    else if (kind === "entity" && [value.identifier, value.id].some(name => typeof name === "string" && /npc/i.test(name))) kind = "npc";
    const uuid = value.UniqueID ?? value.UUID;
    const identity = ["command", "container", "blockEntity"].includes(kind) && positioned
      ? kind + ":" + dimension + ":" + position.join(",")
      : ["entity", "npc"].includes(kind) && uuid != null ? "entity:" + JSON.stringify(uuid)
        : key + ":" + offset;
    const object = { id: key + ":" + offset, identity, kind, name: [value.CustomName, value.identifier, value.id].find(name => typeof name === "string" && name) || key,
      position: positioned ? position : null, dimension, value, types: parsed.types,
      evidence: { key, offset, bytes: parsed.size, field: "" }, rule: format === "java" ? "Java NBT" : "Bedrock NBT" };
    statistics.records++;
    for (const warning of parsed.warnings) fail(key + warning.path, Error(warning.message));
    const include = scope === "all" || scope === "gameplay" && ["world", "npc", "command", "container"].includes(kind) || scope === "world" && ["world", "player"].includes(kind) || scope === "entities" && ["entity", "npc", "world"].includes(kind);
    if (!include) return;
    add(object);
    for (const item of businessObjects(object)) add(item);
  }
  const parseMany = (raw, key, kind, dimension, options = {}) => {
    let offset = 0;
    while (offset < raw.length && !truncated) {
      const parsed = parseNbtRecord(raw.subarray(offset), options);
      record(parsed, key, offset, kind, dimension);
      offset += parsed.size;
    }
  };
  parseMany(format === "java" ? zlib.gunzipSync(level, { maxOutputLength: MAX_BYTES }) : level.subarray(8), "level.dat", "world", null, { little: format !== "java" });
  if (format === "bedrock") {
    const db = await Database.open(path.join(root, "db"), { readOnly: true, createIfMissing: false });
    try {
      for (const key of db.keys()) {
        if (truncated) break;
        if (++statistics.keys > 5000000) { truncated = true; break; }
        const name = key.toString("utf8"); let kind, dimension = null;
        if (name.startsWith("actorprefix")) kind = "entity";
        else if (name.startsWith("structuretemplate_")) kind = "structure";
        else if (name === "~local_player" || name.startsWith("player_")) kind = "player";
        else if (["scriptData", "scoreboard", "neteaseData"].includes(name)) kind = "world";
        else if ([9, 13].includes(key.length) && [0x31, 0x32].includes(key.at(-1))) { kind = key.at(-1) === 0x31 ? "blockEntity" : "entity"; dimension = key.length === 13 ? key.readInt32LE(8) : 0; }
        else { statistics.ignored++; continue; }
        const label = /^[\x20-\x7e]+$/.test(name) ? name : "hex:" + key.toString("hex");
        try { parseMany(db.get(key), label, kind, dimension, { worldScript: name === "scriptData" }); }
        catch (error) { fail(label, error); }
        if (statistics.keys % 100 === 0) { onProgress("读取已保存世界数据", statistics.keys, null); await new Promise(resolve => setImmediate(resolve)); }
      }
    } finally { await db.close(); }
  } else {
    for (const [relative] of before) {
      if (truncated) break;
      const name = relative.replace(/\\/g, "/"), dimension = name.startsWith("DIM-1/") ? 1 : name.startsWith("DIM1/") ? 2 : 0;
      if (name.endsWith(".mca")) {
        try {
          const buffer = await readFile(path.join(root, relative), 64 * 1024 * 1024);
          for (let index = 0; index < 1024 && !truncated; index++) {
            try {
              const chunk = parseAnvilChunk(buffer, index); if (!chunk) continue;
              const parsed = parseNbtRecord(nbt.writeUncompressed(chunk), { little: false });
              const value = parsed.value.Level || parsed.value;
              for (const [field, kind] of [["block_entities", "blockEntity"], ["TileEntities", "blockEntity"], ["Entities", "entity"], ["entities", "entity"]]) {
                for (const [i, item] of (value[field] || []).entries()) {
                  record({ value: item, size: parsed.size, types: parsed.types, warnings: [] }, name, index + "/" + field + "/" + i, kind, dimension);
                }
              }
              statistics.keys++;
            } catch (error) { fail(name + ":" + index, error); }
          }
        } catch (error) { fail(name, error); }
      } else if (/^(playerdata|data)\/.*\.dat$/.test(name)) {
        try { parseMany(zlib.gunzipSync(await readFile(path.join(root, relative), MAX_BYTES), { maxOutputLength: MAX_BYTES }), name, name.startsWith("playerdata") ? "player" : "world", null, { little: false }); }
        catch (error) { fail(name, error); }
      }
      onProgress("读取 Java 世界对象", statistics.records, null);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  if (!truncated) {
    onProgress("读取存档内物品定义", 0, null);
    const content = await new ContentIndex(null).scan({ root, sourceId: "world" });
    for (const item of content.entries.filter(entry => entry.type === "item")) add({ id: "item:" + path.relative(root, item.path) + ":" + item.identifier, identity: "item:" + item.identifier, kind: "item", name: item.displayName || item.identifier,
      value: { identifier: item.identifier, components: item.componentValues, properties: item.properties, pack: item.packName }, types: {}, evidence: { key: path.relative(root, item.path).replace(/\\/g, "/"), field: "", offset: null }, rule: "存档内物品定义（存在不代表已启用）" });
    for (const issue of content.issues.filter(issue => !["missing-manifest", "duplicate-identifier"].includes(issue.code))) fail(issue.path || "world-packs", Error(issue.message));
  }
  if (JSON.stringify(before) !== JSON.stringify(await sourceFiles(root))) throw Error("来源在扫描期间变化，请保存退出游戏后重新读取");
  onProgress("分析已识别引用", objects.length, objects.length);
  const relations = references(objects);
  if (relations.length >= 20000) { truncated = true; issues.push({ key: "relations", message: "引用达到 20000 条上限，关系结果已截断" }); }
  return { source, format, scope, generatedAt: new Date().toISOString(), complete: !truncated && !statistics.failed, truncated, statistics, issues, objects, relations,
    coverage: "已保存的受支持记录；未生成区块、内存状态、外部模组定义及动态脚本不在本次检查范围。实体记录不代表当前加载或存活状态。", rules: ["NBT", "网易 scriptData 16/32 位与 MessagePack", "Custom NPC V3", "Quest Engine quest_item/allitem", "Miao Command Library V2"] };
}
module.exports = { scanWorldData, sourceFiles };
