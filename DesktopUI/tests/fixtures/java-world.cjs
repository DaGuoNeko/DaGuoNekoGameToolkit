const fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const i16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const str = text => { const b = Buffer.from(text); return Buffer.concat([i16(b.length), b]); };
const compound = fields => Buffer.concat([...fields, Buffer.from([0])]);
const tag = (type, name, data) => Buffer.concat([Buffer.from([type]), str(name), data]);
const int = (name, value) => tag(3, name, i32(value));
const string = (name, value) => tag(8, name, str(value));
const byte = (name, value) => tag(1, name, Buffer.from([value & 255]));
const list = (name, type, values) => tag(9, name, Buffer.concat([Buffer.from([type]), i32(values.length), ...values]));
function chunk(cx) {
  const indices = new Array(4096).fill(0);
  if (cx === -1) indices[4 * 256 + 15] = 1;
  else { indices[4 * 256 + 1] = 2; indices[4 * 256 + 2] = 3; indices[4 * 256 + 3] = 4; indices[4 * 256 + 4] = 5; }
  const longs = Buffer.alloc(256 * 8);
  for (let i = 0; i < 256; i++) {
    let packed = 0n;
    for (let n = 0; n < 16; n++) packed |= BigInt(indices[i * 16 + n]) << BigInt(n * 4);
    longs.writeBigInt64BE(BigInt.asIntN(64, packed), i * 8);
  }
  const palette = [compound([string("Name", "minecraft:air")]), compound([string("Name", "minecraft:stone")]), compound([
    string("Name", "minecraft:oak_stairs"), tag(10, "Properties", compound([string("facing", "north"), string("half", "top"), string("shape", "straight"), string("waterlogged", "false")]))
  ]), compound([string("Name", "minecraft:chest"), tag(10,"Properties",compound([string("facing","east"),string("type","single"),string("waterlogged","false")]))]), compound([string("Name", "minecraft:oak_stairs"),tag(10,"Properties",compound([string("facing","north"),string("half","bottom"),string("shape","straight"),string("waterlogged","true")]))]), compound([string("Name","minecraft:water"),tag(10,"Properties",compound([string("level","0")]))])];
  const section = compound([byte("Y", 6), tag(10, "block_states", compound([list("palette", 10, palette), tag(12, "data", Buffer.concat([i32(256), longs]))])), tag(10, "biomes", compound([list("palette", 8, [str("minecraft:plains")])]))]);
  const entities = cx === 0 ? [compound([string("id","minecraft:chest"),int("x",2),int("y",100),int("z",0),list("Items",10,[compound([byte("Slot",0),string("id","minecraft:diamond"),byte("Count",3)])])])] : [];
  return tag(10, "", compound([int("DataVersion", 3700), int("xPos", cx), int("zPos", 0), int("yPos", -4), string("Status", "minecraft:full"), list("sections", 10, [section]), list("block_entities", 10, entities)]));
}
async function javaWorld(root) {
  await fs.mkdir(path.join(root, "region"), { recursive: true });
  const data = compound([int("DataVersion", 3700), string("LevelName", "Terrain Java fixture"), int("GameType", 1), byte("allowCommands", 1), byte("initialized", 1), int("SpawnX", 0), int("SpawnY", 110), int("SpawnZ", 0), tag(10, "Version", compound([int("Id", 3700), string("Name", "1.20.4"), byte("Snapshot", 0)]))]);
  await fs.writeFile(path.join(root, "level.dat"), zlib.gzipSync(tag(10, "", compound([tag(10, "Data", data)]))));
  for (const cx of [-1, 0]) {
    const compressed = zlib.deflateSync(chunk(cx)), sectors = Math.ceil((compressed.length + 5) / 4096);
    const buffer = Buffer.alloc((2 + sectors) * 4096);
    const index = (cx < 0 ? 31 : 0) * 4;
    buffer.writeUInt32BE((2 << 8) | sectors, index);
    buffer.writeUInt32BE(compressed.length + 1, 8192); buffer[8196] = 2; compressed.copy(buffer, 8197);
    await fs.writeFile(path.join(root, "region", `r.${Math.floor(cx / 32)}.0.mca`), buffer);
  }
}
module.exports = { javaWorld };
