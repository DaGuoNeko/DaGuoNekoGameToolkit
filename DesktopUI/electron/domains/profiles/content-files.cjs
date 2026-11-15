const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const jsonc = require("jsonc-parser");
const { publishBones } = require("../../../shared/model-edit.cjs");
const { controllerId, validateControllers, createController } = require("../../../shared/animation-controller.cjs");
const { normalizeDisplay } = require("../../../shared/model-display.cjs");
const { assignedTextures } = require("../../../shared/model-materials.cjs");
const { pngInfo } = require("../skins/npc-skins.cjs");
const { templateRects, validateSize } = require("../../../shared/model-uv.cjs");
const { inspectSelection, verifySelection } = require("../../file-selection.cjs");
const { readLayerPng, writeLayerPng, digest } = require("./texture-layers.cjs");
const { renameWithRetry } = require("../../file-rename.cjs");
const { randomUUID } = require("node:crypto");
const textureWrites = new Map();
const controllerWrites = new Set();

function badName(name) {
  return typeof name !== "string" || !name.trim() || name.trim().length > 80 || name.includes("\n") || name.includes("\r");
}

function versionOf(value) {
  return Array.isArray(value) && value.length === 3 && value.every(item => Number.isInteger(item) && item >= 0);
}

function formatting(text) {
  return { insertSpaces: !/\n\t/.test(text), tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

async function ownedFile(modLibrary, file, worldRoot, studioRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("无效的文件路径");
  const resolved = path.resolve(file);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error("只能修改普通文件");
  const real = await fs.realpath(resolved);
  if (path.resolve(real).toLowerCase() !== resolved.toLowerCase()) throw Error("文件路径被重定向");
  const roots = [];
  if (studioRoot) roots.push(studioRoot);
  if (worldRoot) roots.push(worldRoot);
  const catalog = await modLibrary.list();
  for (const mod of catalog.mods || []) if (mod.available !== false && mod.path) roots.push(mod.path);
  const target = real.toLowerCase();
  for (const root of roots) {
    let base;
    try { base = path.resolve(await fs.realpath(root)).toLowerCase(); } catch { continue; }
    if (target === base || target.startsWith(base + path.sep)) return real;
  }
  throw Error("只能修改工具箱里的模型，或已登记模组、当前存档里的文件");
}

async function saveManifest(modLibrary, args, worldRoot) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (badName(name)) throw Error("名称应为 1–80 个字符");
  if (!versionOf(args.version)) throw Error("版本必须是三个非负整数");
  const file = await ownedFile(modLibrary, path.join(args.directory || "", args.manifestFile || ""), worldRoot);
  if (!/^(manifest|pack_manifest)\.json$/i.test(path.basename(file))) throw Error("只能修改包清单");
  const text = await fs.readFile(file, "utf8");
  const options = { formattingOptions: formatting(text) };
  let next = jsonc.applyEdits(text, jsonc.modify(text, ["header", "name"], name, options));
  next = jsonc.applyEdits(next, jsonc.modify(next, ["header", "version"], args.version, options));
  await fs.copyFile(file, file + ".bak");
  await fs.writeFile(file, next);
  return { path: file, name, version: args.version };
}

async function readGeometry(modLibrary, file, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, file, worldRoot, studioRoot);
  const text = await fs.readFile(real, "utf8");
  const errors = [];
  const data = jsonc.parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object") throw Error("模型文件无法解析");
  const list = Array.isArray(data["minecraft:geometry"]) ? data["minecraft:geometry"] : [];
  return {
    path: real,
    geometries: list.map(geometry => ({
      identifier: geometry?.description?.identifier || "",
      textureWidth: geometry?.description?.texture_width || 64,
      textureHeight: geometry?.description?.texture_height || 64,
      bones: Array.isArray(geometry?.bones) ? geometry.bones : [],
      display: normalizeDisplay(data?.dgn_display?.[geometry?.description?.identifier]),
    })),
  };
}

