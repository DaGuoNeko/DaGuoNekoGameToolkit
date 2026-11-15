"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const yauzl = require("yauzl");
const targets = require("./skin-targets.json");
const templateZip = require("./npc-skin-template.cjs");

const MAX_SKINS = 1000;
const MAX_TEXT = 120;
const MAX_IMAGE = 20 * 1024 * 1024;
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

// shortcut: checks PNG chunks and CRC, not a full pixel decode; upgrade if a structurally valid but corrupt image reaches the game.
function pngInfo(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature))
    throw Error("无效的 PNG 文件");
  let offset = 8;
  let width = 0;
  let height = 0;
  let ihdr = false;
  let iend = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length || offset + 12 + length > buffer.length) throw Error("无效的 PNG 文件");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const actual = buffer.readUInt32BE(offset + 8 + length);
    if (actual !== crc32(Buffer.concat([buffer.subarray(offset + 4, offset + 8), data])))
      throw Error("无效的 PNG 文件");
    if (type === "IHDR") {
      if (ihdr || data.length < 8) throw Error("无效的 PNG IHDR 数据块");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      ihdr = true;
    }
    offset += 12 + length;
    if (type === "IEND") {
      iend = true;
      break;
    }
  }
  if (!ihdr || !iend || width <= 0 || height <= 0)
    throw Error("无效的 PNG 文件");
  return { width, height };
}
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(signature))
    throw Error("无效的 PNG 文件");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) throw Error("无效的 PNG 文件");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const actual = buffer.readUInt32BE(offset + 8 + length);
    if (actual !== crc32(Buffer.concat([buffer.subarray(offset + 4, offset + 8), data])))
      throw Error("无效的 PNG 文件");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) throw Error("这个 PNG 的位深或隔行方式暂不能转换");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw Error("这个 PNG 的颜色类型暂不能转换");
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const raw = Buffer.alloc(height * stride);
  let input = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input++];
    const row = inflated.subarray(input, input + stride);
    input += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? recon[i - channels] : 0;
      const up = prev[i];
      const upperLeft = i >= channels ? prev[i - channels] : 0;
      let value = row[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - upperLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else if (filter !== 0) throw Error("无效的 PNG 文件");
      recon[i] = value & 255;
    }
    recon.copy(raw, y * stride);
    prev = recon;
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, pixel = 0; i < raw.length; i += channels, pixel += 4) {
    if (colorType === 2) {
      pixels[pixel] = raw[i]; pixels[pixel + 1] = raw[i + 1]; pixels[pixel + 2] = raw[i + 2]; pixels[pixel + 3] = 255;
    } else if (colorType === 6) {
      pixels.set(raw.subarray(i, i + 4), pixel);
    } else if (colorType === 0) {
      pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = raw[i]; pixels[pixel + 3] = 255;
    } else if (colorType === 4) {
      pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = raw[i]; pixels[pixel + 3] = raw[i + 1];
    } else {
      const index = raw[i];
      const color = index * 3;
      pixels[pixel] = palette?.[color] ?? 0;
      pixels[pixel + 1] = palette?.[color + 1] ?? 0;
      pixels[pixel + 2] = palette?.[color + 2] ?? 0;
      pixels[pixel + 3] = transparency?.[index] ?? 255;
    }
  }
  return { width, height, pixels };
}
function encodeRgbaPng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const legacyLimbCopies = [
  [4, 16, 4, 4, 20, 48],
  [8, 16, 4, 4, 24, 48],
  [8, 20, 4, 12, 16, 52],
  [4, 20, 4, 12, 20, 52],
  [0, 20, 4, 12, 24, 52],
  [12, 20, 4, 12, 28, 52],
  [44, 16, 4, 4, 36, 48],
  [48, 16, 4, 4, 40, 48],
  [48, 20, 4, 12, 32, 52],
  [44, 20, 4, 12, 36, 52],
  [40, 20, 4, 12, 40, 52],
  [52, 20, 4, 12, 44, 52],
];
function blitFlipX(src, srcWidth, dest, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const from = ((sy + y) * srcWidth + sx + x) * 4;
      const to = ((dy + y) * srcWidth + dx + (w - 1 - x)) * 4;
      dest[to] = src[from];
      dest[to + 1] = src[from + 1];
      dest[to + 2] = src[from + 2];
      dest[to + 3] = src[from + 3];
    }
  }
}
function modernizeSkinPng(buffer) {
  const { width, height, pixels } = decodePng(buffer);
  const legacy = width === height * 2 && height >= 32 && (height & (height - 1)) === 0 && width <= 4096;
  if (!legacy) throw Error("只有 64×32 及其倍率的旧版皮肤可以转换成新版");
  const scale = width / 64;
  const out = Buffer.alloc(width * width * 4);
  pixels.copy(out, 0, 0, pixels.length);
  for (const [sx, sy, w, h, dx, dy] of legacyLimbCopies) {
    blitFlipX(pixels, width, out, sx * scale, sy * scale, w * scale, h * scale, dx * scale, dy * scale);
  }
  return encodeRgbaPng(width, width, out);
}
function exportFileName(name, id, used) {
  const cleaned = String(name || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/g, "").slice(0, 80);
  let base = cleaned || id;
  let file = base + ".png";
  let suffix = 2;
  while (used.has(file.toLowerCase())) {
    file = base + "-" + suffix + ".png";
    suffix += 1;
  }
  used.add(file.toLowerCase());
  return file;
}

