const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const jsonc = require("jsonc-parser");
const { ownedFile, readGeometry } = require("./content-files.cjs");
const { exportProject, importProject } = require("./bbmodel-codec.cjs");
const { pngInfo, decodePng, encodeRgbaPng } = require("../skins/npc-skins.cjs");
const { repackTexture } = require("../../../shared/model-uv.cjs");
const { assignedTextures, faceNames } = require("../../../shared/model-materials.cjs");
const { validateControllers } = require("../../../shared/animation-controller.cjs");
const { readLayerPng, digest } = require("./texture-layers.cjs");
const { inspectSelection, verifySelection } = require("../../file-selection.cjs");
const MAX_PROJECT = 16 * 1024 * 1024;

async function plainFile(file, limit = MAX_PROJECT) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw Error("工程路径无效");
  const selection = await inspectSelection(file, "file");
  const stat = await fs.stat(file);
  if (stat.size > limit) throw Error("工程必须是大小受限、未重定向的普通文件");
  const bytes = await fs.readFile(file);
  await verifySelection(selection);
  if (bytes.length > limit) throw Error("工程超过大小限制");
  return bytes;
}
function parse(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const errors = [];
  const data = jsonc.parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== "object" || Array.isArray(data)) throw Error("工程 JSON 无法解析");
  return data;
}
function pngData(source, width, height) {
  if (!source) return null;
  if (typeof source !== "string" || source.length > 6 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) throw Error("工程贴图必须是内嵌 PNG");
  const bytes = Buffer.from(source.slice("data:image/png;base64,".length), "base64");
  if (bytes.length > 4 * 1024 * 1024) throw Error("工程贴图超过 4MB");
  const info = pngInfo(bytes);
  if (info.width > 2048 || info.height > 2048) throw Error("工程贴图尺寸超过 2048");
  if (info.width !== width || info.height !== height) throw Error("当前工程要求 PNG 像素尺寸与 UV 分辨率一致");
  return bytes;
}