async function saveGeometry(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  const identifier = typeof args.identifier === "string" ? args.identifier : "";
  if (!identifier || !Array.isArray(args.bones) || args.bones.length > 400) throw Error("模型数据无效");
  const text = await fs.readFile(real, "utf8");
  const errors = [];
  const data = jsonc.parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  const list = Array.isArray(data?.["minecraft:geometry"]) ? data["minecraft:geometry"] : [];
  const index = list.findIndex(geometry => geometry?.description?.identifier === identifier);
  if (index < 0) throw Error("文件里没有这个模型");
  const bound = assignedTextures(args.bones);
  if (bound.length * (args.textureWidth ?? list[index].description?.texture_width) * (args.textureHeight ?? list[index].description?.texture_height) > 16 * 1024 * 1024) throw Error("面贴图总像素超过 1600 万限制");
  for (const relative of bound) {
    const value = await readTexture(modLibrary, path.join(path.dirname(real), relative), worldRoot, studioRoot);
    const image = pngInfo(Buffer.from(value.dataUrl.slice(22), "base64"));
    if (image.width !== (args.textureWidth ?? list[index].description?.texture_width) || image.height !== (args.textureHeight ?? list[index].description?.texture_height)) throw Error("面贴图尺寸必须与模型 UV 分辨率一致");
  }
  const options = { formattingOptions: formatting(text) };
  let next = jsonc.applyEdits(text, jsonc.modify(text, ["minecraft:geometry", index, "bones"], publishBones(args.bones), options));
  if (Number.isInteger(args.textureWidth)) next = jsonc.applyEdits(next, jsonc.modify(next, ["minecraft:geometry", index, "description", "texture_width"], args.textureWidth, options));
  if (Number.isInteger(args.textureHeight)) next = jsonc.applyEdits(next, jsonc.modify(next, ["minecraft:geometry", index, "description", "texture_height"], args.textureHeight, options));
  if (args.display !== undefined) {
    const display = normalizeDisplay(args.display);
    const parsed = jsonc.parse(next.replace(/^﻿/, ""));
    const stored = parsed?.dgn_display && typeof parsed.dgn_display === "object" && !Array.isArray(parsed.dgn_display) ? { ...parsed.dgn_display } : {};
    if (Object.keys(display).length) stored[identifier] = display;
    else delete stored[identifier];
    next = jsonc.applyEdits(next, jsonc.modify(next, ["dgn_display"], Object.keys(stored).length ? stored : undefined, options));
  }
  await fs.copyFile(real, real + ".bak");
  await fs.writeFile(real, next);
  return { path: real };
}

async function renameAnimation(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation.json")) throw Error("只能重命名动画文件");
  const id = typeof args.id === "string" ? args.id : "";
  const raw = typeof args.name === "string" ? args.name.trim().replace(/^animation\./, "") : "";
  if (!id || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(raw) || raw.length > 64) throw Error("动画名称无效");
  const nextId = "animation." + raw;
  if (nextId === id) return { path: real, id };
  const text = await fs.readFile(real, "utf8");
  const data = jsonc.parse(text.replace(/^﻿/, ""));
  const map = data?.animations && typeof data.animations === "object" ? data.animations : {};
  if (!map[id]) throw Error("文件里没有这个动画");
  if (map[nextId]) throw Error("同名动画已经存在");
  const options = { formattingOptions: formatting(text) };
  let next = jsonc.applyEdits(text, jsonc.modify(text, ["animations", nextId], map[id], options));
  next = jsonc.applyEdits(next, jsonc.modify(next, ["animations", id], undefined, options));
  const quotedFrom = JSON.stringify(id);
  const quotedTo = JSON.stringify(nextId);
  if (next.includes(quotedFrom)) next = next.split(quotedFrom).join(quotedTo);
  await fs.copyFile(real, real + ".bak");
  await fs.writeFile(real, next);
  const references = await rewriteAnimationReferences(await owningRoot(real, modLibrary, worldRoot, studioRoot), id, nextId);
  return { path: real, id: nextId, references };
}