function token(length, letterFirst) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const source = letterFirst && i === 0 ? LETTERS : CHARS;
    out += source[crypto.randomInt(source.length)];
  }
  return out;
}

function packageName() {
  return "s_" + token(8, false);
}

function configName() {
  return token(5, true) + ".json";
}

function skinId(used) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = "skin_" + crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase();
    if (!used.has(id.toLowerCase())) {
      used.add(id.toLowerCase());
      return id;
    }
  }
  throw Error("无法生成唯一的皮肤 ID，请重试");
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}
function paintRect(raw, width, x, y, w, h, color) {
  const stride = 1 + width * 4;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const index = yy * stride + 1 + xx * 4;
      raw[index] = color[0];
      raw[index + 1] = color[1];
      raw[index + 2] = color[2];
      raw[index + 3] = 255;
    }
  }
}
function blankSkinPng() {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(height * (1 + width * 4));
  const skinTone = [214, 172, 132];
  const hair = [92, 58, 38];
  const shirt = [56, 118, 176];
  const pants = [62, 78, 130];
  paintRect(raw, width, 0, 0, 32, 16, skinTone);
  paintRect(raw, width, 16, 16, 24, 16, shirt);
  paintRect(raw, width, 40, 16, 16, 16, skinTone);
  paintRect(raw, width, 0, 16, 16, 16, pants);
  paintRect(raw, width, 32, 48, 16, 16, skinTone);
  paintRect(raw, width, 16, 48, 16, 16, pants);
  paintRect(raw, width, 8, 8, 8, 3, hair);
  paintRect(raw, width, 9, 12, 2, 2, hair);
  paintRect(raw, width, 13, 12, 2, 2, hair);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function pngFromDataUrl(value) {
  const prefix = "data:image/png;base64,";
  if (typeof value !== "string" || !value.startsWith(prefix)) throw Error("无效的 PNG 文件");
  const bytes = Buffer.from(value.slice(prefix.length), "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE) throw Error("图片超过读取上限");
  return bytes;
}

function textValue(value, label, max) {
  if (typeof value !== "string") throw Error(label + "不能为空");
  const text = value.trim();
  if (!text) throw Error(label + "不能为空");
  if (text.length > max || /[\u0000-\u001f]/.test(text)) throw Error(label + "无效");
  return text;
}

function normalizeIdentifier(value) {
  const target = (value || "").trim();
  if (target.length > 160 || (target && !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(target)))
    throw Error("目标模型 ID 必须是 namespace:identifier 格式");
  return target;
}

function defaultSlot(target) {
  if (!target) return "skin_4";
  return targets.find((item) => item.identifier === target)?.texture_slot || "default";
}

function normalizeSlot(target, value) {
  const slot = value == null || !String(value).trim() ? defaultSlot(target) : String(value).trim();
  if (slot.length > 80 || !/^[a-zA-Z0-9_.-]+$/.test(slot))
    throw Error("贴图槽位只能包含字母、数字、下划线、点和短横线");
  return slot;
}

function isHuman(target) {
  if (!target) return true;
  const found = targets.find((item) => item.identifier === target);
  return !!(found && found.human);
}

let npcTextures;
let npcModels;
function emptyPng(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function initialSkinPng(target) {
  if (isHuman(target)) return blankSkinPng();
  npcTextures ??= require("../../../shared/skins/npc-textures.json");
  if (npcTextures[target]) return pngFromDataUrl(npcTextures[target]);
  npcModels ??= require("../../../shared/skins/npc-models.json");
  const model = npcModels[target];
  return emptyPng(model?.tw || 64, model?.th || 64);
}

function validateTexture(buffer, target) {
  if (buffer.length > MAX_IMAGE) throw Error("图片超过读取上限");
  const info = pngInfo(buffer);
  if (!isHuman(target)) return info;
  const square = info.width === info.height && info.width >= 64 && (info.width & (info.width - 1)) === 0;
  const legacy = info.width === info.height * 2 && info.height >= 32 && (info.height & (info.height - 1)) === 0;
  if ((!square && !legacy) || info.width > 4096 || info.height > 4096)
    throw Error("皮肤尺寸必须是 64x64 及其倍率，或 64x32 及其倍率（最大 4096）");
  return info;
}

function decodeText(buffer, name) {
  let bytes = buffer;
  let encoding = "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bytes = bytes.subarray(2);
    encoding = "utf-16le";
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1];
      swapped[i - 1] = bytes[i];
    }
    bytes = swapped;
    encoding = "utf-16le";
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw Error(name + ": 无法按 UTF-8 或 UTF-16 读取");
  }
}

