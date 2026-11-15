const test = require("node:test");
const assert = require("node:assert/strict");
const { setInstructionKey, clearInstructionKey, instructionFrames } = require("../shared/animation-timeline.cjs");

test("instruction keys replace one time and keep the original spelling", () => {
  const source = { animation_length: 1, loop: true, bones: { body: {} }, timeline: { "0.500": " /say hi " } };
  const saved = setInstructionKey(source, 0.52, "/effect @s speed 1");
  assert.equal(source.timeline["0.500"], " /say hi ");
  assert.equal(saved.timeline["0.500"], "/effect @s speed 1");
  assert.equal(saved.bones, source.bones);
  assert.equal(clearInstructionKey(saved, 0.5).timeline, undefined);
  assert.throws(() => setInstructionKey(source, 0, "   "), /指令应为/);
  assert.throws(() => clearInstructionKey({ timeline: {} }, 0), /没有指令/);
});

test("instruction track rejects arrays, objects and the total limit before mutation", () => {
  const source = { timeline: { "0.00": ["/say a", "/say b"] } };
  assert.throws(() => setInstructionKey(source, 0, "/say c"), /多条指令/);
  assert.deepEqual(source.timeline["0.00"], ["/say a", "/say b"]);
  assert.throws(() => instructionFrames({ "0.00": { script: "/say a" } }), /指令数据无效/);
  for (const time of [-0.001, 10000.001, NaN]) assert.throws(() => setInstructionKey({ timeline: {} }, time, "/say a"), /时间/);
  const full = { timeline: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index, "/say a"])) };
  assert.throws(() => setInstructionKey(full, 1000, "/say b"), /1000/);
  assert.equal(full.timeline["0"], "/say a");
});