async function importModelProject(selectedFile, studioRoot) {
  if (path.extname(selectedFile).toLowerCase() !== ".bbmodel") throw Error("请选择 .bbmodel 工程");
  const original = await plainFile(selectedFile);
  const project = importProject(parse(original));
  if ((project.textures?.length || 1) * project.textureWidth * project.textureHeight > 16 * 1024 * 1024) throw Error("工程贴图总像素超过 1600 万限制");
  const texture = pngData(project.texture, project.textureWidth, project.textureHeight);
  const materialTextures = project.textures?.map(item => ({ ...item, bytes: pngData(item.source, project.textureWidth, project.textureHeight) }));
  const root = path.resolve(studioRoot);
  await fs.mkdir(root, { recursive: true });
  if (path.resolve(await fs.realpath(root)).toLowerCase() !== root.toLowerCase()) throw Error("草稿目录被重定向");
  const folder = await fs.mkdtemp(path.join(root, "bbmodel-"));
  try {
    const file = path.join(folder, "model.geo.json");
    await fs.writeFile(path.join(folder, "source.bbmodel"), original, { flag: "wx" });
    if (materialTextures?.length) {
      await fs.mkdir(path.join(folder, "textures"));
      for (const item of materialTextures) await fs.writeFile(path.join(folder, item.key), item.bytes, { flag: "wx" });
    } else if (texture) {
      await fs.mkdir(path.join(folder, "textures"));
      await fs.writeFile(path.join(folder, "textures", "texture.png"), texture, { flag: "wx" });
    }
    if (Object.keys(project.animations).length) await fs.writeFile(path.join(folder, "model.animation.json"), JSON.stringify({ format_version: "1.8.0", animations: project.animations }, null, 2), { encoding: "utf8", flag: "wx" });
    if (Object.keys(project.controllers || {}).length) await fs.writeFile(path.join(folder, "model.animation_controllers.json"), JSON.stringify({ format_version: "1.10.0", animation_controllers: project.controllers }, null, 2), { encoding: "utf8", flag: "wx" });
    const geometryFile = { format_version: "1.12.0", "minecraft:geometry": [{ description: { identifier: project.identifier, texture_width: project.textureWidth, texture_height: project.textureHeight }, bones: project.bones }] };
    if (Object.keys(project.display || {}).length) geometryFile.dgn_display = { [project.identifier]: project.display };
    // 最后写入几何文件，模型库不会看见只完成一半的工程。
    await fs.writeFile(file, JSON.stringify(geometryFile, null, 2), { encoding: "utf8", flag: "wx" });
    return { path: file, identifier: project.identifier, animations: Object.keys(project.animations).length };
  } catch (error) {
    // 此目录由本次 mkdtemp 创建，内容均为固定文件名，失败时只移除这份新草稿。
    if (path.dirname(folder) === root && await fs.realpath(folder) === folder) await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}

async function prepareModelProject(modLibrary, args, worldRoot, studioRoot) {
  const real = await ownedFile(modLibrary, args.path, worldRoot, studioRoot);
  const disk = await readGeometry(modLibrary, real, worldRoot, studioRoot);
  if (!disk.geometries.some(item => item.identifier === args.identifier)) throw Error("模型来源已变化，请重新打开");
  const animations = {};
  const entries = await fs.readdir(path.dirname(real), { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".animation.json"));
  if (files.length > 100) throw Error("模型旁的动画文件过多");
  let total = 0;
  for (const entry of files) {
    const file = await ownedFile(modLibrary, path.join(path.dirname(real), entry.name), worldRoot, studioRoot);
    const bytes = await plainFile(file, 2 * 1024 * 1024);
    total += bytes.length;
    if (total > MAX_PROJECT) throw Error("动画数据超过 16MB");
    for (const [id, animation] of Object.entries(parse(bytes).animations || {})) {
      if (Object.hasOwn(animations, id)) throw Error("模型旁存在重复动画标识符");
      Object.defineProperty(animations, id, { value: animation, enumerable: true });
    }
  }
  const controllers = {};
  const controllerFiles = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".animation_controllers.json"));
  if (controllerFiles.length > 8) throw Error("模型旁的控制器文件过多");
  for (const entry of controllerFiles) {
    const file = await ownedFile(modLibrary, path.join(path.dirname(real), entry.name), worldRoot, studioRoot);
    const map = parse(await plainFile(file, 1024 * 1024)).animation_controllers;
    if (!map) continue;
    validateControllers(map);
    for (const [id, controller] of Object.entries(map)) {
      if (Object.hasOwn(controllers, id)) throw Error("模型旁存在重复控制器标识符");
      controllers[id] = controller;
    }
  }
  const sourcePng = pngData(args.texture || "", args.textureWidth, args.textureHeight);
  let { bones, textureWidth, textureHeight, texture = "" } = args;
  const bindings = assignedTextures(bones), palette = [];
  const overrides = args.textureOverrides ?? {};
  const revisions = args.textureRevisions ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || Object.keys(overrides).some(key => !bindings.includes(key))) throw Error("面贴图快照无效");
  if (!revisions || typeof revisions !== "object" || Array.isArray(revisions) || Object.keys(revisions).some(key => !bindings.includes(key)) || Object.values(revisions).some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw Error("面贴图版本快照无效");
  const atlasSources = {};
  const needsDefault = bones.some(bone => (bone.cubes || []).some(cube => Array.isArray(cube.uv) || faceNames.some(name => cube.uv?.[name] && !cube.uv[name].dgn_texture)));
  if (bindings.length) {
    const count = bindings.length + (needsDefault ? 1 : 0);
    if (count > 8) throw Error("面贴图连同默认贴图最多 8 张");
    if (count * textureWidth * textureHeight > 16 * 1024 * 1024) throw Error("面贴图总像素超过 1600 万限制");
    if (needsDefault) { if (!texture) throw Error("未分配的模型面需要默认贴图"); palette.push({ key: "", source: texture }); }
    for (const key of bindings) {
      const file = await ownedFile(modLibrary, path.join(path.dirname(real), key), worldRoot, studioRoot);
      const bytes = await plainFile(file, 4 * 1024 * 1024);
      if (Object.hasOwn(revisions, key) && digest(bytes) !== revisions[key]) throw Error("面贴图已被外部修改，请重新打开重排预览");
      const source = Object.hasOwn(overrides, key) ? overrides[key] : readLayerPng(bytes).dataUrl;
      const checked = pngData(source, textureWidth, textureHeight);
      if (!checked) throw Error("面贴图快照缺少 PNG");
      palette.push({ key, source });
      if (args.repack !== undefined) {
        const image = decodePng(checked);
        atlasSources[key] = { width: image.width, height: image.height, data: image.pixels };
      }
    }
  }
  if (args.repack !== undefined) {
    if (!args.repack || typeof args.repack !== "object" || Array.isArray(args.repack) || Object.keys(args.repack).some(key => !["width", "height", "padding"].includes(key))) throw Error("UV 重排参数无效");
    const decoded = sourcePng ? decodePng(sourcePng) : null;
    const image = decoded ? { width: decoded.width, height: decoded.height, data: decoded.pixels } : Object.values(atlasSources)[0];
    if (!image) throw Error("带贴图重排需要当前贴图或已分配面贴图");
    if (sourcePng && needsDefault) atlasSources[""] = image;
    const packed = repackTexture(bones, image, args.repack.width, args.repack.height, args.repack.padding, bindings.length ? atlasSources : null);
    const png = encodeRgbaPng(packed.width, packed.height, Buffer.from(packed.data));
    if (png.length > 4 * 1024 * 1024) throw Error("重排后的 PNG 超过 4MB");
    bones = packed.bones; textureWidth = packed.width; textureHeight = packed.height;
    texture = "data:image/png;base64," + png.toString("base64");
  }
  const project = exportProject({ identifier: args.identifier, bones, textureWidth, textureHeight, texture, ...(bindings.length && args.repack === undefined ? { textures: palette } : {}), animations, display: args.display || {}, controllers });
  const bytes = Buffer.from(JSON.stringify(project, null, 2), "utf8");
  if (bytes.length > MAX_PROJECT) throw Error("工程超过 16MB");
  return bytes;
}

async function writeModelProject(selectedFile, bytes) {
  if (typeof selectedFile !== "string" || !path.isAbsolute(selectedFile) || path.extname(selectedFile).toLowerCase() !== ".bbmodel") throw Error("导出路径必须是 .bbmodel 文件");
  const target = path.resolve(selectedFile), parent = path.dirname(target);
  if (path.resolve(await fs.realpath(parent)).toLowerCase() !== parent.toLowerCase()) throw Error("导出目录被重定向");
  let existing = null;
  try { existing = await plainFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    if (existing) {
      const current = await plainFile(target);
      if (!current.equals(existing)) throw Error("导出文件已被其他程序修改");
      await fs.writeFile(target + "." + randomUUID() + ".bak", existing, { flag: "wx" });
      await fs.rename(temporary, target);
    } else { await fs.copyFile(temporary, target, require("node:fs").constants.COPYFILE_EXCL); }
  } finally { await fs.rm(temporary, { force: true }); }
  return { path: target };
}

module.exports = { importModelProject, prepareModelProject, writeModelProject };