function contained(root, file) {
  const base = path.resolve(root);
  const resolved = path.resolve(file);
  const prefix = base.toLowerCase() + path.sep;
  if (!resolved.toLowerCase().startsWith(prefix)) throw Error("皮肤文件路径无效");
  return resolved;
}

function view(skin) {
  return {
    id: skin.id,
    name: skin.name,
    author: skin.author,
    targetIdentifier: skin.targetIdentifier || "",
    textureSlot: skin.textureSlot || "skin_4",
    fromImport: skin.fromImport === true,
  };
}

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const day = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replaceAll("\\", "/"), "utf8");
    const data = entry.data || Buffer.alloc(0);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function readZip(buffer, limit) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (err) reject(err);
        else resolve(value);
      };
      zip.on("error", finish);
      zip.on("entry", (entry) => {
        if (entries.length > limit) return finish(Error("压缩包文件过多"));
        const name = entry.fileName.replaceAll("\\", "/");
        if (name.endsWith("/")) {
          entries.push({ name, data: Buffer.alloc(0) });
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 32 * 1024 * 1024) return finish(Error("压缩包内文件过大: " + name));
        zip.openReadStream(entry, (err, stream) => {
          if (err) return finish(err);
          const chunks = [];
          let size = 0;
          stream.on("data", (chunk) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) {
              stream.destroy();
              finish(Error("压缩包内文件过大: " + name));
            } else chunks.push(chunk);
          });
          stream.on("end", () => {
            if (settled) return;
            entries.push({ name, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
          stream.on("error", finish);
        });
      });
      zip.on("end", () => finish(null, entries));
      zip.readEntry();
    });
  });
}

let templateEntries;
async function loadTemplate() {
  templateEntries ??= await readZip(templateZip, 200);
  return templateEntries.map((entry) => ({ name: entry.name, data: entry.data }));
}

function mapName(name, pack, config) {
  return name
    .replaceAll("ModName_npc_skinB", pack + "_npc_skinB")
    .replaceAll("ModName_npc_skinR", pack + "_npc_skinR")
    .replaceAll("ModName_npcdlcskin_Scripts", pack + "_npcdlcskin_Scripts")
    .replaceAll("modconfigs/ModName_skindlc.json", "modconfigs/" + config);
}

function updateManifest(data) {
  const manifest = JSON.parse(decodeText(data, "manifest.json"));
  if (manifest.header) manifest.header.uuid = crypto.randomUUID();
  for (const module of manifest.modules || []) module.uuid = crypto.randomUUID();
  return Buffer.from(JSON.stringify(manifest, null, 4) + "\n", "utf8");
}

