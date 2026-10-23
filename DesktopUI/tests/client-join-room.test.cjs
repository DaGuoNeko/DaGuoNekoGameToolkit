const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { readJoinRoom } = require("../electron/client-join-room.cjs");
function level(name) {
  const string = (s) => {
    const b = Buffer.from(s);
    const n = Buffer.alloc(2);
    n.writeUInt16LE(b.length);
    return Buffer.concat([n, b]);
  };
  const payload = Buffer.concat([
    Buffer.from([10, 0, 0]),
    ...(name === null
      ? []
      : [Buffer.from([8]), string("LevelName"), string(name)]),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(10);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
test("join reads authoritative LevelName without modifying save or trusting library/text aliases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-room-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-room-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const worlds = {
    read: async () => ({}),
    find: (_data, _project, id) => {
      assert.equal(id, "owned");
      return { id };
    },
    inspect: async () => ({ path: root, present: true, deleted: false }),
  };
  const file = path.join(root, "level.dat"),
    bytes = level("RPG10.3回来后");
  await fs.writeFile(file, bytes);
  await fs.writeFile(path.join(root, "levelname.txt"), "unrelated alias");
  assert.deepEqual(await readJoinRoom(worlds, "owned"), {
    name: "RPG10.3回来后",
    source: "level.dat/LevelName",
  });
  assert.deepEqual(await fs.readFile(file), bytes);
  for (const invalid of [null, "", "bad\nname"]) {
    await fs.writeFile(file, level(invalid));
    await assert.rejects(readJoinRoom(worlds, "owned"), /LevelName/);
  }
  await fs.writeFile(file, "corrupt");
  await assert.rejects(readJoinRoom(worlds, "owned"), /头部/);
  await assert.rejects(
    readJoinRoom(
      { ...worlds, inspect: async () => ({ path: root, present: false }) },
      "owned",
    ),
    /目录/,
  );
  await fs.unlink(file);
  await assert.rejects(readJoinRoom(worlds, "owned"), { code: "ENOENT" });
});
