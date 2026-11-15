const test = require("node:test"), assert = require("node:assert/strict");
const { vertexSnapContext, moveWithVertexSnap, alignVertexPoints, pickProjectedVertex, cubeVertexMarkers } = require("./fixtures/vertex-snap.cjs");
const { Vector3, PerspectiveCamera, OrthographicCamera } = require("three");
const { worldVertices } = require("./fixtures/model-positions.cjs");

const fixture = () => [{ name: "source", cubes: [{ dgnId: "a", name: "a", origin: [0, 0, 0], size: [2, 2, 2], pivot: [1, 1, 1], uv: [0, 0], extension: { keep: 42 } }] }, { name: "target", cubes: [{ dgnId: "b", name: "b", origin: [3.3, 0, 0], size: [2, 2, 2], uv: [0, 0] }] }];
function shiftMatches(before, after, name, delta) {
  for (let i = 0; i < before[name].length; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(after[name][i][j] - before[name][i][j] - delta[j]) < 1e-6, `${name} ${i} ${j}`);
}
function touches(a, b) { return a.some(point => b.some(target => point.every((n, i) => Math.abs(n - target[i]) < 1e-6))); }

test("nearby corner aligns exactly, distant movement remains free and input/payloads stay intact", () => {
  const bones = fixture(), before = structuredClone(bones), context = vertexSnapContext(bones, ["a"]);
  const hit = moveWithVertexSnap(context, [1, 0, 0]);
  assert.deepEqual(hit.delta.map(n => Math.round(n * 1e6) / 1e6), [1.3, 0, 0]); assert.equal(hit.target.bone, "target");
  const vertices = worldVertices(hit.bones); assert.equal(touches(vertices.a, vertices.b), true);
  assert.deepEqual(hit.bones[0].cubes[0].pivot, [2.3, 1, 1]); assert.deepEqual(hit.bones[0].cubes[0].extension, { keep: 42 }); assert.strictEqual(hit.bones[1], bones[1]); assert.deepEqual(bones, before);
  const far = moveWithVertexSnap(context, [-2, 0, 0]); assert.equal(far.target, null); assert.deepEqual(far.delta, [-2, 0, 0]);
});

test("targets exclude every selected and hidden cube while nearest target wins deterministically", () => {
  const bones = fixture(); bones[1].cubes.push({ dgnId: "c", name: "c", origin: [3.1, 0, 0], size: [2, 2, 2], uv: [0, 0] });
  const closest = moveWithVertexSnap(vertexSnapContext(bones, ["a"]), [1, 0, 0]); assert.equal(closest.target.cube, 1);
  assert.deepEqual(moveWithVertexSnap(vertexSnapContext(bones, ["a"]), [1, 0, 0]), closest);
  const hidden = moveWithVertexSnap(vertexSnapContext(bones, ["a"], ["c"]), [1, 0, 0]); assert.equal(hidden.target.cube, 0);
  assert.equal(moveWithVertexSnap(vertexSnapContext(bones, ["a"], ["target"]), [1, 0, 0]).target, null);
  assert.equal(moveWithVertexSnap(vertexSnapContext(bones, ["a", "b", "c"]), [1, 0, 0]).target, null);
  assert.throws(() => vertexSnapContext(bones, ["a"], ["a"]), /可见/);
});

test("one world-space translation preserves relative positions across rotated bone hierarchies", () => {
  const bones = fixture(); bones[0].rotation = [0, 0, 90];
  bones.push({ name: "other", pivot: [20, 10, 3], rotation: [40, 25, 10], cubes: [{ dgnId: "c", name: "c", origin: [20, 20, 10], size: [1, 3, 2], pivot: [15, 5, 12], rotation: [10, -20, 30], uv: [0, 0] }] });
  const start = worldVertices(bones), result = moveWithVertexSnap(vertexSnapContext(bones, ["a", "c"]), [3, 0, 0]), end = worldVertices(result.bones);
  assert.ok(result.target); assert.equal(touches(end.a, end.b), true); shiftMatches(start, end, "a", result.delta); shiftMatches(start, end, "c", result.delta); shiftMatches(start, end, "b", [0, 0, 0]);
  assert.notDeepEqual(result.bones[0].cubes[0].origin, result.delta);
  for (const [b, index] of [[0, 0], [2, 0]]) { assert.deepEqual(result.bones[b].cubes[index].rotation, bones[b].cubes[index].rotation); assert.deepEqual(result.bones[b].cubes[index].size, bones[b].cubes[index].size); }
});

test("rotated inflated corners use actual geometry and signed cube dimensions remain unchanged", () => {
  const bones = fixture(); bones[0].cubes[0].rotation = [20, 30, 40]; bones[0].cubes[0].inflate = 0.25; bones[1].rotation = [15, -20, 10]; bones[1].cubes[0].size = [-2, 3, 4];
  const context = vertexSnapContext(bones, ["a"]), source = context.sources[0].point, target = [...context.targets.values()][0][0].point;
  const delta = target.clone().sub(source).toArray(); delta[0] -= 0.1;
  const result = moveWithVertexSnap(context, delta), vertices = worldVertices(result.bones); assert.ok(result.target); assert.ok(touches(vertices.a, vertices.b));
  assert.equal(result.bones[0].cubes[0].inflate, 0.25); assert.deepEqual(result.bones[1], bones[1]);
});