async function owningRoot(real, modLibrary, worldRoot, studioRoot) {
  const target = path.resolve(real).toLowerCase();
  const candidates = [];
  if (studioRoot) candidates.push(studioRoot);
  if (worldRoot) candidates.push(worldRoot);
  const catalog = await modLibrary.list();
  for (const mod of catalog.mods || []) if (mod.available !== false && mod.path) candidates.push(mod.path);
  let best = "";
  for (const root of candidates) {
    let base;
    try { base = path.resolve(await fs.realpath(root)); } catch { continue; }
    const lower = base.toLowerCase();
    if ((target === lower || target.startsWith(lower + path.sep)) && lower.length > best.length) best = base;
  }
  return best || path.dirname(real);
}

// shortcut: 只改同一棵目录里的实体和动画控制器，超过 200 个或 1MB 就停，引用在别的包里时再扩。
async function rewriteAnimationReferences(root, fromId, toId) {
  const base = path.resolve(root);
  const baseLower = base.toLowerCase();
  const needle = JSON.stringify(fromId);
  const replacement = JSON.stringify(toId);
  const changed = [];
  let seen = 0;
  async function walk(dir, depth) {
    if (depth > 8 || seen > 200) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || seen > 200) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".entity.json") && !lower.endsWith(".animation_controllers.json")) continue;
      seen += 1;
      let stat;
      try { stat = await fs.lstat(full); } catch { continue; }
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      let real;
      try { real = await fs.realpath(full); } catch { continue; }
      const realLower = path.resolve(real).toLowerCase();
      if (realLower !== baseLower && !realLower.startsWith(baseLower + path.sep)) continue;
      const body = await fs.readFile(real, "utf8");
      if (!body.includes(needle)) continue;
      await fs.copyFile(real, real + ".bak");
      await fs.writeFile(real, body.split(needle).join(replacement));
      changed.push(real);
    }
  }
  await walk(base, 0);
  return changed.length;
}

const skipDirs = new Set(["node_modules", ".git", "dist", "release"]);

async function listModels(modLibrary, studioRoot) {
  const catalog = await modLibrary.list();
  const models = [];
  const deadline = Date.now() + 2500;
  async function walk(dir, sourceName, depth) {
    if (models.length >= 400 || depth > 6 || Date.now() > deadline) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || models.length >= 400) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(full, sourceName, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".geo.json")) continue;
      try {
        const stat = await fs.stat(full);
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        const text = await fs.readFile(full, "utf8");
        const errors = [];
        const data = jsonc.parse(text.replace(/^﻿/, ""), errors, { allowTrailingComma: true });
        const list = Array.isArray(data?.["minecraft:geometry"]) ? data["minecraft:geometry"] : [];
        for (const geometry of list) {
          const bones = Array.isArray(geometry?.bones) ? geometry.bones : [];
          models.push({
            path: full,
            identifier: geometry?.description?.identifier || entry.name,
            sourceName,
            draft: sourceName === "草稿",
            bones: bones.length,
            cubes: bones.reduce((sum, bone) => sum + (Array.isArray(bone?.cubes) ? bone.cubes.length : 0), 0),
          });
        }
      } catch { /* 坏文件留在列表外，打开时再报错。 */ }
    }
  }
  if (studioRoot) await walk(studioRoot, "草稿", 0);
  for (const mod of catalog.mods || []) {
    if (mod.available === false || !mod.path) continue;
    await walk(mod.path, mod.name || path.basename(mod.path), 0);
  }
  return { models };
}

async function createModel(args, studioRoot) {
  if (typeof studioRoot !== "string" || !studioRoot.trim()) throw Error("不能新建模型");
  const identifier = typeof args.identifier === "string" && args.identifier.trim() ? args.identifier.trim() : "geometry.model";
  if (!/^geometry\.[A-Za-z0-9_-]{1,64}$/.test(identifier)) throw Error("标识符需要以 geometry. 开头");
  const root = path.resolve(studioRoot);
  await fs.mkdir(root, { recursive: true });
  const base = identifier.slice("geometry.".length);
  let folder = path.join(root, base);
  for (let index = 2; ; index += 1) {
    try {
      await fs.lstat(folder);
      folder = path.join(root, base + index);
    } catch { break; }
  }
  await fs.mkdir(path.join(folder, "textures"), { recursive: true });
  const file = path.join(folder, base + ".geo.json");
  const body = {
    format_version: "1.12.0",
    "minecraft:geometry": [{
      description: { identifier, texture_width: 64, texture_height: 64 },
      bones: [{ name: "body", pivot: [0, 12, 0], cubes: [{ origin: [-4, 0, -2], size: [8, 12, 4], uv: [0, 0] }] }],
    }],
  };
  await fs.writeFile(file, JSON.stringify(body, null, 2));
  return { path: file, identifier };
}