function textureZipPath(pack, skin) {
  const root = pack + "_npc_skinR/";
  if (!skin.fromImport) return root + "textures/entity/npc_dlcskin/" + skin.id + ".png";
  let texture = String(skin.texture || "").replaceAll("\\", "/").trim();
  if (texture.toLowerCase().endsWith(".png")) texture = texture.slice(0, -4);
  const parts = texture.split("/");
  if (!texture.toLowerCase().startsWith("textures/") || parts.includes("..") || parts.includes(""))
    throw Error("导入皮肤的 texture 必须是 textures/ 下的相对路径");
  return root + texture + ".png";
}

class NpcSkins {
  constructor(root) {
    this.root = path.join(root, "npc-skins");
    this.files = path.join(this.root, "files");
    this.incoming = path.join(this.root, "incoming");
    this.draftFile = path.join(this.root, "draft.json");
    this.tail = Promise.resolve();
    this.ready = null;
  }
  run(work) {
    const job = this.tail.then(() => this.boot()).then(work);
    this.tail = job.then(() => {}, () => {});
    return job;
  }
  boot() {
    this.ready ??= (async () => {
      try {
        await fs.rm(this.incoming, { recursive: true, force: true });
        await fs.mkdir(this.files, { recursive: true });
        await fs.mkdir(this.incoming, { recursive: true });
      } catch (error) {
        this.ready = null;
        throw error;
      }
    })();
    return this.ready;
  }
  targets() {
    return targets.map((item) => ({ ...item }));
  }
  async load() {
    try {
      const data = JSON.parse((await fs.readFile(this.draftFile, "utf8")).replace(/^\uFEFF/, ""));
      if (!data || data.version !== 1 || !Array.isArray(data.skins)) throw Error("皮肤草稿无法读取");
      return data.skins;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error.code ? error : Error("皮肤草稿无法读取");
    }
  }
  async save(skins) {
    const body = JSON.stringify({ version: 1, skins }, null, 2);
    const temp = this.draftFile + "." + process.pid + ".tmp";
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(temp, body);
    await fs.rm(this.draftFile, { force: true });
    await fs.rename(temp, this.draftFile);
  }
  async list() {
    return this.run(async () => ({ items: (await this.load()).map(view) }));
  }
  async stage(buffer, filename) {
    return this.run(async () => {
      if (!Buffer.isBuffer(buffer)) throw Error("无效的 PNG 文件");
      pngInfo(buffer);
      if (buffer.length > MAX_IMAGE) throw Error("图片超过读取上限");
      const id = "stage_" + crypto.randomBytes(16).toString("hex");
      await fs.writeFile(path.join(this.incoming, id + ".png"), buffer);
      const name = path.basename(String(filename || "skin.png")).replace(/\.png$/i, "").slice(0, MAX_TEXT);
      return { token: id, name: name || "skin" };
    });
  }
  async discard(tokens) {
    return this.run(async () => {
      for (const token of [].concat(tokens || [])) await this.removeStage(token);
      return true;
    });
  }
  async removeStage(token) {
    if (typeof token !== "string" || !/^stage_[a-f0-9]{32}$/.test(token)) return;
    await fs.rm(path.join(this.incoming, token + ".png"), { force: true });
  }
  async stageFile(token) {
    if (typeof token !== "string" || !/^stage_[a-f0-9]{32}$/.test(token)) throw Error("皮肤文件已失效，请重新选择");
    const file = contained(this.incoming, path.join(this.incoming, token + ".png"));
    return fs.readFile(file);
  }
  async add(items) {
    return this.run(async () => {
      if (!Array.isArray(items) || !items.length) throw Error("请选择 PNG 贴图");
      const skins = await this.load();
      if (skins.length + items.length > MAX_SKINS) throw Error("单次最多支持 " + MAX_SKINS + " 个皮肤");
      const used = new Set(skins.map((skin) => String(skin.id).toLowerCase()));
      const seen = new Set();
      const created = [];
      const written = [];
      try {
        for (const item of items) {
          if (!item || seen.has(item.token)) throw Error("皮肤文件已失效，请重新选择");
          seen.add(item.token);
          const target = normalizeIdentifier(item.targetIdentifier);
          const slot = normalizeSlot(target, item.textureSlot);
          const bytes = await this.stageFile(item.token);
          validateTexture(bytes, target);
          const id = skinId(used);
          const filename = crypto.randomBytes(16).toString("hex") + ".png";
          await fs.writeFile(path.join(this.files, filename), bytes);
          written.push(filename);
          created.push({
            id,
            name: textValue(item.name, "人物名称", MAX_TEXT),
            author: textValue(item.author, "作者", MAX_TEXT),
            targetIdentifier: target,
            textureSlot: slot,
            fromImport: false,
            texture: "textures/entity/npc_dlcskin/" + id,
            file: "files/" + filename,
          });
        }
        const next = skins.concat(created);
        await this.save(next);
        for (const item of items) await this.removeStage(item.token);
        return { items: next.map(view) };
      } catch (error) {
        await Promise.all(written.map((filename) => fs.rm(path.join(this.files, filename), { force: true })));
        throw error;
      }
    });
  }
  async create(input = {}) {
    return this.run(async () => {
      const skins = await this.load();
      if (skins.length >= MAX_SKINS) throw Error("单次最多支持 " + MAX_SKINS + " 个皮肤");
      const name = textValue(input.name, "人物名称", MAX_TEXT);
      const author = textValue(input.author, "作者", MAX_TEXT);
      const target = normalizeIdentifier(input.targetIdentifier);
      const slot = normalizeSlot(target, input.textureSlot);
      const bytes = initialSkinPng(target);
      validateTexture(bytes, target);
      const used = new Set(skins.map((skin) => String(skin.id).toLowerCase()));
      const id = skinId(used);
      const filename = crypto.randomBytes(16).toString("hex") + ".png";
      await fs.writeFile(path.join(this.files, filename), bytes);
      const skin = {
        id,
        name,
        author,
        targetIdentifier: target,
        textureSlot: slot,
        fromImport: false,
        texture: "textures/entity/npc_dlcskin/" + id,
        file: "files/" + filename,
      };
      try {
        const next = skins.concat(skin);
        await this.save(next);
        return { items: next.map(view), skin: view(skin) };
      } catch (error) {
        await fs.rm(path.join(this.files, filename), { force: true });
        throw error;
      }
    });
  }
  async update(id, patch) {
    return this.run(async () => {
      const skins = await this.load();
      const index = skins.findIndex((skin) => skin.id === id);
      if (index < 0) throw Error("找不到这个皮肤");
      const current = skins[index];
      const target = normalizeIdentifier(patch.targetIdentifier == null ? current.targetIdentifier : patch.targetIdentifier);
      const slot = normalizeSlot(target, patch.textureSlot == null ? current.textureSlot : patch.textureSlot);
      const file = this.ownedFile(current);
      const bytes = patch.image ? pngFromDataUrl(patch.image) : await fs.readFile(file);
      validateTexture(bytes, target);
      if (patch.image) {
        const temp = file + "." + process.pid + ".tmp";
        await fs.writeFile(temp, bytes);
        await fs.rm(file, { force: true });
        await fs.rename(temp, file);
      }
      const next = skins.slice();
      next[index] = {
        ...current,
        name: textValue(patch.name == null ? current.name : patch.name, "人物名称", MAX_TEXT),
        author: textValue(patch.author == null ? current.author : patch.author, "作者", MAX_TEXT),
        targetIdentifier: target,
        textureSlot: slot,
      };
      await this.save(next);
      return { items: next.map(view) };
    });
  }
  ownedFile(skin) {
    if (typeof skin.file !== "string" || !/^files\/[a-f0-9]{32}\.png$/.test(skin.file))
      throw Error("皮肤文件路径无效");
    return contained(this.files, path.join(this.root, skin.file));
  }
  async remove(id) {
    const ids = Array.isArray(id) ? id : [id];
    if (!ids.length || ids.some((item) => typeof item !== "string" || !item)) throw Error("找不到这个皮肤");
    return this.run(async () => {
      const skins = await this.load();
      const chosen = ids.map((item) => skins.find((skin) => skin.id === item));
      if (chosen.some((skin) => !skin)) throw Error("找不到这个皮肤");
      const drop = new Set(ids);
      const next = skins.filter((skin) => !drop.has(skin.id));
      await this.save(next);
      await Promise.all(chosen.map((skin) => fs.rm(this.ownedFile(skin), { force: true })));
      return { items: next.map(view) };
    });
  }
  async image(id) {
    return this.run(async () => {
      let file;
      if (typeof id === "string" && id.startsWith("stage_")) file = contained(this.incoming, path.join(this.incoming, id + ".png"));
      else {
        const skin = (await this.load()).find((item) => item.id === id);
        if (!skin) throw Error("找不到这个皮肤");
        file = this.ownedFile(skin);
      }
      const bytes = await fs.readFile(file);
      if (bytes.length > MAX_IMAGE) throw Error("图片超过读取上限");
      return "data:image/png;base64," + bytes.toString("base64");
    });
  }
  async importZip(zipPath) {
    return this.run(async () => {
      if (typeof zipPath !== "string" || !path.isAbsolute(zipPath)) throw Error("请选择 ZIP 文件");
      const stat = await fs.lstat(zipPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024)
        throw Error("请选择 ZIP 文件");
      const entries = await readZip(await fs.readFile(zipPath), 4000);
      const configs = [];
      for (const entry of entries) {
        if (entry.name.split("/").includes("..") || path.win32.isAbsolute(entry.name))
          throw Error("压缩包路径无效: " + entry.name);
        const lower = entry.name.toLowerCase();
        if (!lower.includes("/modconfigs/") || !lower.endsWith(".json") || !entry.data.length) continue;
        if (entry.data.length > 8 * 1024 * 1024) continue;
        let value;
        try {
          value = JSON.parse(decodeText(entry.data, entry.name));
        } catch (error) {
          throw Error(entry.name + ": " + error.message);
        }
        if (Array.isArray(value.npcskinlist)) configs.push({ name: entry.name, value });
      }
      if (configs.length !== 1) throw Error("ZIP 必须包含且仅包含一份 npcskinlist 皮肤配置");
      const config = configs[0];
      if (config.value.npcskinlist.length > MAX_SKINS) throw Error("皮肤数量超过限制（最多 " + MAX_SKINS + " 个）");
      if (config.value.npcskinlist.some((item) => !item || typeof item !== "object" || Array.isArray(item)))
        throw Error("皮肤配置条目必须是对象");
      const root = config.name.slice(0, config.name.toLowerCase().indexOf("/modconfigs/")) + "/";
      const used = new Set();
      const imported = [];
      for (const item of config.value.npcskinlist) {
        for (const key of ["ID", "name", "texture"])
          if (typeof item[key] !== "string" || !item[key].trim()) throw Error("皮肤字段必须是非空字符串: " + key);
        if (item.by != null && typeof item.by !== "string") throw Error("皮肤作者必须是字符串");
        if (item.target_identifier != null && typeof item.target_identifier !== "string")
          throw Error("目标模型 ID 必须是字符串");
        if (item.texture_slot != null && typeof item.texture_slot !== "string")
          throw Error("贴图槽位必须是字符串");
        const id = item.ID.trim();
        if (/[\\/\u0000]/.test(id) || id.length > 80) throw Error("皮肤 ID 无效: " + id);
        if (used.has(id.toLowerCase())) throw Error("皮肤 ID 重复: " + id);
        used.add(id.toLowerCase());
        let texture = item.texture.replaceAll("\\", "/").trim();
        if (texture.toLowerCase().endsWith(".png")) texture = texture.slice(0, -4);
        if (!texture.toLowerCase().startsWith("textures/") || texture.split("/").includes(".."))
          throw Error("无效的贴图路径: " + texture);
        const target = normalizeIdentifier(item.target_identifier || "");
        const wanted = (root + texture + ".png").toLowerCase();
        const matches = entries.filter((entry) => entry.name.toLowerCase() === wanted && !entry.name.endsWith("/"));
        if (matches.length !== 1 || matches[0].data.length > MAX_IMAGE || !matches[0].data.length)
          throw Error("贴图缺失、重复或过大: " + texture);
        validateTexture(matches[0].data, target);
        imported.push({
          id,
          name: textValue(item.name, "人物名称", 200),
          author: typeof item.by === "string" && item.by.trim() ? textValue(item.by, "作者", 200) : "NPC皮肤拓展",
          targetIdentifier: target,
          textureSlot: normalizeSlot(target, item.texture_slot),
          fromImport: true,
          texture,
          bytes: matches[0].data,
        });
      }
      const written = [];
      try {
        const skins = imported.map((skin) => {
          const filename = crypto.randomBytes(16).toString("hex") + ".png";
          written.push({ filename, bytes: skin.bytes });
          return { ...skin, bytes: undefined, file: "files/" + filename };
        });
        for (const file of written) await fs.writeFile(path.join(this.files, file.filename), file.bytes);
        const previous = await this.load();
        await this.save(skins);
        for (const skin of previous) {
          try { await fs.rm(this.ownedFile(skin), { force: true }); } catch { /* 旧贴图留在目录里不影响新草稿 */ }
        }
        return { items: skins.map(view) };
      } catch (error) {
        await Promise.all(written.map((file) => fs.rm(path.join(this.files, file.filename), { force: true })));
        throw error;
      }
    });
  }
  async exportModern(dir) {
    return this.run(async () => {
      if (typeof dir !== "string" || !path.isAbsolute(dir) || /[\u0000\r\n]/.test(dir)) throw Error("导出目录无效");
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("导出目录无效");
      const skins = await this.load();
      if (!skins.length) throw Error("皮肤列表为空，无法导出");
      const used = new Set();
      let converted = 0;
      let copied = 0;
      for (const skin of skins) {
        const bytes = await fs.readFile(this.ownedFile(skin));
        const info = pngInfo(bytes);
        const legacy = info.width === info.height * 2 && info.height >= 32 && (info.height & (info.height - 1)) === 0 && info.width <= 4096;
        const output = legacy ? modernizeSkinPng(bytes) : bytes;
        if (legacy) converted += 1;
        else copied += 1;
        const file = contained(dir, path.join(dir, exportFileName(skin.name, skin.id, used)));
        await fs.writeFile(file, output);
      }
      return { directory: dir, converted, copied, count: skins.length };
    });
  }
  async exportZip(dest) {
    return this.run(async () => {
      if (typeof dest !== "string" || !path.isAbsolute(dest) || /[\u0000\r\n]/.test(dest))
        throw Error("导出路径无效");
      const output = dest.toLowerCase().endsWith(".zip") ? dest : dest + ".zip";
      const parent = await fs.lstat(path.dirname(output));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error("导出目录无效");
      try {
        const existing = await fs.lstat(output);
        if (existing.isSymbolicLink() || !existing.isFile()) throw Error("导出路径无效");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const skins = await this.load();
      if (!skins.length) throw Error("皮肤列表为空，无法打包");
      const pack = packageName();
      const config = configName();
      const entries = (await loadTemplate()).map((entry) => {
        const name = mapName(entry.name, pack, config);
        let data = entry.data;
        if (name.endsWith("/manifest.json")) data = updateManifest(data);
        else if (name.endsWith("/init_modnpcskinClientSystem.py")) {
          const text = data.toString("utf8");
          if (!text.includes("ModName_skindlc.json")) throw Error("模板脚本缺少皮肤配置文件名");
          data = Buffer.from(text.replaceAll("ModName_skindlc.json", config), "utf8");
        } else if (name.endsWith("/modconfigs/" + config)) {
          const list = skins.map((skin) => {
            const item = { ID: skin.id, name: skin.name, by: skin.author, texture: skin.texture };
            if (skin.targetIdentifier) {
              item.target_identifier = skin.targetIdentifier;
              item.texture_slot = skin.textureSlot;
            }
            return item;
          });
          data = Buffer.from(JSON.stringify({ npcskinlist: list }, null, 4) + "\n", "utf8");
        }
        return { name, data };
      });
      const textures = new Map();
      for (const skin of skins) {
        const name = textureZipPath(pack, skin);
        const bytes = await fs.readFile(this.ownedFile(skin));
        validateTexture(bytes, skin.targetIdentifier);
        const previous = textures.get(name.toLowerCase());
        if (previous && !previous.equals(bytes)) throw Error("不同贴图内容指向了同一个路径: " + skin.texture);
        if (!previous) textures.set(name.toLowerCase(), bytes);
        if (!previous) entries.push({ name, data: bytes });
      }
      const ready = entries.some((entry) => entry.name.startsWith(pack + "_npc_skinB/"))
        && entries.some((entry) => entry.name.startsWith(pack + "_npc_skinR/"))
        && entries.some((entry) => entry.name.endsWith("/init_modnpcskinClientSystem.py") && entry.data.includes(config));
      if (!ready) throw Error("皮肤模板不完整");
      const temp = output + "." + process.pid + ".tmp";
      await fs.writeFile(temp, zipStore(entries));
      await fs.rm(output, { force: true });
      await fs.rename(temp, output);
      return { path: output };
    });
  }
}

module.exports = { NpcSkins, pngInfo, zipStore, modernizeSkinPng, decodePng, encodeRgbaPng };
