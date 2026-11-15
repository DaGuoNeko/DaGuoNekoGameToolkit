const test = require("node:test"), assert = require("node:assert/strict");
const { defaultMolangContext, simulationResult, validateMolangContext } = require("../shared/molang-context.cjs");
const { evaluateMolang } = require("../shared/molang-preview.cjs");
const { advanceControllerSession } = require("../shared/animation-controller-runtime.cjs");
const { controllerClip, controllerPose } = require("../src/features/mods/model-controller-blend.cjs");
const { sampleTrack, trackOf } = require("../src/features/skins/npc-clip.cjs");

test("simulation drafts keep their raw values while enabled snapshots contain fresh validated numbers", () => {
  const values = { ...defaultMolangContext(), "query.is_moving": 1, "query.ground_speed": "3.5", "query.vertical_speed": "-2" };
  const before = structuredClone(values), result = simulationResult(true, values);
  assert.equal(result.error, ""); assert.equal(result.context["query.ground_speed"], 3.5); assert.equal(result.context["query.vertical_speed"], -2);
  assert.deepEqual(values, before);
  values["query.ground_speed"] = "4";
  assert.equal(result.context["query.ground_speed"], 3.5); assert.equal(simulationResult(true, values).context["query.ground_speed"], 4);
  assert.deepEqual(simulationResult(false, values), { context: undefined, error: "" });
  assert.equal(values["query.ground_speed"], "4");
});

test("invalid simulation drafts never produce a partial context or silently become zero", () => {
  for (const [key, value] of [["ground_speed", ""], ["ground_speed", " "], ["ground_speed", "101"], ["ground_speed", "-1"], ["ground_speed", "NaN"], ["vertical_speed", "-101"], ["is_moving", 2]]) {
    const values = { ...defaultMolangContext(), ["query." + key]: value }, before = structuredClone(values);
    const result = simulationResult(true, values);
    assert.equal(result.context, undefined); assert.ok(result.error);
    assert.deepEqual(simulationResult(false, values), { context: undefined, error: "" }); assert.deepEqual(values, before);
  }
});

