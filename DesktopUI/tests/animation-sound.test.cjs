const test = require("node:test");
const assert = require("node:assert/strict");
const { setSoundKey, clearSoundKey, soundEntries } = require("../src/features/skins/npc-clip.cjs");

test("sound keys replace the same time and keep unrelated animation fields", () => {
  const source = { animation_length: 1, loop: true, bones: { body: { rotation: { "0.00": [0, 0, 0] } } } };
  const saved = setSoundKey(source, 0.5, "mob.cow.say");
  assert.equal(source.sound_effects, undefined);
  assert.equal(saved.bones, source.bones);
  assert.deepEqual(soundEntries(saved), [{ time: 0.5, effect: "mob.cow.say" }]);
  const replaced = setSoundKey(saved, 0.52, "random.click");
  assert.deepEqual(soundEntries(replaced), [{ time: 0.5, effect: "random.click" }]);
  assert.equal(clearSoundKey(replaced, 0.5).sound_effects, undefined);
  assert.throws(() => setSoundKey(source, 0, "有空格"), /声音名称/);
  assert.throws(() => clearSoundKey(source, 0), /没有声音/);
});

test("multiple sounds edit one entry without losing sibling fields or original time spelling", () => {
  const source = { loop: false, bones: { body: {} }, sound_effects: { "0.500": [{ effect: "first", note: { keep: 42 } }, { effect: "second" }], "1": { effect: "last" } } };
  const before = structuredClone(source);
  const updated = setSoundKey(source, 0.5, "changed", 0);
  assert.deepEqual(updated.sound_effects["0.500"], [{ effect: "changed", note: { keep: 42 } }, { effect: "second" }]);
  const added = setSoundKey(updated, 0.5, "third", -1);
  assert.equal(added.sound_effects["0.500"].length, 3);
  assert.deepEqual(clearSoundKey(added, 0.5, 1).sound_effects["0.500"], [added.sound_effects["0.500"][0], { effect: "third" }]);
  assert.deepEqual(source, before);
  assert.throws(() => setSoundKey(source, 0.5, "x", 4), /选择已变化/);
});

test("pitch and volume replace only the requested level and reject out of range before mutation", () => {
  const source = { sound_effects: { "0.00": { effect: "random.click", pitch: "math.random(0,1)", note: "keep" } } };
  const saved = setSoundKey(source, 0, "random.click", 0, { pitch: "1.5", volume: "0" });
  assert.deepEqual(saved.sound_effects["0.00"], { effect: "random.click", pitch: 1.5, volume: 0, note: "keep" });
  const cleared = setSoundKey(saved, 0, "random.click", 0, { pitch: "", volume: "" });
  assert.deepEqual(cleared.sound_effects["0.00"], { effect: "random.click", note: "keep" });
  assert.throws(() => setSoundKey(source, 0, "random.click", 0, { pitch: "300" }), /音高/);
  assert.equal(source.sound_effects["0.00"].pitch, "math.random(0,1)");
});

test("invalid times, malformed tracks, aliases and the total sound limit fail before mutation", () => {
  const source = { sound_effects: { "0": { effect: "a" } } };
  for (const time of [-0.001, 10000.001, NaN, Infinity, "", null]) assert.throws(() => setSoundKey(source, time, "a"), /时间/);
  for (const effects of [[], false, { bad: { effect: "a" } }, { "0": [] }, { "0": null }, { "0": { effect: "a" }, "0.0": { effect: "b" } }]) {
    assert.throws(() => setSoundKey({ sound_effects: effects }, 1, "a"));
  }
  const full = { sound_effects: { "0": Array.from({ length: 1000 }, () => ({ effect: "a" })) } };
  assert.equal(setSoundKey(full, 0, "b", 999).sound_effects["0"].length, 1000);
  assert.throws(() => setSoundKey(full, 0, "b", -1), /1000/);
  assert.throws(() => setSoundKey(full, 1, "b"), /1000/);
  assert.equal(full.sound_effects["0"][999].effect, "a");
});
