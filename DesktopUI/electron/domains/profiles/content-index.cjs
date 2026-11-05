const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const jsonc = require("jsonc-parser");

const MAX_PACKS = 400;
const MAX_FILES_PER_PACK = 20000;
const MAX_ASSETS = 30000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_PARSE_IDENTIFIERS = 80;
const PACK_DIRS = new Set(["behavior_packs", "resource_packs"]);
const SKIP_DIRS = new Set([".git", ".toolbox-packs", "db", "region", "DIM-1", "DIM1"]);
const ASSET_TYPES = ["item", "block", "entity", "model", "animation", "texture", "particle", "script", "ui", "language", "data", "other"];

const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const version = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isInteger(n) && n >= 0);
const normalize = value => value.split(path.sep).join("/");
const isNamespaced = value => typeof value === "string" && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(value);
const isIdentifier = value => isNamespaced(value) || /^(geometry|animation|controller|render_controller|particle)\.[a-z0-9_.-]+$/i.test(value);

async function lstatSafe(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function safeDirectory(dir) {
  const stat = await lstatSafe(dir);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(dir)).toLowerCase() !== path.resolve(dir).toLowerCase())
    throw Error("内容来源不是普通目录：" + dir);
  return true;
}

async function readJson(file) {
  const stat = await lstatSafe(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw Error("内容 JSON 无效或超过读取上限：" + file);
  const text = await fs.readFile(file, "utf8");
  const errors = [];
  const data = jsonc.parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object") throw Error("内容 JSON 无法解析：" + file);
  return data;
}

function manifestInfo(data, file) {
  const header = data?.header;
  const modules = Array.isArray(data?.modules) ? data.modules : [];
  const module = modules.find(item => item?.type === "data" || item?.type === "resources");
  if (!header || !uuid(header.uuid) || !version(header.version) || !module) throw Error("manifest 缺少有效 UUID、版本或模块：" + file);
  return {
    id: header.uuid.toLowerCase(),
    name: typeof header.name === "string" ? header.name : path.basename(path.dirname(file)),
    version: [...header.version],
    kind: module.type === "data" ? "behavior" : "resource",
    modules: modules.filter(item => item && typeof item === "object").map(item => ({ uuid: item.uuid || null, type: item.type || null, version: item.version || null })),
    dependencies: Array.isArray(data.dependencies) ? data.dependencies.map(item => ({ uuid: item?.uuid || null, moduleName: item?.module_name || null, version: item?.version || null })) : [],
    formatVersion: data.format_version ?? null,
    minEngineVersion: data.header?.min_engine_version || null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities.slice(0, 30) : [],
    metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : null,
    subpacks: data.subpacks && typeof data.subpacks === "object" ? { name: data.subpacks.name || null, range: data.subpacks.range || null } : null,
  };
}

function fileType(relative, parsed) {
  const file = relative.toLowerCase();
  const ext = path.extname(file);
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") return "texture";
  if (file.includes("animation") || file.endsWith(".animation.json")) return "animation";
  if (file.includes("geometry") || file.endsWith(".geo.json") || file.includes("/models/")) return "model";
  if (file.includes("particle")) return "particle";
  if (file.includes("item_texture") || file.includes("terrain_texture")) return "data";
  if (file.includes("/items/") || file.includes("netease_items")) return "item";
  if (file.includes("/blocks/") || file.includes("netease_blocks")) return "block";
  if (file.includes("client_entity") || file.includes("/entities/") || file.includes("/entity/")) return "entity";
  if (file.includes("/scripts/") || ext === ".py" || ext === ".js") return "script";
  if (file.includes("/ui/") || file.endsWith("/ui.json")) return "ui";
  if (file.includes("/texts/") || file.endsWith(".lang")) return "language";
  if (parsed && (file.endsWith(".json") || file.endsWith(".jsonc"))) return "data";
  return ASSET_TYPES.includes(ext.slice(1)) ? ext.slice(1) : "other";
}

function collectIdentifiers(value, key = "", result = [], depth = 0) {
  if (result.length >= MAX_PARSE_IDENTIFIERS || depth > 6 || value == null) return result;
  if (typeof value === "string") {
    if (isIdentifier(value) && (key === "identifier" || key === "name" || key === "geometry" || key === "model" || key === "texture" || key === "animation" || key === "id" || key === "type")) result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIdentifiers(item, key, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [name, item] of Object.entries(value)) {
    if (isIdentifier(name) && (depth === 0 || key === "animations" || key === "items" || key === "blocks" || key === "entities" || key === "geometries")) result.push(name);
    collectIdentifiers(item, name, result, depth + 1);
    if (result.length >= MAX_PARSE_IDENTIFIERS) break;
  }
  return result;
}

function identifierSummary(parsed, type, relative) {
  const identifiers = [...new Set(collectIdentifiers(parsed))];
  if (!identifiers.length && (type === "model" || type === "animation") && parsed && typeof parsed === "object") {
    const section = type === "animation" ? parsed.animations : parsed["minecraft:geometry"];
    if (section && typeof section === "object") identifiers.push(...Object.keys(section).filter(isIdentifier));
  }
  return [...new Set(identifiers)].slice(0, MAX_PARSE_IDENTIFIERS).map(String).sort();
}

function labelFor(relative, identifiers) {
  return identifiers[0] || path.basename(relative).replace(/\.(geo|animation)\.json$/i, "").replace(/\.jsonc?$/i, "");
}

function parseLang(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || value.startsWith("//")) continue;
    const at = value.indexOf("=");
    if (at <= 0) continue;
    const key = value.slice(0, at).trim();
    if (key && !result[key]) result[key] = value.slice(at + 1).trim();
  }
  return result;
}

