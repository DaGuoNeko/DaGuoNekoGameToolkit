const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateMolang } = require("../shared/molang-preview.cjs");

test("Molang uses animation seconds, degree trigonometry, aliases and precedence", () => {
  assert.ok(Math.abs(evaluateMolang("math.sin(query.anim_time * 360) * 30", 0.25) - 30) < 1e-8);
  assert.ok(Math.abs(evaluateMolang("return MATH.COS(Q.ANIM_TIME * 360);", 0.5) + 1) < 1e-8);
  assert.equal(evaluateMolang("2 + 3 * -4 / 2", 0), -4);
  assert.equal(evaluateMolang("math.clamp(math.pow(3, 2), 1, 5)", 0), 5);
  assert.equal(evaluateMolang("math.lerp(10, 20, .5)", 0), 15);
  assert.equal(evaluateMolang("math.round(-1.5)", 0), -2);
  assert.equal(evaluateMolang("1e-2 + 0.5", 0), 0.51);
  assert.equal(evaluateMolang("q.anim_time > .5 && q.anim_time <= 1 ? 2 : 3", 0.75), 2);
  assert.equal(evaluateMolang("q.anim_time < .5 ? 1 : q.anim_time < 1 ? 2 : 3", 1), 3);
  assert.equal(evaluateMolang("0 ? 1 / 0 : 7", 0), 7);
  assert.equal(evaluateMolang("1 || 1 / 0", 0), 1);
  assert.equal(evaluateMolang("0 && 1 / 0", 0), 0);
});

test("unavailable context, invalid math and executable input fail closed", () => {
  for (const source of ["query.ground_speed", "variable.speed", "math.random(0,1)", "math.sin()", "math.sin(1,2)", "1/0", "math.sqrt(-1)", "math.pow(10,999)", "", "(1+2", "return 1;return 2;", "globalThis.process.exit()", "this.constructor.constructor('return process')()", "q.anim_time = 4", "loop(1000,1)", "({})", "math.__proto__", "1[0]"]) {
    assert.throws(() => evaluateMolang(source, 0), undefined, source);
  }
  assert.throws(() => evaluateMolang(" ".repeat(2049), 0), /2048/);
  assert.throws(() => evaluateMolang("(".repeat(40) + "1" + ")".repeat(40), 0), /嵌套/);
  assert.throws(() => evaluateMolang("1+".repeat(150) + "1", 0), /复杂/);
  assert.throws(() => evaluateMolang("1e999", 0), /无效/);
});
