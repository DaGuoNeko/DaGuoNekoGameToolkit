const { parseNbtRecord, MAX_BYTES } = require("./world-data-codec.cjs");
const pointer = key => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error("整数超出原始字段类型范围");
  return value;
}
function text(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 1024 * 1024 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) throw Error("文本过长或包含无效 Unicode");
  return Buffer.from(value, "utf8");
}
function lengthHeader(tag, size, width) {
  const buffer = Buffer.alloc(width + 1); buffer[0] = tag;
  buffer.writeUIntBE(size, 1, width); return buffer;
}
function encodeMessage(value, path, entry, depth = 0) {
  if (depth > 64) throw Error("数据嵌套超过限制");
  const original = entry.nodes[path];
  if (original && same(original.value, value)) return entry.raw.subarray(original.start, original.end);
  if (original?.value && typeof original.value === "object" && ["$binary", "$extension", "$map", "$float"].some(key => Object.hasOwn(original.value, key))) throw Error("未知二进制或扩展只能原样保留");
  const tag = original?.tag;
  if (value === null) return Buffer.from([0xc0]);
  if (typeof value === "boolean") return Buffer.from([value ? 0xc3 : 0xc2]);
  if (typeof value === "string") {
    const raw = text(value), binary = tag === undefined || tag >= 0xc4 && tag <= 0xc6;
    return Buffer.concat([lengthHeader(binary ? 0xc6 : 0xdb, raw.length, 4), raw]);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw Error("数字无效，大整数需保留 $integer64 字符串");
    if (Number.isInteger(value) && tag !== 0xca && tag !== 0xcb) {
      if (value >= 0 && value <= 0xffffffff) { const out = Buffer.alloc(5); out[0] = 0xce; out.writeUInt32BE(value, 1); return out; }
      if (value >= -2147483648 && value < 0) { const out = Buffer.alloc(5); out[0] = 0xd2; out.writeInt32BE(value, 1); return out; }
      throw Error("超出 32 位的整数请使用 {\"$integer64\":\"十进制整数\"} 表示");
    }
    const out = Buffer.alloc(9); out[0] = 0xcb; out.writeDoubleBE(value, 1); return out;
  }
  if (!value || typeof value !== "object") throw Error("不支持的字段值");
  if (Object.hasOwn(value, "$integer64")) {
    if (Object.keys(value).length !== 1 || typeof value.$integer64 !== "string" || !/^-?\d+$/.test(value.$integer64)) throw Error("64 位整数格式无效");
    const number = BigInt(value.$integer64), unsigned = tag === 0xcf;
    if (number < (unsigned ? 0n : -(1n << 63n)) || number > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)) throw Error("64 位整数越界");
    const out = Buffer.alloc(9); out[0] = unsigned ? 0xcf : 0xd3; out[unsigned ? "writeBigUInt64BE" : "writeBigInt64BE"](number, 1); return out;
  }
  if (["$binary", "$extension", "$map", "$float"].some(key => Object.hasOwn(value, key))) throw Error("未知二进制或扩展只能原样保留，不能改写");
  const entries = Object.entries(value);
  if (entries.length > 200000) throw Error("集合过大");
  if (Array.isArray(value)) return Buffer.concat([lengthHeader(0xdd, value.length, 4), ...value.map((item, i) => encodeMessage(item, path + "/" + i, entry, depth + 1))]);
  const parts = [lengthHeader(0xdf, entries.length, 4)];
  const keys = new Map(original?.keys?.map(node => [String(node.value), node]) || []);
  for (const [key, item] of entries) {
    // 网易 Python 的字段名使用二进制字符串，新增键保持这一约定。
    const keyNode = keys.get(key);
    const keyBytes = text(key), encodedKey = keyNode ? entry.raw.subarray(keyNode.start, keyNode.end) : Buffer.concat([lengthHeader(0xc6, keyBytes.length, 4), keyBytes]);
    parts.push(encodedKey, encodeMessage(item, path + "/" + pointer(key), entry, depth + 1));
  }
  return Buffer.concat(parts);
}
function encodeNbt(value, type, little) {
  const endian = little ? "LE" : "BE";
  if ([1, 2, 3].includes(type)) {
    const size = 2 ** (type - 1), out = Buffer.alloc(size);
    integer(value, -(2 ** (size * 8 - 1)), 2 ** (size * 8 - 1) - 1);
    if (size === 1) out.writeInt8(value); else out["writeInt" + size * 8 + endian](value); return out;
  }
  if (type === 4) {
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw Error("NBT long 必须用十进制字符串表示");
    const n = BigInt(value); if (n < -(1n << 63n) || n >= 1n << 63n) throw Error("NBT long 越界");
    const out = Buffer.alloc(8); out["writeBigInt64" + endian](n); return out;
  }
  if (type === 5 || type === 6) {
    if (typeof value !== "number" || !Number.isFinite(value) || type === 5 && !Number.isFinite(Math.fround(value))) throw Error("浮点数超出范围");
    const out = Buffer.alloc(type === 5 ? 4 : 8); out["write" + (type === 5 ? "Float" : "Double") + endian](value); return out;
  }
  if (type === 8) {
    const raw = text(value); if (raw.length > 65535) throw Error("NBT 字符串超过 65535 字节");
    const length = Buffer.alloc(2); length["writeUInt16" + endian](raw.length); return Buffer.concat([length, raw]);
  }
  throw Error("此 NBT 结构不能整体改写，请选择内部字段；不新增或删除 NBT 类型定义");
}
function patchRecord(raw, field, newValue, options = {}) {
  if (typeof field !== "string" || !field.startsWith("/") || field.length > 8192) throw Error("请选择具体字段进行编辑");
  if (/^\/(?:x|y|z|Pos|UniqueID|UUID|identifier|id|StorageVersion|NetworkVersion|saveLongString)(?:\/|$)/.test(field)) throw Error("坐标、身份与存储格式字段受保护，不能直接改写");
  if (Buffer.byteLength(JSON.stringify(newValue) ?? "") > 2 * 1024 * 1024) throw Error("单次编辑超过 2 MiB");
  const parsed = parseNbtRecord(raw, { ...options, capture: true });
  let start, end, replacement, oldValue;
  const scriptPath = Object.keys(parsed.scripts).find(path => field === path || field.startsWith(path + "/"));
  if (scriptPath) {
    const script = parsed.scripts[scriptPath], node = script.nodes[field];
    if (!node || parsed.warnings.length) throw Error("该扩展数据未完整解码，不能写回");
    oldValue = node.value;
    const encoded = encodeMessage(newValue, field, script);
    const payload = Buffer.concat([script.raw.subarray(0, node.start), encoded, script.raw.subarray(node.end)]);
    if (payload.length >= 2 ** (8 * script.lengthBytes)) throw Error("扩展字符串超过原长度格式上限");
    const length = Buffer.alloc(script.lengthBytes); length.writeUIntLE(payload.length, 0, script.lengthBytes);
    start = script.start; end = script.end; replacement = Buffer.concat([length, payload]);
  } else {
    let node = parsed.nodes[field];
    if (!node && ["/MinimumCompatibleClientVersion", "/lastOpenedWithVersion", "/baseGameVersion"].includes(field)) {
      const name = Buffer.from(field.slice(1)), header = Buffer.alloc(3 + name.length); header[0] = field === "/baseGameVersion" ? 8 : 9; header.writeUInt16LE(name.length, 1); name.copy(header, 3);
      const initial = header[0] === 8 ? Buffer.from([0, 0]) : Buffer.from([3, 0, 0, 0, 0]);
      const at = parsed.nodes[""].end - 1;
      const expanded = Buffer.concat([raw.subarray(0, at), header, initial, raw.subarray(at)]);
      return { ...patchRecord(expanded, field, newValue, options), before: undefined };
    }
    if (!node) throw Error("字段不存在");
    start = node.start; end = node.end; oldValue = node.value;
    if (node.type === 9 || node.type === 11 || node.type === 12) {
      if (!Array.isArray(newValue) || newValue.length > 200000) throw Error("数组格式无效");
      const type = node.type === 9 ? raw[start] : node.type === 11 ? 3 : 4;
      const length = Buffer.alloc(node.type === 9 ? 5 : 4); if (node.type === 9) length[0] = type;
      length[options.little === false ? "writeInt32BE" : "writeInt32LE"](newValue.length, node.type === 9 ? 1 : 0);
      replacement = Buffer.concat([length, ...newValue.map(value => encodeNbt(value, type, options.little !== false))]);
    } else replacement = encodeNbt(newValue, node.type, options.little !== false);
  }
  if (same(oldValue, newValue)) throw Error("字段内容没有变化");
  const result = Buffer.concat([raw.subarray(0, start), replacement, raw.subarray(end)]);
  if (result.length > MAX_BYTES) throw Error("写入后的记录超过 16 MiB");
  const check = parseNbtRecord(result, { ...options, capture: true });
  const actual = scriptPath ? check.scripts[scriptPath]?.nodes[field]?.value : check.nodes[field]?.value;
  const type = parsed.nodes[field]?.type, normalized = type === 5 ? Math.fround(newValue) : type === 9 && raw[parsed.nodes[field].start] === 5 ? newValue.map(Math.fround) : newValue;
  if (!same(actual, normalized)) throw Error("写入编码回读校验失败");
  return { bytes: result, before: oldValue, after: actual, type: parsed.types[field] || typeof oldValue };
}
module.exports = { patchRecord };