function textureRefs(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) textureRefs(item, result);
  else if (value && typeof value === "object") for (const item of Object.values(value)) textureRefs(item, result);
  return [...new Set(result)].filter(Boolean).slice(0, 20);
}

function textureMap(parsed) {
  const root = parsed?.texture_data || parsed?.textures || {};
  if (!root || typeof root !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(root)) {
    const refs = textureRefs(value?.textures ?? value);
    if (refs.length) result[key] = refs;
  }
  return result;
}

function summarize(value, depth = 0) {
  if (depth > 2) return "…";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(item => summarize(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, summarize(item, depth + 1)]));
  return String(value);
}

function definitions(parsed, type) {
  const result = [], seen = new Set();
  function add(identifier, value) {
    if (!isIdentifier(identifier) || ["minecraft:item", "minecraft:block", "minecraft:entity", "minecraft:client_entity"].includes(identifier) || seen.has(identifier) || !value || typeof value !== "object") return;
    seen.add(identifier);
    const components = value.components || value["minecraft:item"]?.components || value["minecraft:block"]?.components || null;
    result.push({ identifier, properties: Object.keys(value).slice(0, 40), components: components && typeof components === "object" ? Object.keys(components).slice(0, 80) : [], componentValues: components && typeof components === "object" ? summarize(components) : null });
  }
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6 || result.length >= 500) return;
    if (typeof value.description?.identifier === "string") add(value.description.identifier, value);
    for (const [key, item] of Object.entries(value)) {
      if (isIdentifier(key)) add(key, item);
      visit(item, depth + 1);
    }
  }
  visit(parsed);
  return result.filter(item => type === "item" || type === "block" ? !item.identifier.startsWith("geometry.") && !item.identifier.startsWith("animation.") : true);
}

function modelDetails(parsed) {
  const geometries = Array.isArray(parsed?.["minecraft:geometry"]) ? parsed["minecraft:geometry"] : Array.isArray(parsed?.geometry) ? parsed.geometry : [];
  return geometries.map(geometry => {
    const description = geometry?.description || {};
    const bones = Array.isArray(geometry?.bones) ? geometry.bones : [];
    return { identifier: description.identifier || null, textureWidth: description.texture_width || null, textureHeight: description.texture_height || null, bones: bones.length, cubes: bones.reduce((sum, bone) => sum + (Array.isArray(bone?.cubes) ? bone.cubes.length : 0), 0), boneNames: bones.map(bone => bone.name).filter(Boolean).slice(0, 80) };
  });
}

function animationDetails(parsed) {
  const animations = parsed?.animations && typeof parsed.animations === "object" ? parsed.animations : {};
  return Object.entries(animations).slice(0, 200).map(([identifier, value]) => ({ identifier, length: value?.animation_length ?? null, loop: value?.loop ?? false, bones: value?.bones && typeof value.bones === "object" ? Object.keys(value.bones).length : 0 }));
}

