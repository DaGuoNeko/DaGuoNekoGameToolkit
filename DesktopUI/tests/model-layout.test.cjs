const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultLayout, fitLayout } = require("../shared/model-layout.cjs");

test("panel layout reserves room for the viewport and clamps both sidebars on narrow windows", () => {
  const preferences = { left: 480, right: 480, split: 0.5 };
  const actual = fitLayout(preferences, 700, 500, "edit");
  assert.equal(actual.left + actual.right, 700 - 16 - 240);
  assert.ok(actual.left >= 180 && actual.right >= 180);
  assert.deepEqual(preferences, { left: 480, right: 480, split: 0.5 });
  assert.deepEqual(fitLayout(preferences, 1300, 500, "edit"), { left: 480, right: 480, top: 246, bottom: 246, leftMin: 180, leftMax: 480, rightMin: 180, rightMax: 480, topMin: 160, topMax: 332 });
});

test("vertical bounds keep the timeline visible and bad saved dimensions use defaults", () => {
  const animation = fitLayout({ split: 100 }, 1200, 600, "animate");
  assert.equal(animation.bottom, 200);
  const upper = fitLayout({ split: -10 }, 1200, 600, "edit");
  assert.equal(upper.top, 160);
  const invalid = fitLayout({ left: "1000px", right: NaN, split: Infinity }, 1200, 600, "edit");
  assert.equal(invalid.left, 280); assert.equal(invalid.right, 280);
  assert.equal(invalid.top, (600 - 8) * defaultLayout("edit").split);
});

test("small or initially unmeasured containers never produce negative or non-finite tracks", () => {
  for (const width of [0, 8, 50, 400, 900]) for (const height of [0, 5, 80, 250, 700]) {
    const result = fitLayout({ left: 900, right: -50, split: NaN }, width, height, "animate");
    for (const value of Object.values(result)) assert.ok(Number.isFinite(value) && value >= 0);
    assert.ok(result.left <= result.leftMax && result.right <= result.rightMax);
    assert.ok(result.left + result.right <= Math.max(0, width - 16));
    assert.ok(result.top + result.bottom <= Math.max(0, height - 8));
  }
});
