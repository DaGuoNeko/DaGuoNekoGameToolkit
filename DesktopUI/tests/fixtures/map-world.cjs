const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const nbt = require("prismarine-nbt");
const { Database } = require("@jsprismarine/leveldb");
const { javaWorld } = require("./java-world.cjs");
const { levelData, zip } = require("./zip.cjs");

const names = ["air", "grass_block", "water", "sand", "stone", "oak_planks", "snow_block", "lava",
  ...Array.from({ length: 12 }, (_, i) => `fixture:block_${i}`)].map(n => "minecraft:" + n);
// 非对称地标：X=5,Z=11 的熔岩比周围地表更高，用于识别轴序和高度错误。
function indexAt(x, y, z) {
  if (x === 5 && z === 11 && y === 13) return 7;
  if (y === 3) return 1 + Math.floor((x + 16) / 8) % 6;
  return 0;
}
function anvil(cx, cz) {
  const words = new Array(Math.ceil(4096 / 12)).fill(0n);
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const i = y * 256 + z * 16 + x;
    words[Math.floor(i / 12)] |= BigInt(indexAt(cx * 16 + x, y, cz * 16 + z)) << BigInt(i % 12 * 5);
  }
  const section = {
    Y: nbt.byte(0),
    block_states: nbt.comp({
      palette: nbt.list(nbt.comp(names.map(name => ({ Name: nbt.string(name) })))),
      data: nbt.longArray(words.map(w => [Number(BigInt.asIntN(32, w >> 32n)), Number(BigInt.asIntN(32, w))])),
    }),
  };
  return nbt.writeUncompressed(nbt.comp({ DataVersion: nbt.int(3955), xPos: nbt.int(cx), zPos: nbt.int(cz), sections: nbt.list(nbt.comp([section])) }));
}
async function javaMap(root, extraCenters = []) {
  await javaWorld(root);
  const regions = new Map();
  for(const center of [0,...extraCenters]) for (let cx = center-1; cx <= center+1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const name = `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`;
    const region = regions.get(name) || { header: Buffer.alloc(8192), chunks: [], sectors: 2 };
    const bytes = zlib.deflateSync(anvil(cx, cz)), size = Math.ceil((bytes.length + 5) / 4096);
    const chunk = Buffer.alloc(size * 4096);
    chunk.writeUInt32BE(bytes.length + 1); chunk[4] = 2; bytes.copy(chunk, 5);
    region.header.writeUInt32BE(region.sectors * 256 + size, (((cx % 32 + 32) % 32) + ((cz % 32 + 32) % 32) * 32) * 4);
    region.chunks.push(chunk); region.sectors += size; regions.set(name, region);
  }
  for (const [name, r] of regions) await fs.writeFile(path.join(root, "region", name), Buffer.concat([r.header, ...r.chunks]));
}
function subchunk(cx, cz, y, version = 9, single = false) {
  const header = Buffer.from(version === 9 ? [9, 1, y & 255] : [8, 1]);
  const palette = names.map(name => nbt.writeUncompressed(nbt.comp({ name: nbt.string(name), states: nbt.comp({}), version: nbt.int(18168865) }), "little"));
  if (single) return Buffer.concat([header, Buffer.from([0]), palette[4]]);
  const words = Buffer.alloc(Math.ceil(4096 / 6) * 4), count = Buffer.alloc(4);
  count.writeInt32LE(names.length);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let ly = 0; ly < 16; ly++) {
    const i = x * 256 + z * 16 + ly, offset = Math.floor(i / 6) * 4;
    const value = indexAt(cx * 16 + x, ly, cz * 16 + z);
    words.writeUInt32LE((words.readUInt32LE(offset) | value << (i % 6 * 5)) >>> 0, offset);
  }
  return Buffer.concat([header, Buffer.from([10]), words, count, ...palette]);
}
async function bedrockMap(root) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "level.dat"), levelData("Preview fixture"));
  const db = await Database.open(path.join(root, "db"));
  const put = (x, z, y, dimension, version, single) => {
    const key = Buffer.alloc(dimension ? 14 : 10);
    key.writeInt32LE(x); key.writeInt32LE(z, 4);
    if (dimension) key.writeInt32LE(dimension, 8);
    key[key.length - 2] = 0x2f; key.writeInt8(y, key.length - 1);
    db.put(key, subchunk(x, z, y, version, single));
  };
  try {
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      put(x, z, 0, 0, x === -1 ? 8 : 9, false);
      put(x, z, -1, 0, 9, true);
    }
    put(0, 0, 0, 1, 9, true);
    put(0, 0, 0, 3, 9, true);
  } finally { await db.close(); }
}
async function zipMap(root, file) {
  const entries = [];
  async function visit(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), prefix + entry.name + "/");
      else entries.push({ name: prefix + entry.name, data: await fs.readFile(path.join(dir, entry.name)) });
    }
  }
  await visit(root, "world/"); await fs.writeFile(file, zip(entries));
}
module.exports = { javaMap, bedrockMap, zipMap, indexAt, names };
