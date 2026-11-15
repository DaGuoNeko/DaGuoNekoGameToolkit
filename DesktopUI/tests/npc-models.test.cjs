const { test } = require("node:test");
const assert = require("node:assert/strict");
const models = require("../shared/skins/npc-models.json");
const textures = require("../shared/skins/npc-textures.json");
const animations = require("../src/features/skins/npc-animations.json");
const slots = require("../src/features/skins/npc-slots.json");
const slotTextures = require("../src/features/skins/npc-slot-textures.json");
const { sampleTrack, pickDefault } = require("../src/features/skins/npc-clip.cjs");

test("custom npc geometries used by skin targets are bundled", () => {
  const wolf = models["customnpc:wolf_dlcnpc"];
  assert.equal(wolf.tw, 64);
  assert.equal(wolf.th, 32);
  assert.ok(wolf.bones.some((bone) => bone.cubes?.some((cube) => cube.origin && cube.size && cube.uv)));
  assert.ok(models["customnpc:creeper_dlcnpc"]);
  assert.equal(models["customnpc:steve_npc"], undefined);
  assert.equal(textures["customnpc:polar_bear_dlcnpc"].startsWith("data:image/png;base64,"), true);
  assert.equal(textures["customnpc:evocation_illager_dlcnpc"].startsWith("data:image/png;base64,"), true);
  assert.equal(textures["customnpc:blaze_dlcnpc"].startsWith("data:image/png;base64,"), true);
  assert.equal(textures["customnpc:horse_dlcnpc"].startsWith("data:image/png;base64,"), true);
  assert.equal(textures["customnpc:villager_dlcnpc"].startsWith("data:image/png;base64,"), true);
  assert.ok(models["customnpc:baoxiang_dlcnpc"].bones.some((bone) => bone.cubes?.some((cube) => cube.rotation)));
  assert.ok(models["customnpc:kingcat_dlcnpc"]);
});

test("npc preview clips come from the resource pack and idle wins", () => {
  const angel = animations["customnpc:angel_dlcnpc"];
  assert.equal(angel.default, "idle");
  assert.ok(angel.clips.some((clip) => clip.name === "walk" && clip.bones.right_arm.r.length > 1));
  const box = animations["customnpc:baoxiang_dlcnpc"];
  assert.deepEqual(box.clips.map((clip) => clip.name).sort(), ["full", "open", "open_jumping", "shake"]);
  assert.equal(box.default, pickDefault(box.clips.map((clip) => clip.name)));
  const idle = angel.clips.find((clip) => clip.name === "idle");
  const mid = sampleTrack(idle.bones.right_wing.r, idle.length / 2);
  assert.equal(mid.length, 3);
  assert.ok(mid.some((value) => value !== 0));
});

test("multi-texture models expose only their real slots", () => {
  assert.deepEqual(slots["customnpc:horse_dlcnpc"], ["base_brown", "base_white", "base_creamy", "base_chestnut", "base_black", "base_gray", "base_darkbrown"]);
  assert.ok(slotTextures["customnpc:baoxiang_dlcnpc"].baox1.startsWith("data:image/png;base64,"));
  assert.equal(slotTextures["customnpc:blaze_dlcnpc"], undefined);
});