async function deleteModel(modLibrary, file, studioRoot) {
  const real = await ownedFile(modLibrary, file, null, studioRoot);
  if (!real.toLowerCase().endsWith(".geo.json")) throw Error("只能删除几何文件");
  await fs.rm(real, { force: true });
  await fs.rm(real + ".bak", { force: true });
  if (studioRoot) {
    const root = path.resolve(studioRoot).toLowerCase();
    const dir = path.dirname(real);
    if (dir.toLowerCase().startsWith(root + path.sep)) {
      const left = await fs.readdir(dir);
      if (!left.some(name => name.toLowerCase().endsWith(".geo.json"))) await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return { path: real };
}

async function listTextures(modLibrary, file, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, file, worldRoot, studioRoot);
  const roots = [];
  if (studioRoot) roots.push(studioRoot);
  if (worldRoot) roots.push(worldRoot);
  const catalog = await modLibrary.list();
  for (const mod of catalog.mods || []) if (mod.available !== false && mod.path) roots.push(mod.path);
  const resolvedRoots = [];
  for (const root of roots) {
    try { resolvedRoots.push(path.resolve(await fs.realpath(root)).toLowerCase()); } catch { /* 目录不在就跳过。 */ }
  }
  const inside = dir => {
    const target = path.resolve(dir).toLowerCase();
    return resolvedRoots.some(root => target === root || target.startsWith(root + path.sep));
  };
  const seen = new Set();
  const textures = [];
  async function collect(dir, depth, nested) {
    if (textures.length >= 40 || depth > 4 || !inside(dir)) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || textures.length >= 40) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (nested && !skipDirs.has(entry.name)) await collect(full, depth + 1, true);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) continue;
      const key = full.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const relative = path.relative(path.dirname(real), full).replace(/\\/g, "/");
        textures.push({ path: await ownedFile(modLibrary, full, worldRoot, studioRoot), name: entry.name, ...(relative && !relative.startsWith("../") && !path.isAbsolute(relative) ? { relative } : {}) });
      } catch { /* 目录外的贴图不列出。 */ }
    }
  }
  let cursor = path.dirname(real);
  await collect(path.join(cursor, "textures"), 0, true);
  for (let step = 0; step < 6 && textures.length < 40; step += 1) {
    if (!inside(cursor)) break;
    await collect(cursor, 0, false);
    await collect(path.join(cursor, "textures"), 0, true);
    // 几何常在行为包，贴图在同一项目的资源包里。
    for (const packRoot of ["resource_packs", "behavior_packs", "resources"]) {
      let entries = [];
      try { entries = await fs.readdir(path.join(cursor, packRoot), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || skipDirs.has(entry.name)) continue;
        await collect(path.join(cursor, packRoot, entry.name, "textures"), 0, true);
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // shortcut: 超过 40 张就停，贴图目录很大时再按实体引用的路径过滤。
  return { textures };
}

async function readTexture(modLibrary, file, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, file, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".png")) throw Error("只能读取 PNG 贴图");
  const identity = await inspectSelection(real, "file");
  if ((await fs.stat(real)).size > 4 * 1024 * 1024) throw Error("贴图超过 4MB");
  const data = await fs.readFile(real);
  await verifySelection(identity);
  return { path: real, ...readLayerPng(data), revision: digest(data) };
}

