// 只读解码：保留大整数、原始类型和未知扩展，不执行存档内容。
const MAX_BYTES = 16 * 1024 * 1024;
function reader(bytes, little = true) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw Error("数据记录超过 16 MiB 或格式无效");
  let offset = 0, nodes = 0;
  const take = size => {
    if (!Number.isInteger(size) || size < 0 || offset + size > bytes.length) throw Error("数据长度越界");
    const start = offset; offset += size; return start;
  };
  const number = (size, signed = false, float = false) => {
    const at = take(size);
    if (size === 1) return signed ? bytes.readInt8(at) : bytes.readUInt8(at);
    const method = "read" + (float ? size === 4 ? "Float" : "Double" : signed ? "Int" : "UInt") + (float ? "" : size * 8) + (little ? "LE" : "BE");
    const value = bytes[method](at);
    return float && !Number.isFinite(value) ? { $float: String(value) } : value;
  };
  const long = signed => bytes[(signed ? "readBigInt64" : "readBigUInt64") + (little ? "LE" : "BE")](take(8)).toString();
  const buffer = size => bytes.subarray(take(size), offset);
  const text = size => new TextDecoder("utf-8", { fatal: true }).decode(buffer(size));
  const count = value => { if (!Number.isInteger(value) || value < 0 || value > 200000) throw Error("集合长度超过限制"); return value; };
  const visit = depth => { if (depth > 64 || ++nodes > 400000) throw Error("数据嵌套或节点数超过限制"); };
  return { number, long, buffer, text, count, visit, get offset() { return offset; } };
}

