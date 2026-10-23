const { crc32, deflateRawSync } = require("node:zlib");
// Small standard ZIP fixture writer; override fields to exercise malformed input.
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name),
      data = Buffer.from(item.data || ""),
      method = item.method ?? 8,
      packed = method === 8 ? deflateRawSync(data) : data;
    const crc = item.crc ?? crc32(data),
      size = item.size ?? data.length,
      flags = item.flags ?? 0x800;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(flags, 6);
    l.writeUInt16LE(method, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(packed.length, 18);
    l.writeUInt32LE(size, 22);
    l.writeUInt16LE(name.length, 26);
    local.push(l, name, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(item.attributes ?? (0x81a4 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += l.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function levelData(name) {
  const key = Buffer.from("keepinventory"),
    length = Buffer.alloc(2);
  length.writeUInt16LE(key.length);
  const nameTag = [];
  if (name !== undefined) {
    const bytes = Buffer.from(name),
      size = Buffer.alloc(2);
    size.writeUInt16LE(bytes.length);
    nameTag.push(Buffer.from([8, 9, 0]), Buffer.from("LevelName"), size, bytes);
  }
  const body = Buffer.concat([
    Buffer.from([10, 0, 0, 1]),
    length,
    key,
    Buffer.from([0]),
    ...nameTag,
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
module.exports = { zip, levelData };