async function saveTexture(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".png")) throw Error("只能保存 PNG 贴图");
  if (!/^[a-f0-9]{64}$/.test(args.revision || "")) throw Error("请重新读取贴图后保存");
  const data = writeLayerPng(args.dataUrl, args.layers);
  const key = real.toLowerCase();
  const operation = (textureWrites.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const identity = await inspectSelection(real, "file"), parent = await inspectSelection(path.dirname(real), "directory");
    if ((await fs.stat(real)).size > 4 * 1024 * 1024) throw Error("贴图超过 4MB");
    const before = await fs.readFile(real);
    if (digest(before) !== args.revision) throw Error("贴图已被外部修改，请放弃当前草稿并重新读取；未覆盖文件");
    const previous = readLayerPng(before);
    if (previous.layers && !args.layers) throw Error("原文件含图层，不能用缺少图层的旧请求覆盖");
    const temporary = real + "." + randomUUID() + ".tmp", backup = real + ".bak";
    try {
      await fs.writeFile(temporary, data, { flag: "wx" });
      await verifySelection(identity); await verifySelection(parent);
      try { await inspectSelection(backup, "file"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.writeFile(backup, before);
      await verifySelection(identity); await verifySelection(parent);
      await renameWithRetry(temporary, real);
      return { path: real, revision: digest(data) };
    } finally { await fs.rm(temporary, { force: true }); }
  });
  textureWrites.set(key, operation);
  try { return await operation; } finally { if (textureWrites.get(key) === operation) textureWrites.delete(key); }
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function blankPng(width, height, rectangles) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  if (!rectangles) for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 4;
      raw[index] = 255;
      raw[index + 1] = 255;
      raw[index + 2] = 255;
      raw[index + 3] = 255;
    }
  }
  if (rectangles) for (const { x, y, w, h, color } of rectangles) {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const offset = py * stride + 1 + px * 4;
      const edge = px === x || py === y || px === x + w - 1 || py === y + h - 1;
      raw[offset] = edge ? Math.round(color[0] * 0.65) : color[0];
      raw[offset + 1] = edge ? Math.round(color[1] * 0.65) : color[1];
      raw[offset + 2] = edge ? Math.round(color[2] * 0.65) : color[2]; raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createTexture(modLibrary, args, worldRoot, studioRoot) {
  const model = await ownedFile(modLibrary, args.modelPath, worldRoot, studioRoot);
  const name = String(args.name || "texture").trim().replace(/\.png$/i, "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw Error("贴图名只能用字母、数字、下划线和短横线");
  const width = Number(args.width);
  const height = Number(args.height);
  validateSize(width, height);
  const rectangles = args.templateBones === undefined ? null : templateRects(args.templateBones, width, height);
  const png = blankPng(width, height, rectangles);
  if (png.length > 4 * 1024 * 1024) throw Error("模板 PNG 超过 4MB");
  const dir = path.join(path.dirname(model), "textures");
  await fs.mkdir(dir, { recursive: true });
  const directory = await inspectSelection(dir, "directory");
  const file = path.join(dir, name + ".png");
  await verifySelection(directory);
  try {
    await fs.writeFile(file, png, { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw Error("同名贴图已经存在");
    throw error;
  }
  return { path: file, name: name + ".png" };
}

async function listAnimations(modLibrary, modelPath, worldRoot, studioRoot) {
  const model = await ownedFile(modLibrary, modelPath, worldRoot, studioRoot);
  const dir = path.dirname(model);
  const animations = [];
  let entries = [];
  try { entries = await fs.readdir(dir); } catch { return { animations }; }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".animation.json")) continue;
    const file = path.join(dir, name);
    try {
      const text = await fs.readFile(file, "utf8");
      const data = jsonc.parse(text.replace(/^\uFEFF/, ""));
      const map = data?.animations && typeof data.animations === "object" ? data.animations : {};
      for (const id of Object.keys(map)) animations.push({ path: file, id, length: Number(map[id]?.animation_length) || 1, loop: map[id]?.loop !== false });
    } catch { /* 坏文件留在列表外。 */ }
  }
  return { animations };
}

async function readAnimation(modLibrary, file, id, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, file, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation.json")) throw Error("只能读取动画文件");
  const text = await fs.readFile(real, "utf8");
  const data = jsonc.parse(text.replace(/^\uFEFF/, ""));
  const map = data?.animations && typeof data.animations === "object" ? data.animations : {};
  const key = id && map[id] ? id : Object.keys(map)[0];
  if (!key) throw Error("文件里没有动画");
  return { path: real, id: key, animation: map[key] };
}

async function saveAnimation(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation.json")) throw Error("只能保存动画文件");
  const id = typeof args.id === "string" ? args.id : "";
  if (!id || !args.animation || typeof args.animation !== "object") throw Error("动画数据无效");
  const text = await fs.readFile(real, "utf8");
  const options = { formattingOptions: formatting(text) };
  const next = jsonc.applyEdits(text, jsonc.modify(text, ["animations", id], args.animation, options));
  await fs.copyFile(real, real + ".bak");
  await fs.writeFile(real, next);
  return { path: real };
}

async function createAnimation(modLibrary, args, worldRoot, studioRoot) {
  const model = await ownedFile(modLibrary, args.modelPath, worldRoot, studioRoot);
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "idle";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw Error("动画名称无效");
  const id = "animation." + name;
  const file = path.join(path.dirname(model), name + ".animation.json");
  try {
    await fs.lstat(file);
    throw Error("同名动画已经存在");
  } catch (error) {
    if (error.message === "同名动画已经存在") throw error;
  }
  const body = { format_version: "1.8.0", animations: { [id]: { loop: true, animation_length: 1, bones: {} } } };
  await fs.writeFile(file, JSON.stringify(body, null, 2));
  return { path: file, id };
}

async function deleteAnimation(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation.json")) throw Error("只能删除动画文件");
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw Error("动画数据无效");
  const text = await fs.readFile(real, "utf8");
  const data = jsonc.parse(text.replace(/^﻿/, ""));
  const map = data?.animations && typeof data.animations === "object" ? data.animations : {};
  if (!map[id]) throw Error("文件里没有这个动画");
  if (Object.keys(map).length === 1) {
    await fs.rm(real, { force: true });
    await fs.rm(real + ".bak", { force: true });
    return { path: real };
  }
  const options = { formattingOptions: formatting(text) };
  const next = jsonc.applyEdits(text, jsonc.modify(text, ["animations", id], undefined, options));
  await fs.copyFile(real, real + ".bak");
  await fs.writeFile(real, next);
  return { path: real };
}

async function duplicateAnimation(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation.json")) throw Error("只能复制动画文件");
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw Error("动画数据无效");
  const text = await fs.readFile(real, "utf8");
  const data = jsonc.parse(text.replace(/^﻿/, ""));
  const map = data?.animations && typeof data.animations === "object" ? data.animations : {};
  if (!map[id]) throw Error("文件里没有这个动画");
  const base = id.startsWith("animation.") ? id.slice("animation.".length) : id;
  let nextId = "";
  for (let index = 2; index < 100; index += 1) {
    const candidate = "animation." + base + index;
    if (!map[candidate]) { nextId = candidate; break; }
  }
  if (!nextId) throw Error("同名动画已经存在");
  const options = { formattingOptions: formatting(text) };
  const next = jsonc.applyEdits(text, jsonc.modify(text, ["animations", nextId], JSON.parse(JSON.stringify(map[id])), options));
  await fs.copyFile(real, real + ".bak");
  await fs.writeFile(real, next);
  return { path: real, id: nextId };
}

async function listControllers(modLibrary, modelPath, worldRoot, studioRoot) {
  const model = await ownedFile(modLibrary, modelPath, worldRoot, studioRoot);
  const controllers = [];
  let entries = [];
  try { entries = await fs.readdir(path.dirname(model)); } catch { return { controllers }; }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".animation_controllers.json")) continue;
    const file = path.join(path.dirname(model), name);
    try {
      const read = await readController(modLibrary, file, worldRoot, studioRoot);
      const map = read.document.animation_controllers;
      for (const id of Object.keys(map)) controllers.push({ path: file, id });
    } catch { /* 坏文件留在列表外。 */ }
  }
  return { controllers };
}