function decodeMessagePack(bytes, { binaryText = false, types = {}, path = "", nodes = null } = {}) {
  const r = reader(bytes, false), mapKeys = new Map();
  function read(depth = 0, field = path) {
    const start = r.offset, value = readValue(depth, field);
    if (nodes) nodes[field] = { start, end: r.offset, tag: bytes[start], value, keys: mapKeys.get(field) };
    return value;
  }
  function readValue(depth, field) {
    r.visit(depth);
    const tag = r.number(1);
    const array = size => Array.from({ length: r.count(size) }, (_, i) => read(depth + 1, field + "/" + i));
    const map = size => {
      const keys = []; if (nodes) mapKeys.set(field, keys);
      const entries = Array.from({ length: r.count(size) }, (_, i) => {
        const start = r.offset, key = readValue(depth + 1, field + "/@key" + i);
        if (nodes) keys.push({ value: key, start, end: r.offset });
        const part = typeof key === "string" || typeof key === "number" ? String(key).replace(/~/g, "~0").replace(/\//g, "~1") : "@value" + i;
        return [key, read(depth + 1, field + "/" + part)];
      });
      if (entries.some(([key]) => !["string", "number"].includes(typeof key)) || new Set(entries.map(([k]) => String(k))).size !== entries.length)
        return { $map: entries };
      return Object.fromEntries(entries);
    };
    const ext = size => ({ $extension: r.number(1, true), base64: r.buffer(size).toString("base64") });
    if (tag < 0x80) return tag;
    if (tag >= 0xe0) return tag - 256;
    if (tag >= 0xa0 && tag <= 0xbf) return r.text(tag & 31);
    if (tag >= 0x90 && tag <= 0x9f) return array(tag & 15);
    if (tag >= 0x80 && tag <= 0x8f) return map(tag & 15);
    if (tag === 0xc0) return null;
    if (tag === 0xc2 || tag === 0xc3) return tag === 0xc3;
    if (tag >= 0xc4 && tag <= 0xc6) {
      const raw = r.buffer(r.number(2 ** (tag - 0xc4)));
      types[field] = "messagepack.binary";
      // 网易 Python 字节串承载 UTF-8 字段名与文本；保留类型以便无损解释。
      if (binaryText) {
        try { return new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch {}
      }
      return { $binary: raw.toString("base64") };
    }
    if (tag >= 0xc7 && tag <= 0xc9) return ext(r.number(2 ** (tag - 0xc7)));
    if (tag === 0xca || tag === 0xcb) return r.number(tag === 0xca ? 4 : 8, false, true);
    if (tag >= 0xcc && tag <= 0xce) return r.number(2 ** (tag - 0xcc));
    if (tag === 0xcf || tag === 0xd3) return { $integer64: r.long(tag === 0xd3) };
    if (tag >= 0xd0 && tag <= 0xd2) return r.number(2 ** (tag - 0xd0), true);
    if (tag >= 0xd4 && tag <= 0xd8) return ext(2 ** (tag - 0xd4));
    if (tag >= 0xd9 && tag <= 0xdb) return r.text(r.number(2 ** (tag - 0xd9)));
    if (tag === 0xdc || tag === 0xdd) return array(r.number(tag === 0xdc ? 2 : 4));
    if (tag === 0xde || tag === 0xdf) return map(r.number(tag === 0xde ? 2 : 4));
    throw Error("不支持的 MessagePack 标记：" + tag);
  }
  const value = read();
  if (r.offset !== bytes.length) throw Error("MessagePack 存在未消费的尾部数据");
  return value;
}

function parseNbtRecord(bytes, { little = true, worldScript = false, capture = false } = {}) {
  const r = reader(bytes, little), types = {}, warnings = [], nodes = {}, scripts = {};
  const names = ["end", "byte", "short", "int", "long", "float", "double", "byteArray", "string", "list", "compound", "intArray", "longArray"];
  const name = () => r.text(r.number(2));
  function value(type, path, depth, parent) {
    const start = r.offset, result = readValue(type, path, depth, parent);
    if (capture) nodes[path] = { start, end: r.offset, type, value: result };
    return result;
  }
  function readValue(type, path, depth, parent) {
    r.visit(depth);
    if (!names[type] || type === 0) throw Error("NBT 类型无效：" + type);
    types[path] = names[type];
    if (type <= 3) return r.number(2 ** (type - 1), true);
    if (type === 4) return r.long(true);
    if (type === 5 || type === 6) return r.number(type === 5 ? 4 : 8, false, true);
    if (type === 7) return { $binary: r.buffer(r.number(4, true)).toString("base64") };
    if (type === 8) {
      const script = little && path.endsWith("/scriptData");
      const extended = script && (worldScript || parent?.saveLongString === 1);
      const start = r.offset;
      const raw = r.buffer(r.number(extended ? 4 : 2));
      if (script) {
        types[path] = extended ? "neteaseScriptData32" : "neteaseScriptData16";
        const entry = { start, end: r.offset, lengthBytes: extended ? 4 : 2, nodes: {}, raw };
        if (capture) scripts[path] = entry;
        try { return decodeMessagePack(raw, { binaryText: true, types, path, nodes: capture ? entry.nodes : null }); }
        catch (e) { warnings.push({ path, message: e.message }); return { $binary: raw.toString("base64"), error: "未能解码 MessagePack" }; }
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    }
    if (type === 9) {
      const subtype = r.number(1), size = r.count(r.number(4, true));
      types[path] = "list<" + names[subtype] + ">";
      return Array.from({ length: size }, (_, i) => value(subtype, path + "/" + i, depth + 1));
    }
    if (type === 10) {
      const object = Object.create(null);
      for (;;) {
        const child = r.number(1); if (child === 0) break;
        const key = name();
        if (Object.hasOwn(object, key)) throw Error("NBT 存在重复字段");
        object[key] = value(child, path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"), depth + 1, object);
      }
      return object;
    }
    const size = r.count(r.number(4, true));
    return Array.from({ length: size }, () => type === 11 ? r.number(4, true) : r.long(true));
  }
  const type = r.number(1); if (type !== 10) throw Error("NBT 根节点必须是 Compound");
  const rootName = name(), result = value(type, "", 0);
  return { value: result, name: rootName, size: r.offset, types, warnings, ...(capture ? { nodes, scripts } : {}) };
}
module.exports = { decodeMessagePack, parseNbtRecord, MAX_BYTES };
