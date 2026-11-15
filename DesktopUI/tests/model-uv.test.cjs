const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { packUv, templateRects } = require("../shared/model-uv.cjs");
const { uvFaces } = require("../shared/model-edit.cjs");
const { createTexture } = require("../electron/domains/profiles/content-files.cjs");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

const fixture = () => [{ name: "body", pivot: [1, 2, 3], extension: true, cubes: [
  { origin: [-4, 0, 0], size: [8, 12, 4], uv: [-8, 20], mirror: true, dgnId: "keep" },
  { origin: [4, 0, 0], size: [3, 4, 5], uv: [100, -2], rotation: [0, 90, 0] },
  { origin: [0, 0, 0], size: [2, 2, 2], uv: { north: { uv: [10.25, 2.5], uv_size: [-6.5, 3.5], uv_rotation: 90, material_instance: "keep", future: true }, south: { uv: [0, 0], uv_size: [5, -4] }, up: null } },
] }];
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test("packing separates boxes and faces, preserves signed UV, rotations and unknown fields, and is deterministic", () => {
  const source = fixture(), original = structuredClone(source), result = packUv(source, 64, 64, 1);
  assert.deepEqual(source, original); assert.deepEqual(packUv(source, 64, 64, 1), result);
  assert.equal(result.islands, 4); assert.equal(result.faces, 14);
  const rectangles = result.bones[0].cubes.flatMap((cube, index) => uvFaces(cube).map(face => ({ ...face, index, x: Math.min(face.x, face.x + face.w), y: Math.min(face.y, face.y + face.h), w: Math.abs(face.w), h: Math.abs(face.h) })));
  for (let i = 0; i < rectangles.length; i++) {
    const a = rectangles[i]; assert.ok(a.x >= 1 && a.y >= 1 && a.x + a.w <= 63 && a.y + a.h <= 63);
    for (const b of rectangles.slice(i + 1)) if (a.index !== b.index || a.index === 2) assert.equal(overlaps(a, b), false);
  }
  for (let i = 0; i < 3; i++) {
    const { uv: before, ...originalCube } = source[0].cubes[i], { uv: after, ...nextCube } = result.bones[0].cubes[i];
    assert.deepEqual(nextCube, originalCube);
    if (!Array.isArray(before)) {
      for (const name of ["north", "south"]) { const { uv: _a, ...a } = before[name], { uv: _b, ...b } = after[name]; assert.deepEqual(b, a); }
      assert.equal(after.up, null);
    }
  }
});

test("packing reuses rectangular free space when a height shelf would overflow", () => {
  const bones = [{ name: "body", cubes: [
    { size: [1, 1, 1], uv: { north: { uv: [0, 0], uv_size: [4, 6] } } },
    { size: [1, 1, 1], uv: { north: { uv: [0, 0], uv_size: [6, 4] } } },
    { size: [1, 1, 1], uv: { north: { uv: [0, 0], uv_size: [5, 5] } } },
  ] }];
  const result = packUv(bones, 13, 13, 1);
  assert.deepEqual(result.bones[0].cubes.map(cube => cube.uv.north.uv), [[1, 1], [1, 8], [6, 1]]);
});

test("packing and template limits fail before changing input and missing/zero faces stay omitted", () => {
  const bones = fixture(), original = structuredClone(bones);
  for (const [w, h, gap] of [[8, 8, 1], [0, 64, 1], [2049, 64, 1], [64.5, 64, 1], [64, 64, -1], [64, 64, 17]]) assert.throws(() => packUv(bones, w, h, gap));
  assert.deepEqual(bones, original);
  assert.throws(() => templateRects(bones, 64, 64), /超出/);
  assert.throws(() => packUv([{ name: "x", cubes: [{ uv: [NaN, 0], size: [1, 1, 1] }] }], 64, 64), /无效/);
  assert.throws(() => packUv([{ cubes: Array.from({ length: 2001 }, () => ({ size: [1, 1, 1], uv: [0, 0] })) }], 256, 256), /2000/);
  const sparse = [{ cubes: [{ uv: { north: { uv: [0, 0], uv_size: [0, 4] }, south: { uv: [10, 10], uv_size: [2, 3] } } }, { size: [1, 1, 1] }] }];
  assert.equal(packUv(sparse, 8, 8).faces, 1); assert.equal(packUv(sparse, 8, 8).bones[0].cubes[0].uv.west, undefined);
  assert.throws(() => packUv([], 64, 64), /没有/);
});

test("template footprints cover fractional signed faces with fixed orientation colors and cap overlap work", () => {
  const bones = [{ cubes: [{ uv: { north: { uv: [8.25, 3.5], uv_size: [-6.5, 3.5], uv_rotation: 90 } } }] }];
  assert.deepEqual(templateRects(bones, 16, 16), [{ x: 1, y: 3, w: 8, h: 4, color: [112, 146, 214], name: "north" }]);
  assert.throws(() => templateRects([{ cubes: Array.from({ length: 9 }, () => ({ uv: { north: { uv: [0, 0], uv_size: [2048, 2048] } } })) }], 2048, 2048), /过多/);
});

test("template creation encodes exact face colors, dark borders and transparent gaps without modifying the model", async () => {
  const dir = artifactPath("template"), model = path.join(dir, "model.geo.json"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(model, "{}");
  const library = { list: async () => ({ mods: [{ path: dir }] }) };
  const bones = [{ cubes: [{ uv: { north: { uv: [2, 2], uv_size: [6, 5] } } }] }];
  const args = { modelPath: model, name: "template", width: 16, height: 16, templateBones: bones };
  const created = await createTexture(library, args), bytes = await fs.readFile(created.path), decoded = decodePng(bytes);
  const pixel = (x, y) => [...decoded.pixels.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]); assert.deepEqual(pixel(3, 3), [112, 146, 214, 255]); assert.deepEqual(pixel(2, 2), [73, 95, 139, 255]);
  assert.equal(await fs.readFile(model, "utf8"), "{}");
  await assert.rejects(createTexture(library, args), /同名/); assert.deepEqual(await fs.readFile(created.path), bytes);
  await assert.rejects(createTexture(library, { ...args, name: "bad", templateBones: [{ cubes: [{ uv: { north: { uv: [15, 0], uv_size: [4, 4] } } }] }] }), /超出/);
  await assert.rejects(fs.stat(path.join(dir, "textures/bad.png")), { code: "ENOENT" });
});

test("concurrent creation never overwrites and a redirected texture directory is refused", async () => {
  const dir = artifactPath("exclusive"), model = path.join(dir, "model.geo.json"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(model, "{}");
  const library = { list: async () => ({ mods: [{ path: dir }] }) }, args = { modelPath: model, name: "same", width: 8, height: 8 };
  const results = await Promise.allSettled([createTexture(library, args), createTexture(library, args)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.match(results.find(value => value.status === "rejected").reason.message, /同名/);
  const linkRoot = artifactPath("link"), outside = artifactPath("outside"); await fs.mkdir(linkRoot); await fs.mkdir(outside);
  const linkedModel = path.join(linkRoot, "model.geo.json"); await fs.writeFile(linkedModel, "{}");
  await fs.symlink(outside, path.join(linkRoot, "textures"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createTexture({ list: async () => ({ mods: [{ path: linkRoot }] }) }, { ...args, modelPath: linkedModel }), /链接|变化/);
  assert.deepEqual(await fs.readdir(outside), []);
});