function entityDetails(parsed) {
  const description = parsed?.["minecraft:client_entity"]?.description || parsed?.description || {};
  const geometry = description.geometry && typeof description.geometry === "object" ? Object.keys(description.geometry) : [];
  const textures = description.textures && typeof description.textures === "object" ? Object.values(description.textures).filter(value => typeof value === "string") : [];
  const animations = Array.isArray(description.animations) ? description.animations : description.animations && typeof description.animations === "object" ? Object.keys(description.animations) : [];
  return { geometry, textures, animations };
}

function displayName(identifier, lang) {
  const short = identifier.includes(":") ? identifier.split(":")[1] : identifier;
  return lang[`item.${identifier}.name`] || lang[`block.${identifier}.name`] || lang[`tile.${identifier}.name`] || lang[`${identifier}.name`] || lang[`item.${short}.name`] || lang[`tile.${short}.name`] || null;
}

async function imageData(file) {
  const stat = await lstatSafe(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PREVIEW_BYTES) return null;
  const ext = path.extname(file).toLowerCase();
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext];
  if (!mime) return null;
  return `data:${mime};base64,${(await fs.readFile(file)).toString("base64")}`;
}

async function resolveTexture(dir, refs) {
  for (const ref of refs || []) {
    const clean = String(ref).replace(/^\//, "").replace(/\.png$/i, "");
    const candidates = [path.join(dir, clean + ".png"), path.join(dir, "textures", clean + ".png"), path.join(dir, "textures", clean)];
    for (const candidate of candidates) {
      const preview = await imageData(candidate);
      if (preview) return { path: candidate, preview };
    }
  }
  return null;
}

async function enrichPack(pack, files, lang, textures) {
  const entries = [];
  for (const asset of pack.assets) {
    const parsed = files.get(asset.relative);
    if (asset.type === "language") continue;
    if (asset.type === "item" || asset.type === "block") {
      for (const definition of definitions(parsed, asset.type)) {
        const refs = textures[definition.identifier] || textures[definition.identifier.split(":")[1]] || [];
        const texture = await resolveTexture(pack.path, refs);
        entries.push({ id: `${asset.id}:${definition.identifier}`, sourceAssetId: asset.id, sourceId: asset.sourceId, packId: asset.packId, packName: asset.packName, kind: asset.kind, type: asset.type, identifier: definition.identifier, label: displayName(definition.identifier, lang) || definition.identifier, displayName: displayName(definition.identifier, lang), properties: definition.properties, components: definition.components, componentValues: definition.componentValues, texture, path: asset.path, relative: asset.relative, status: asset.status, error: asset.error });
      }
    } else if (asset.type === "model") {
      for (const model of modelDetails(parsed)) entries.push({ id: `${asset.id}:${model.identifier || asset.relative}`, sourceAssetId: asset.id, sourceId: asset.sourceId, packId: asset.packId, packName: asset.packName, kind: asset.kind, type: "model", identifier: model.identifier, label: model.identifier || asset.label, model, path: asset.path, relative: asset.relative, status: asset.status, error: asset.error });
    } else if (asset.type === "animation") {
      for (const animation of animationDetails(parsed)) entries.push({ id: `${asset.id}:${animation.identifier}`, sourceAssetId: asset.id, sourceId: asset.sourceId, packId: asset.packId, packName: asset.packName, kind: asset.kind, type: "animation", identifier: animation.identifier, label: animation.identifier, animation, path: asset.path, relative: asset.relative, status: asset.status, error: asset.error });
    } else if (asset.type === "entity") {
      const entity = entityDetails(parsed);
      entries.push({ id: asset.id, sourceAssetId: asset.id, sourceId: asset.sourceId, packId: asset.packId, packName: asset.packName, kind: asset.kind, type: "entity", identifier: asset.identifiers[0] || null, label: asset.label, entity, path: asset.path, relative: asset.relative, status: asset.status, error: asset.error });
    }
  }
  return entries;
}

async function listPackDirs(source, targetPackId = null) {
  const result = [], seen = new Set();
  async function visit(dir, depth) {
    if (result.length >= MAX_PACKS || depth > 4) return;
    const real = path.resolve(dir).toLowerCase();
    if (seen.has(real) || !(await safeDirectory(dir))) return;
    seen.add(real);
    for (const filename of ["manifest.json", "pack_manifest.json"]) {
      if (!(await lstatSafe(path.join(dir, filename)))) continue;
      if (!targetPackId) { result.push({ dir, filename }); return; }
      try {
        const info = manifestInfo(await readJson(path.join(dir, filename)), path.join(dir, filename));
        if (info.id === String(targetPackId).toLowerCase()) result.push({ dir, filename });
      } catch { /* 当前目标包已由存档包检查确认；其他坏包不阻塞定向扫描。 */ }
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
      if (depth === 0 && !PACK_DIRS.has(entry.name) && entries.length > 200) continue;
      await visit(path.join(dir, entry.name), depth + 1);
      if (result.length >= MAX_PACKS) return;
    }
  }
  await visit(source, 0);
  return result;
}

async function scanPack(source, sourceId, packEntry) {
  const { dir, filename } = packEntry;
  const manifestPath = path.join(dir, filename);
  const issues = [], assets = [], counts = Object.fromEntries(ASSET_TYPES.map(type => [type, 0])), files = new Map(), lang = {}, textures = {};
  let manifest, info;
  try { manifest = await readJson(manifestPath); info = manifestInfo(manifest, manifestPath); }
  catch (error) {
    return { sourceId, id: sha(dir).slice(0, 24), name: path.basename(dir), kind: "unknown", version: null, path: dir, manifestFile: filename, dependencies: [], assets: [], entries: [], counts, issues: [{ code: "invalid-manifest", message: error.message }] };
  }
  const stack = [dir]; let scannedFiles = 0;
  while (stack.length && scannedFiles < MAX_FILES_PER_PACK && assets.length < MAX_ASSETS) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (scannedFiles >= MAX_FILES_PER_PACK || assets.length >= MAX_ASSETS) break;
      if (entry.isSymbolicLink()) { issues.push({ code: "symlink", message: "跳过链接：" + entry.name }); continue; }
      const full = path.join(current, entry.name), relative = normalize(path.relative(dir, full));
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) stack.push(full); continue; }
      if (!entry.isFile()) continue;
      scannedFiles++;
      if (relative === filename) continue;
      const stat = await fs.stat(full);
      let parsed = null, parseError = "";
      if (/\.(json|jsonc)$/i.test(entry.name) && stat.size <= MAX_JSON_BYTES) {
        try { parsed = await readJson(full); } catch (error) { parseError = error.message; issues.push({ code: "invalid-json", path: relative, message: error.message }); }
      }
      const type = fileType(relative, parsed);
      files.set(relative, parsed);
      const preview = type === "texture" ? await imageData(full) : null;
      if (type === "language" && stat.size <= MAX_JSON_BYTES) Object.assign(lang, parseLang(await fs.readFile(full, "utf8")));
      if (type === "data" && /(?:item_texture|terrain_texture)\.jsonc?$/i.test(entry.name)) Object.assign(textures, textureMap(parsed));
      if (!counts[type]) counts[type] = 0;
      counts[type]++;
      if (type === "other" && !parseError) continue;
      const identifiers = parsed ? identifierSummary(parsed, type, relative) : [];
      assets.push({
        id: sha(info.id + ":" + relative).slice(0, 24), sourceId, packId: info.id, packName: info.name,
        kind: info.kind, type, label: labelFor(relative, identifiers), identifiers, path: full, relative,
        size: stat.size, format: path.extname(entry.name).replace(/^\./, "").toLowerCase() || null, preview,
        status: parseError ? "error" : "ok", error: parseError || null,
      });
    }
  }
  if (scannedFiles >= MAX_FILES_PER_PACK) issues.push({ code: "file-limit", message: `文件超过 ${MAX_FILES_PER_PACK} 个，扫描已截断` });
  if (assets.length >= MAX_ASSETS) issues.push({ code: "asset-limit", message: `内容超过 ${MAX_ASSETS} 项，扫描已截断` });
  const pack = { sourceId, id: info.id, name: info.name, kind: info.kind, version: info.version, path: dir, manifestFile: filename,
    modules: info.modules, dependencies: info.dependencies, formatVersion: info.formatVersion, minEngineVersion: info.minEngineVersion, capabilities: info.capabilities, metadata: info.metadata, subpacks: info.subpacks, languages: Object.keys(lang).length, languageMap: lang, textureCatalog: textures, assets, entries: [], counts, files: scannedFiles, issues };
  pack.entries = await enrichPack(pack, files, lang, textures);
  return pack;
}