test("cached expressions read fresh explicit query values and aliases without leaking between contexts", () => {
  const expression = "q.is_moving && query.is_on_ground ? query.ground_speed : -q.vertical_speed";
  assert.throws(() => evaluateMolang(expression, 0), /未提供/);
  const a = defaultMolangContext(), b = { ...a, "query.is_moving": 1, "query.ground_speed": 3 };
  assert.equal(evaluateMolang(expression, 0, a), -0);
  assert.equal(evaluateMolang(expression, 0, b), 3);
  assert.equal(evaluateMolang(expression, 0, { ...a, "query.vertical_speed": -4 }), 4);
  assert.equal(evaluateMolang("Q.IS_SPRINTING + query.is_sneaking + query.is_in_water", 0, a), 0);
  assert.throws(() => evaluateMolang(expression, 0), /未提供/);
  assert.equal(evaluateMolang("1 || q.ground_speed", 0), 1);
  assert.equal(evaluateMolang("q.anim_time", 2, a), 2);
});
test("context accepts bounded numeric own fields only and never evaluates getters or object paths", () => {
  const getter = {}; Object.defineProperty(getter, "query.is_moving", { get() { throw Error("must not run"); }, enumerable: true });
  for (const context of [null, [], Object.create({ "query.is_moving": 1 }), getter,
    { "query.is_moving": true }, { "query.ground_speed": -1 }, { "query.vertical_speed": 101 }, { "query.is_on_ground": 2 }, { "query.ground_speed": NaN },
    { "query.health": 20 }, { "query.anim_time": 1 }, JSON.parse('{"__proto__":1}'), { [Symbol("query")]: 1 }]) assert.throws(() => validateMolangContext(context), /模拟/);
  for (const expr of ["q.health", "variable.speed", "q.is_moving()", "query.constructor", "q.__proto__", "q.is_moving = 1"]) assert.throws(() => evaluateMolang(expr, 0, defaultMolangContext()));
  const input = { "query.ground_speed": 2 }, checked = validateMolangContext(input);
  input["query.ground_speed"] = 4; assert.equal(checked["query.ground_speed"], 2);
  assert.throws(() => evaluateMolang("q.vertical_speed", 0, { "query.ground_speed": 0 }), /未提供/);
});
test("the same context drives state transitions, weights and expression bone tracks", () => {
  const id = "controller.animation.context", controller = { states: {
    idle: { animations: [], transitions: [{ walk: "q.is_moving && q.is_on_ground" }] },
    walk: { animations: [{ "animation.walk": "q.is_sprinting ? 1 : 0.5" }], transitions: [{ air: "!q.is_on_ground" }] },
    air: { animations: ["animation.air"] },
  } };
  const clips = {
    "animation.walk": controllerClip({ loop: true, animation_length: 1, bones: { body: { rotation: [0, "q.ground_speed * 20", 0], position: [0, "q.vertical_speed", 0] } } }),
    "animation.air": controllerClip({ bones: { body: { position: [0, "q.vertical_speed", 0] } } }),
  };
  const base = { state: "idle", time: 0, clips }, ctx = defaultMolangContext(), before = structuredClone(base);
  assert.equal(advanceControllerSession({ [id]: controller }, id, base, 1, ctx).state, "idle");
  const moving = { ...ctx, "query.is_moving": 1, "query.ground_speed": 3, "query.vertical_speed": 4 };
  const walk = advanceControllerSession({ [id]: controller }, id, base, 1, moving);
  assert.equal(walk.state, "walk");
  let pose = controllerPose(controller, walk.state, clips, walk.time, walk.transition, moving);
  assert.deepEqual(pose.clip.bones.body.r, [[0, 0, 30, 0]]);
  assert.deepEqual(pose.clip.bones.body.p, [[0, 0, 2, 0]]);
  pose = controllerPose(controller, "walk", clips, 2, null, { ...moving, "query.is_sprinting": 1 });
  assert.deepEqual(pose.clip.bones.body.r, [[0, 0, 60, 0]]);
  const airborne = { ...moving, "query.is_on_ground": 0 };
  assert.equal(advanceControllerSession({ [id]: controller }, id, walk, 0.1, airborne).state, "air");
  assert.deepEqual(base, before);
  assert.throws(() => controllerPose(controller, "walk", clips, 0), /未提供/);
  controller.states.idle.animations = ["animation.air"];
  controller.states.idle.blend_transition = { "0": 1, "1": 0.8, "2": 0 };
  controller.states.idle.blend_via_shortest_path = true;
  const transition = { state: "idle", time: 5, duration: 2 };
  const half = controllerPose(controller, "walk", clips, 1, transition, moving);
  // 同一模拟垂直速度作用于正在淡出的空中动画和新状态的半权重动画。
  assert.ok(Math.abs(half.clip.bones.body.p[0][2] - 3.6) < 1e-10);
  assert.deepEqual(moving, { ...ctx, "query.is_moving": 1, "query.ground_speed": 3, "query.vertical_speed": 4 });
});
test("pre/post and Catmull-Rom sampling receive the same context; ordinary callers still report missing queries", () => {
  const frames = trackOf({ "0": [0, 0, 0], "1": { pre: ["q.ground_speed", 0, 0], post: ["q.ground_speed * 2", 0, 0] }, "2": { post: [0, 0, 0], lerp_mode: "catmullrom" } });
  const ctx = { ...defaultMolangContext(), "query.ground_speed": 4 }, failures = [];
  assert.deepEqual(sampleTrack(frames, 1, undefined, ctx), [8, 0, 0]);
  assert.ok(sampleTrack(frames, 1.5, undefined, ctx).every(Number.isFinite));
  assert.equal(sampleTrack(frames, 1, message => failures.push(message)), null);
  assert.match(failures[0], /未提供/);
});
