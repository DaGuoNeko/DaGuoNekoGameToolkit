const fs = require("node:fs/promises");
const path = require("node:path");
const nbt = require("prismarine-nbt");
const { Database } = require("@jsprismarine/leveldb");
const { bedrockMap } = require("./map-world.cjs");
// 夹具编码器只生成固定 map/array/字符串/小整数，不依赖待测解码器。
function pack(value) {
  if (typeof value === "number") return Buffer.from([value]);
  if (typeof value === "string") { const body = Buffer.from(value); return Buffer.concat([Buffer.from([0xc4, body.length]), body]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([0x90 + value.length]), ...value.map(pack)]);
  const entries = Object.entries(value);
  return Buffer.concat([Buffer.from([0x80 + entries.length]), ...entries.flatMap(([key, item]) => [pack(key), pack(item)])]);
}
function worldScript(data) {
  const payload = pack(data), length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from([10, 0, 0, 8, 10, 0]), Buffer.from("scriptData"), length, payload, Buffer.from([0])]);
}
async function worldDataFixture(root, { changed = false, broken = false } = {}) {
  await bedrockMap(root);
  const packRoot = path.join(root, "behavior_packs", "fixture");
  await fs.mkdir(path.join(packRoot, "items"), { recursive: true });
  await fs.writeFile(path.join(packRoot, "manifest.json"), JSON.stringify({ format_version: 2, header: { name: "Fixture items", uuid: "11111111-1111-4111-8111-111111111111", version: [1, 0, 0] }, modules: [{ type: "data", uuid: "22222222-2222-4222-8222-222222222222", version: [1, 0, 0] }] }), "utf8");
  await fs.writeFile(path.join(packRoot, "items", "apple.json"), JSON.stringify({ format_version: "1.20.0", "minecraft:item": { description: { identifier: "fixture:apple" }, components: { "minecraft:max_stack_size": 64 } } }), "utf8");
  await fs.writeFile(path.join(root, "world_behavior_packs.json"), JSON.stringify([{ pack_id: "11111111-1111-4111-8111-111111111111", version: [1, 0, 0] }]), "utf8");
  await fs.writeFile(path.join(root, "world_resource_packs.json"), "[]", "utf8");
  const db = await Database.open(path.join(root, "db"));
  const key = Buffer.alloc(9); key[8] = 0x31;
  try {
    db.put(key, Buffer.concat([
      nbt.writeUncompressed(nbt.comp({ id: nbt.string("CommandBlock"), x: nbt.int(5), y: nbt.int(6), z: nbt.int(11), Command: nbt.string('/miao:cmd 指令库 "entry" 0 @s') }), "little"),
      nbt.writeUncompressed(nbt.comp({ id: nbt.string("Chest"), x: nbt.int(8), y: nbt.int(6), z: nbt.int(11), Items: nbt.list(nbt.comp([{ Slot: nbt.byte(0), Name: nbt.string("fixture:apple"), Count: nbt.byte(changed ? 3 : 2) }])) }), "little"),
    ]));
    db.put(Buffer.from("scriptData"), worldScript({
      DAGUOMIAO_API_MOD_data_v1: { command_library: { schema_version: 2, data: { entry: { name: "入口", commands: ["cmd(missing)"] } } } },
      CUSTOMNPC_DIALOGUE_LIBRARY_V3: { schema_version: 3, items: { group: { items: { welcome: { name: "欢迎" } } } } },
      Quest_Engine_Data: { quest_item: { allitem: { quest1: { _type_: "quest", name: "采集任务", count: changed ? 2 : 1 } } } },
    }));
    db.put(Buffer.from("actorprefixfixture"), nbt.writeUncompressed(nbt.comp({ identifier: nbt.string("fixture:customnpc"), UniqueID: nbt.long([2147483647, -1]), LastDimensionId: nbt.int(0), Pos: nbt.list(nbt.float([changed ? 7 : 5, 6, 11])), ChestItems: nbt.list(nbt.comp([])) }), "little"));
    if (broken) db.put(Buffer.from("structuretemplate_broken"), Buffer.from([10, 0, 0, 8, 5]));
  } finally { await db.close(); }
}
module.exports = { pack, worldScript, worldDataFixture };
