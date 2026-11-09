const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const nbt = require("prismarine-nbt");
const { parseNbtRecord, decodeMessagePack } = require("../electron/domains/worlds/world-data-codec.cjs");
const { scanWorldData } = require("../electron/domains/worlds/world-data.cjs");
const { references, compareWorldData, exportWorldData } = require("../shared/world-data-model.cjs");
const { worldDataFixture, worldScript, pack } = require("./fixtures/world-data.cjs");
const { zipMap, javaMap } = require("./fixtures/map-world.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

test("NBT preserves 64-bit values, types, offsets and extended script payloads", () => {
  const first = nbt.writeUncompressed(nbt.comp({ identity: nbt.long([2147483647, -1]), value: nbt.int(-12) }), "little");
  const second = worldScript({ test: { name: "中文", count: 4 } });
  const parsed = parseNbtRecord(Buffer.concat([first, second]));
  assert.equal(parsed.value.identity, "9223372036854775807");
  assert.equal(parsed.types["/identity"], "long"); assert.equal(parsed.size, first.length);
  const script = parseNbtRecord(second, { worldScript: true });
  assert.equal(script.value.scriptData.test.name, "中文"); assert.equal(script.size, second.length);
  assert.equal(script.types["/scriptData/test/name"], "messagepack.binary");
  assert.deepEqual(decodeMessagePack(Buffer.from([0xc4, 2, 255, 254]), { binaryText: true }), { $binary: "//4=" });
  const payload = pack({ NPC_IDENTITY: { inte_data: { stacmd: "entry" } } });
  const length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  const npc = Buffer.concat([Buffer.from([10, 0, 0, 1, 14, 0]), Buffer.from("saveLongString"), Buffer.from([1, 8, 10, 0]), Buffer.from("scriptData"), length, payload, Buffer.from([0])]);
  assert.equal(parseNbtRecord(npc).value.scriptData.NPC_IDENTITY.inte_data.stacmd, "entry");
});
test("MessagePack rejects truncation and trailing data and preserves unknown extension", () => {
  assert.deepEqual(decodeMessagePack(Buffer.from([0x93, 0xc3, 0xc0, 0xff])), [true, null, -1]);
  assert.equal(decodeMessagePack(Buffer.from("cf001fffffffffffff", "hex")).$integer64, "9007199254740991");
  assert.deepEqual(decodeMessagePack(Buffer.from([0xd4, 7, 99])), { $extension: 7, base64: "Yw==" });
  assert.throws(() => decodeMessagePack(Buffer.from([0xda, 0, 8, 1])), /长度/);
  assert.throws(() => decodeMessagePack(Buffer.from([0xc0, 0xc0])), /尾部/);
  assert.throws(() => decodeMessagePack(Buffer.concat([Buffer.alloc(70, 0x91), Buffer.from([0xc0])])), /嵌套/);
  assert.throws(() => parseNbtRecord(Buffer.from([10, 0, 0, 9, 0, 0, 1, 255, 255, 255, 127])), /长度/);
});
test("world scan is read-only, exposes business records, evidence and field comparisons", async () => {
  const root = artifactPath("world-data"), a = path.join(root, "a"), b = path.join(root, "b");
  await worldDataFixture(a); await worldDataFixture(b, { changed: true });
  async function digest(dir) { const entries = []; for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); entries.push([e.name, e.isDirectory() ? await digest(file) : crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")]); } return entries; }
  const before = await digest(a);
  const left = await scanWorldData({ source: a, dataRoot: path.join(root, "work-a") });
  assert.deepEqual(await digest(a), before);
  assert.equal(left.complete, true); assert.equal(left.objects.filter(o => o.kind === "command").length, 1);
  assert.equal(left.objects.find(o => o.kind === "npc").value.UniqueID, "9223372036854775807");
  assert(left.objects.some(o => o.identity === "quest:quest1")); assert(left.objects.some(o => o.identity === "dialogue:welcome"));
  assert(left.relations.some(r => r.target === "library:entry" && r.status === "resolved"));
  assert(left.relations.some(r => r.target === "library:missing" && r.status === "not-found"));
  assert(left.objects.some(row => row.kind === "item" && row.identity === "item:fixture:apple"));
  assert(left.relations.some(row => row.target === "item:fixture:apple" && row.status === "resolved"));
  const right = await scanWorldData({ source: b, dataRoot: path.join(root, "work-b") });
  const comparison = compareWorldData(left, right);
  assert(comparison.changes.some(row => row.identity === "quest:quest1" && row.fields.some(f => f.path === "/count" && f.before === 1 && f.after === 2)));
  assert(comparison.changes.some(row => row.identity.startsWith("container:") && row.fields.length));
  assert(comparison.changes.some(row => row.identity.startsWith("entity:") && row.status === "changed" && row.fields.some(field => field.path === "/Pos/0")));
  assert.equal(compareWorldData(left, { ...left, objects: [...left.objects].reverse() }).changes.length, 0);
  const csv = exportWorldData({ objects: [{ kind: "quest", name: "=BAD()", evidence: {}, value: {} }] }, "csv"); assert(csv.includes("'=BAD()"));
  const zip = path.join(root, "source.mcworld"); await zipMap(a, zip);
  const zipped = await scanWorldData({ source: zip, dataRoot: path.join(root, "work-zip") });
  assert.equal(zipped.objects.length, left.objects.length);
});
test("partial records do not turn unreadable data into missing-object proof", async () => {
  const root = artifactPath("world-data-broken"); await worldDataFixture(root, { broken: true });
  const result = await scanWorldData({ source: root, dataRoot: artifactPath("work-broken") });
  assert.equal(result.complete, false); assert.equal(result.statistics.failed, 1); assert(result.objects.length > 0);
  assert.equal(compareWorldData(result, { ...result, objects: [] }).partial, true);
  const duplicates = references([{ id: "a", identity: "library:one", kind: "library" }, { id: "b", identity: "library:one", kind: "library" }, { id: "c", kind: "command", value: { Command: "cmd(one)" } }]);
  assert.equal(duplicates[0].status, "ambiguous"); assert.equal(duplicates[0].to, null);
});
test("Java world metadata uses big endian without requiring a game", async () => {
  const root = artifactPath("world-data-java"); await javaMap(root);
  const result = await scanWorldData({ source: root, dataRoot: artifactPath("work-java") });
  assert.equal(result.format, "java"); assert.equal(result.complete, true); assert(result.objects.some(row => row.evidence.key === "level.dat"));
});