class ContentIndex {
  constructor(modLibrary) { this.modLibrary = modLibrary; this.queue = Promise.resolve(); }
  scan(options = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const catalog = options.root
        ? { mods: [{ id: options.sourceId || sha(options.root).slice(0, 24), name: options.sourceName || path.basename(options.root), path: options.root, available: true, error: "" }] }
        : await this.modLibrary.list();
      const sources = [], packs = [], assets = [], entries = [], issues = [];
      for (const mod of catalog.mods) {
        const sourceId = mod.id || sha(mod.path).slice(0, 24);
        const source = { id: sourceId, name: mod.name, path: mod.path, available: mod.available, packs: 0, files: 0, assets: 0, counts: Object.fromEntries(ASSET_TYPES.map(type => [type, 0])), issues: [] };
        sources.push(source);
        if (!mod.available) { source.issues.push({ code: "source-missing", message: mod.error || "目录不存在或无法读取" }); continue; }
        try {
          const packDirs = await listPackDirs(mod.path, options.packId);
          if (!packDirs.length) source.issues.push({ code: "missing-manifest", message: "未发现 manifest.json 或 pack_manifest.json" });
          for (const packEntry of packDirs) {
            const pack = await scanPack(mod.path, sourceId, packEntry);
            packs.push(pack); source.packs++; source.files += pack.files || 0; source.assets += pack.assets.length;
            for (const [type, count] of Object.entries(pack.counts)) source.counts[type] = (source.counts[type] || 0) + count;
            source.issues.push(...pack.issues.map(issue => ({ ...issue, packId: pack.id, packName: pack.name })));
            assets.push(...pack.assets); entries.push(...pack.entries);
          }
        } catch (error) { source.issues.push({ code: "scan-error", message: error.message }); }
        source.issues = source.issues.slice(0, 200);
        issues.push(...source.issues.map(issue => ({ ...issue, sourceId, sourceName: source.name })));
      }
      const globalLang = Object.assign({}, ...packs.map(pack => pack.languageMap || {}));
      const globalTextures = Object.assign({}, ...packs.map(pack => pack.textureCatalog || {}));
      const resourcePacks = packs.filter(pack => pack.kind === "resource");
      for (const entry of entries) {
        if ((entry.type === "item" || entry.type === "block") && !entry.displayName) {
          entry.displayName = displayName(entry.identifier, globalLang);
          if (entry.displayName) entry.label = entry.displayName;
        }
        if ((entry.type === "item" || entry.type === "block") && !entry.texture) {
          const refs = globalTextures[entry.identifier] || globalTextures[entry.identifier?.split(":")[1]] || [];
          for (const pack of resourcePacks) {
            entry.texture = await resolveTexture(pack.path, refs);
            if (entry.texture) break;
          }
        }
      }
      for (const pack of packs) { delete pack.languageMap; delete pack.textureCatalog; }
      const byIdentifier = new Map();
      for (const asset of assets) for (const identifier of asset.identifiers || []) {
        const key = asset.type + ":" + identifier.toLowerCase();
        const list = byIdentifier.get(key) || []; list.push(asset); byIdentifier.set(key, list);
      }
      let duplicateCount = 0;
      for (const [key, list] of byIdentifier) if (list.length > 1) {
        duplicateCount++;
        const separator = key.indexOf(":");
        const type = key.slice(0, separator), identifier = key.slice(separator + 1);
        issues.push({ code: "duplicate-identifier", type, identifier, assets: list.map(item => item.id), message: `${identifier} 在 ${list.length} 个内容文件中重复` });
        for (const asset of list) asset.status = asset.status === "error" ? "error" : "warning";
      }
      const counts = Object.fromEntries(ASSET_TYPES.map(type => [type, assets.filter(asset => asset.type === type).length]));
      for (const type of ["item", "block", "entity", "model", "animation"]) {
        const semanticSourceIds = new Set(entries.filter(entry => entry.type === type).map(entry => entry.sourceAssetId));
        counts[type] = entries.filter(entry => entry.type === type).length + assets.filter(asset => asset.type === type && !semanticSourceIds.has(asset.id)).length;
      }
      return {
        generatedAt: new Date().toISOString(), sources, packs, assets, entries,
        issues: issues.slice(0, 500),
        summary: { sourceCount: sources.length, availableSourceCount: sources.filter(source => source.available).length, packCount: packs.length, assetCount: assets.length + entries.length, fileCount: assets.length, entryCount: entries.length, issueCount: issues.length, duplicateCount, counts },
        limits: { maxPacks: MAX_PACKS, maxFilesPerPack: MAX_FILES_PER_PACK, maxAssets: MAX_ASSETS },
      };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { ContentIndex, ASSET_TYPES, fileType, identifierSummary };
