const test = require("node:test");
const assert = require("node:assert/strict");
const { setParticleKey, clearParticleKey, particleFrames } = require("../shared/animation-particles.cjs");

test("particle keys replace one time and keep extra fields", () => {
  const source = { animation_length: 1, loop: true, bones: { body: {} }, particle_effects: { "0.500": { effect: "spark", locator: "old", script: "keep" } } };
  const saved = setParticleKey(source, 0.52, "minecraft:basic_smoke_particle", "lead");
  assert.equal(source.particle_effects["0.500"].effect, "spark");
  assert.deepEqual(saved.particle_effects["0.500"], { effect: "minecraft:basic_smoke_particle", locator: "lead", script: "keep" });
  assert.equal(saved.bones, source.bones);
  const cleared = setParticleKey(saved, 0.5, "spark", "");
  assert.equal(cleared.particle_effects["0.500"].locator, undefined);
  assert.equal(cleared.particle_effects["0.500"].script, "keep");
  assert.equal(clearParticleKey(cleared, 0.5).particle_effects, undefined);
  assert.throws(() => setParticleKey(source, 0, "bad name", ""), /粒子名称/);
  assert.throws(() => setParticleKey(source, 0, "spark", "定位器"), /定位器名称/);
  assert.throws(() => clearParticleKey({ particle_effects: {} }, 0), /没有粒子/);
});

test("particle script and bind replace only those fields", () => {
  const source = { particle_effects: { "0.00": { effect: "spark", note: "keep", pre_effect_script: "old" } } };
  const saved = setParticleKey(source, 0, "spark", "lead", { script: " v.x = 1; ", bind: true });
  assert.deepEqual(saved.particle_effects["0.00"], { effect: "spark", locator: "lead", note: "keep", pre_effect_script: "v.x = 1;", bind_to_actor: true });
  const cleared = setParticleKey(saved, 0, "spark", "lead", { script: "", bind: false });
  assert.equal(cleared.particle_effects["0.00"].pre_effect_script, undefined);
  assert.equal(cleared.particle_effects["0.00"].bind_to_actor, undefined);
  assert.equal(cleared.particle_effects["0.00"].note, "keep");
  assert.throws(() => setParticleKey(source, 0, "spark", "", { script: "a".repeat(513), bind: false }), /粒子脚本/);
  assert.equal(source.particle_effects["0.00"].pre_effect_script, "old");
  assert.throws(() => setParticleKey(source, 0, "spark", "", { script: "", bind: "yes" }), /绑定到实体/);
});

test("particle track rejects arrays, bad times and too many events before mutation", () => {
  const source = { particle_effects: { "0.00": [{ effect: "a" }, { effect: "b" }] } };
  assert.throws(() => setParticleKey(source, 0, "spark"), /多条粒子/);
  assert.deepEqual(source.particle_effects["0.00"].map(item => item.effect), ["a", "b"]);
  for (const time of [-0.001, 10000.001, NaN]) assert.throws(() => setParticleKey({ particle_effects: {} }, time, "a"), /时间/);
  const full = { particle_effects: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index, { effect: "a" }])) };
  assert.throws(() => setParticleKey(full, 1000, "b"), /1000/);
  assert.equal(particleFrames(full.particle_effects).length, 1000);
  assert.equal(full.particle_effects["0"].effect, "a");
});