async function readController(modLibrary, file, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, file, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation_controllers.json")) throw Error("只能读取动画控制器");
  const selection = await inspectSelection(real, "file");
  if ((await fs.stat(real)).size > 1024 * 1024) throw Error("控制器文件超过 1MB");
  const bytes = await fs.readFile(real);
  await verifySelection(selection);
  if (bytes.length > 1024 * 1024) throw Error("控制器文件超过 1MB");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const errors = [];
  const data = jsonc.parse(text.replace(/^﻿/, ""), errors, { allowTrailingComma: true });
  if (errors.length) throw Error("控制器 JSON 无法解析");
  validateControllers(data?.animation_controllers);
  return { path: real, document: data, revision: digest(bytes) };
}

async function saveController(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  if (!real.toLowerCase().endsWith(".animation_controllers.json")) throw Error("只能保存动画控制器");
  const map = validateControllers(args.document?.animation_controllers);
  const key = real.toLowerCase();
  if (controllerWrites.has(key)) throw Error("控制器正在保存，请稍后重试");
  controllerWrites.add(key);
  const temporary = real + "." + randomUUID() + ".tmp";
  try {
    const loaded = await readController(modLibrary, real, worldRoot, studioRoot);
    if (!args.revision || args.revision !== loaded.revision) throw Error("控制器已变化，请重新读取后再编辑");
    const bytes = await fs.readFile(real);
    if (digest(bytes) !== loaded.revision) throw Error("控制器已变化，请重新读取后再编辑");
    const text = bytes.toString("utf8");
    const next = jsonc.applyEdits(text, jsonc.modify(text, ["animation_controllers"], map, { formattingOptions: formatting(text) }));
    if (Buffer.byteLength(next, "utf8") > 1024 * 1024) throw Error("控制器文件超过 1MB");
    const directory = await inspectSelection(path.dirname(real), "directory");
    await fs.writeFile(temporary, next, { encoding: "utf8", flag: "wx" });
    const backup = real + ".bak";
    try { await ownedFile(modLibrary, backup, worldRoot, studioRoot); }
    catch (reason) { if (reason.code !== "ENOENT") throw reason; }
    await verifySelection(directory);
    await fs.copyFile(real, backup);
    await ownedFile(modLibrary, real, worldRoot, studioRoot);
    if (digest(await fs.readFile(real)) !== loaded.revision) throw Error("控制器已变化，请重新读取后再编辑");
    await renameWithRetry(temporary, real);
    return { path: real, revision: digest(Buffer.from(next, "utf8")) };
  } finally {
    controllerWrites.delete(key);
    await fs.rm(temporary, { force: true });
  }
}

async function createControllerFile(modLibrary, args, worldRoot, studioRoot) {
  const model = await ownedFile(modLibrary, args.modelPath, worldRoot, studioRoot);
  const id = controllerId(args.name || "mob");
  const file = path.join(path.dirname(model), "model.animation_controllers.json");
  let existing = null;
  try { existing = await readController(modLibrary, file, worldRoot, studioRoot); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const next = createController(existing?.document || null, id);
  if (existing) {
    const saved = await saveController(modLibrary, { path: file, document: next, revision: existing.revision }, worldRoot, studioRoot);
    return { ...saved, id, document: next };
  }
  const directory = await inspectSelection(path.dirname(model), "directory");
  await verifySelection(directory);
  const bytes = Buffer.from(JSON.stringify(next, null, 2), "utf8");
  await fs.writeFile(file, bytes, { flag: "wx" });
  return { path: file, id, document: next, revision: digest(bytes) };
}

module.exports = { ownedFile, saveManifest, readGeometry, saveGeometry, listModels, createModel, deleteModel, listTextures, readTexture, saveTexture, createTexture, listAnimations, readAnimation, saveAnimation, createAnimation, deleteAnimation, renameAnimation, duplicateAnimation, listControllers, readController, saveController, createControllerFile };
