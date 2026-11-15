const zlib = require("node:zlib"), crypto = require("node:crypto");
const { pngInfo } = require("../skins/npc-skins.cjs");
const { validateLayers, MAX_DOCUMENT } = require("../../../shared/texture-layers.cjs");
const MAX_PNG = 4 * 1024 * 1024, CHUNK = "dgNL";
const digest = data => crypto.createHash("sha256").update(data).digest("hex");

function inspectPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PNG) throw Error("贴图 PNG 超过 4MB");
  const size = pngInfo(bytes);
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw Error("PNG 头部无效");
  if (size.width > 2048 || size.height > 2048) throw Error("贴图尺寸超过 2048");
  let offset = 8, metadata = null, end = 0;
  const plain = [bytes.subarray(0, 8)];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === CHUNK) {
      if (metadata) throw Error("PNG 中包含重复图层数据");
      metadata = bytes.subarray(offset + 8, offset + 8 + length);
    } else plain.push(bytes.subarray(offset, offset + 12 + length));
    if (type === "IEND") { if (length) throw Error("PNG 结束块无效"); end = offset + 12; break; }
    offset += 12 + length;
  }
  if (end !== bytes.length) throw Error("PNG 结尾包含无效数据");
  return { ...size, metadata, png: Buffer.concat(plain) };
}

function checkedLayers(value, width, height) {
  const result = validateLayers(value, width, height);
  for (const layer of result.layers) for (const source of [layer.source, layer.mask?.source].filter(Boolean)) {
    const image = inspectPng(Buffer.from(source.slice(22), "base64"));
    if (image.metadata || image.width !== width || image.height !== height) throw Error("图层尺寸不匹配或包含嵌套图层");
    // 有界解压校验，避免把损坏或压缩炸弹保存到编辑图层。
    let offset = 8, header, chunks = [];
    while (offset + 12 <= image.png.length) {
      const length = image.png.readUInt32BE(offset), type = image.png.toString("ascii", offset + 4, offset + 8), data = image.png.subarray(offset + 8, offset + 8 + length);
      if (type === "IHDR") header = data;
      if (type === "IDAT") chunks.push(data);
      offset += length + 12;
    }
    if (header?.length !== 13 || header[8] !== 8 || ![2, 6].includes(header[9]) || header[10] || header[11] || header[12]) throw Error("图层 PNG 必须是非隔行 RGB/RGBA 8 位图");
    const stride = width * (header[9] === 6 ? 4 : 3) + 1, expected = stride * height;
    const raw = zlib.inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
    if (raw.length !== expected) throw Error("图层 PNG 像素数据不完整");
    for (let y = 0; y < height; y++) if (raw[y * stride] > 4) throw Error("图层 PNG 滤镜无效");
  }
  return result;
}

function readLayerPng(bytes) {
  const image = inspectPng(bytes);
  if (!image.metadata) return { dataUrl: "data:image/png;base64," + image.png.toString("base64"), layers: null };
  let document;
  try { document = JSON.parse(zlib.inflateSync(image.metadata, { maxOutputLength: MAX_DOCUMENT + 65536 }).toString("utf8")); }
  catch { throw Error("PNG 图层数据损坏，未覆盖文件；请恢复备份后重试"); }
  if (document.pngHash !== digest(image.png)) throw Error("PNG 已被外部修改，图层与图像不一致；请恢复备份或另存普通 PNG 后重开");
  return { dataUrl: "data:image/png;base64," + image.png.toString("base64"), layers: checkedLayers(document, image.width, image.height) };
}

function writeLayerPng(dataUrl, layers) {
  if (typeof dataUrl !== "string" || dataUrl.length > 6 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw Error("贴图数据无效");
  const image = inspectPng(Buffer.from(dataUrl.slice(22), "base64"));
  if (image.metadata) throw Error("合成图不能包含嵌套图层数据");
  if (!layers) return image.png;
  const document = checkedLayers(layers, image.width, image.height);
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify({ ...document, pngHash: digest(image.png) }), "utf8"));
  const size = Buffer.alloc(4), body = Buffer.concat([Buffer.from(CHUNK), compressed]), crc = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length); crc.writeUInt32BE(zlib.crc32(body));
  // 私有辅助块，合成图仍是标准 PNG；一次原子替换同时保存图像和图层。
  const result = Buffer.concat([image.png.subarray(0, -12), size, body, crc, image.png.subarray(-12)]);
  if (result.length > MAX_PNG) throw Error("含图层的 PNG 超过 4MB，请减少图层或尺寸");
  return result;
}

module.exports = { readLayerPng, writeLayerPng, digest };