test("invalid selection, hierarchy, bindings, values and oversized results reject without partial writes", () => {
  const bones = fixture(), before = structuredClone(bones);
  assert.throws(() => vertexSnapContext(bones, ["missing"]), /已变化/);
  for (const mutate of [b => { b[0].parent = "missing"; }, b => { b[0].parent = "source"; }, b => { b[0].scale = [1, 2, 1]; }, b => { b[0].cubes[0].rotation = [NaN, 0, 0]; }]) { const copy = structuredClone(bones); mutate(copy); const original = structuredClone(copy); assert.throws(() => vertexSnapContext(copy, ["a"])); assert.deepEqual(copy, original); }
  const context = vertexSnapContext(bones, ["a"]);
  assert.throws(() => moveWithVertexSnap(context, [Infinity, 0, 0]), /移动量/);
  assert.throws(() => moveWithVertexSnap(context, [1e6, 0, 0]), /超出/);
  assert.deepEqual(bones, before);
});

test("explicit source/target alignment ignores proximity and constrains only the requested world axes", () => {
  const bones = fixture(); bones[1].cubes[0].origin = [15, 8, -6];
  const context = vertexSnapContext(bones, ["a"]), source = context.sources[0], target = [...context.targets.values()].flat()[5], before = worldVertices(bones);
  for (const axis of ["all", "x", "y", "z"]) {
    const result = alignVertexPoints(context, source, target, axis), after = worldVertices(result.bones);
    shiftMatches(before, after, "a", result.delta); shiftMatches(before, after, "b", [0, 0, 0]);
    if (axis === "all") assert.ok(touches(after.a, after.b));
    else for (let i = 0; i < 3; i++) if (i !== "xyz".indexOf(axis)) assert.equal(result.delta[i], 0);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.point[i] - source.point.getComponent(i) - result.delta[i]) < 1e-9);
  }
  assert.deepEqual(bones[0].cubes[0].origin, [0, 0, 0]);
  assert.throws(() => alignVertexPoints(context, target, source), /已变化/);
  assert.throws(() => alignVertexPoints(context, source, { ...target }), /已变化/);
  assert.throws(() => alignVertexPoints(context, source, target, "bad"), /对齐轴/);
});

test("exact alignment translates all selected rotated cubes together and excludes obsolete point sessions", () => {
  const bones = fixture(); bones[0].rotation = [15, 20, 30];
  bones.push({ name: "child", parent: "source", pivot: [3, 5, 2], rotation: [12, -35, 10], cubes: [{ dgnId: "c", name: "c", origin: [8, 7, 2], size: [3, 2, 1], uv: [0, 0] }] });
  const before = worldVertices(bones), context = vertexSnapContext(bones, ["a", "c"]), source = context.sources.find(item => item.id === "c"), target = [...context.targets.values()].flat()[0];
  const result = alignVertexPoints(context, source, target), after = worldVertices(result.bones);
  assert.ok(touches(after.c, after.b)); shiftMatches(before, after, "a", result.delta); shiftMatches(before, after, "c", result.delta);
  const next = vertexSnapContext(result.bones, ["a", "c"]);
  assert.throws(() => alignVertexPoints(next, source, target), /已变化/);
});

test("point picking uses pixel radius, clips offscreen points and chooses the nearer camera depth on overlap", () => {
  for (const camera of [new PerspectiveCamera(40, 1, 0.01, 100), new OrthographicCamera(-1, 1, 1, -1, 0.01, 100)]) {
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const back = { point: new Vector3(0, 0, -16) }, front = { point: new Vector3(0, 0, 16) }, behind = { point: new Vector3(0, 0, 96) };
    assert.strictEqual(pickProjectedVertex([back, front, behind], camera, 200, 200, 400, 400), front);
    assert.strictEqual(pickProjectedVertex([back, front], camera, 209, 200, 400, 400), front);
    assert.equal(pickProjectedVertex([back, front], camera, 211, 200, 400, 400), null);
    assert.equal(pickProjectedVertex([behind, { point: new Vector3(1600, 0, 0) }], camera, 200, 200, 400, 400), null);
  }
});

test("vertex tool markers follow bone rotation and disappear when the cube is hidden", () => {
  const bones = [{ name: "body", pivot: [0, 0, 0], rotation: [0, 90, 0], cubes: [{ origin: [0, 0, 0], size: [16, 2, 2], uv: [0, 0] }] }];
  const markers = cubeVertexMarkers(bones, "body", 0);
  assert.equal(markers.length, 8);
  assert.ok(markers[1].point.toArray().every((value, axis) => Math.abs(value - [0, 0, -16][axis]) < 1e-4));
  assert.equal(cubeVertexMarkers(bones, "body", 0, ["body"]).length, 0);
});
