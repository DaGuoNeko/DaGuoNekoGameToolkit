const test = require("node:test");
const assert = require("node:assert/strict");
const { groupMods } = require("../shared/mod-groups.cjs");

test("behavior and resource halves with the same stem are one mod", () => {
  const mods = groupMods([
    { kind: "behavior", name: "Boss", packName: "aexnpcbosshealthB", packId: "b1" },
    { kind: "resource", name: "Boss", packName: "aexnpcbosshealthR", packId: "r1" },
    { kind: "behavior", name: "单独", packName: "onlyB", packId: "b2" },
  ]);
  assert.equal(mods.length, 2);
  assert.deepEqual(mods[0].packIds, ["b1", "r1"]);
  assert.equal(mods[0].name, "Boss");
  assert.deepEqual(mods[1].packIds, ["b2"]);
});

test("same display name pairs one behavior pack with one resource pack", () => {
  const mods = groupMods([
    { kind: "behavior", name: "自定义NPC", packName: "npc_logic", packId: "b" },
    { kind: "resource", name: "自定义NPC", packName: "npc_art", packId: "r" },
  ]);
  assert.deepEqual(mods[0].packIds, ["b", "r"]);
});
