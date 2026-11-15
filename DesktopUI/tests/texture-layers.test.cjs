const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), zlib = require("node:zlib");
const { readLayerPng, writeLayerPng, digest } = require("../electron/domains/profiles/texture-layers.cjs");
const { createTexture, readTexture, saveTexture } = require("../electron/domains/profiles/content-files.cjs");
const { decodePng } = require("../electron/domains/skins/npc-skins.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");
const { validateLayers, blendModes, maskCoverage } = require("../shared/texture-layers.cjs");

async function fixture(name) {
  const dir = artifactPath(name), model = path.join(dir, "model.geo.json"); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(model, "{}");
  const library = { list: async () => ({ mods: [{ path: dir }] }) }, file = (await createTexture(library, { modelPath: model, name: "ink", width: 8, height: 8 })).path;
  const original = await fs.readFile(file), dataUrl = "data:image/png;base64," + original.toString("base64");
  const layers = { version: 1, active: 1, layers: [{ name: "背景", visible: true, locked: true, opacity: 100, source: dataUrl }, { name: "上层", visible: false, locked: false, opacity: 37, source: dataUrl }] };
  return { dir, library, file, original, dataUrl, layers };
}

test("layer PNG keeps flattened pixels and restores hidden layers, active layer and metadata", async () => {
  const f = await fixture("roundtrip"), encoded = writeLayerPng(f.dataUrl, f.layers), read = readLayerPng(encoded);
  assert.deepEqual(read.layers, f.layers); assert.equal(read.dataUrl, f.dataUrl);
  assert.deepEqual(decodePng(encoded).pixels, decodePng(f.original).pixels);
  assert.deepEqual(readLayerPng(f.original), { dataUrl: f.dataUrl, layers: null });
  assert.deepEqual(writeLayerPng(read.dataUrl, read.layers), encoded);
});

test("blend modes roundtrip in version 2 while legacy layers retain normal semantics", async () => {
  const f = await fixture("blend");
  assert.equal(readLayerPng(writeLayerPng(f.dataUrl, f.layers)).layers.version, 1);
  for (const { value } of blendModes) {
    const layers = structuredClone(f.layers); layers.version = 2; layers.layers[1].blendMode = value;
    assert.deepEqual(readLayerPng(writeLayerPng(f.dataUrl, layers)).layers, layers);
  }
  const mixed = structuredClone(f.layers); mixed.layers[1].blendMode = "multiply";
  assert.throws(() => writeLayerPng(f.dataUrl, mixed), /新版图层格式/);
  mixed.version = 2;
  for (const mode of ["destination-out", "unknown", null, 1, {}]) {
    mixed.layers[1].blendMode = mode; assert.throws(() => writeLayerPng(f.dataUrl, mixed), /混合模式/);
  }
  await assert.rejects(saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, layers: mixed, revision: digest(f.original) }), /混合模式/);
  assert.deepEqual(await fs.readFile(f.file), f.original);
  await assert.rejects(fs.stat(f.file + ".bak"), { code: "ENOENT" });
});

test("invalid layer counts, dimensions, attributes, nested images and corrupt pixels are rejected", async () => {
  const f = await fixture("invalid");
  for (const patch of [{ active: 3 }, { version: 4 }, { layers: [] }, { layers: Array(17).fill(f.layers.layers[0]) }]) assert.throws(() => writeLayerPng(f.dataUrl, { ...f.layers, ...patch }));
  for (const patch of [{ name: "" }, { opacity: 101 }, { opacity: 1.5 }, { visible: 1 }, { source: "file:///secret" }]) assert.throws(() => writeLayerPng(f.dataUrl, { ...f.layers, layers: [f.layers.layers[0], { ...f.layers.layers[1], ...patch }] }));
  const nested = "data:image/png;base64," + writeLayerPng(f.dataUrl, f.layers).toString("base64");
  assert.throws(() => writeLayerPng(nested, f.layers), /嵌套/);
  assert.throws(() => writeLayerPng(f.dataUrl, { ...f.layers, layers: [f.layers.layers[0], { ...f.layers.layers[1], source: nested }] }), /嵌套/);
  const bad = Buffer.from(f.original); bad[bad.length - 1] ^= 1;
  assert.throws(() => readLayerPng(bad), /PNG/);
  assert.throws(() => readLayerPng(Buffer.concat([f.original, Buffer.from([1])])), /结尾/);
  assert.throws(() => validateLayers({ ...f.layers, layers: Array(5).fill(f.layers.layers[0]) }, 2048, 2048), /总像素/);
  assert.throws(() => validateLayers({ ...f.layers, active: 0, layers: [{ ...f.layers.layers[0], source: "data:image/png;base64," + "A".repeat(9 * 1024 * 1024) }] }, 8, 8), /8MB/);
});

test("mask coverage combines luminance and alpha without changing the original pixels", () => {
  const rgba = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 128, 255, 0, 0, 255, 255, 255, 255, 0]);
  const original = rgba.slice();
  assert.deepEqual([0, 4, 8, 12, 16, 20].map(i => maskCoverage(rgba, i)), [255, 0, 128, 128, 54, 0]);
  assert.deepEqual(rgba, original);
});

test("mask PNG roundtrip preserves edit target and rejects missing, nested, mismatched or old-format masks", async () => {
  const f = await fixture("mask"), layers = structuredClone(f.layers); layers.version = 3; layers.editTarget = "mask";
  layers.layers[1].mask = { enabled: false, source: f.dataUrl };
  assert.deepEqual(readLayerPng(writeLayerPng(f.dataUrl, layers)).layers, layers);
  const missing = structuredClone(layers); delete missing.layers[1].mask;
  assert.throws(() => writeLayerPng(f.dataUrl, missing), /没有蒙版/);
  assert.throws(() => writeLayerPng(f.dataUrl, { ...layers, version: 2 }), /新版图层格式/);
  for (const mask of [null, { enabled: "yes", source: f.dataUrl }, { enabled: true, source: "file:///mask.png" }]) {
    const invalid = structuredClone(layers); invalid.layers[1].mask = mask; assert.throws(() => writeLayerPng(f.dataUrl, invalid));
  }
  const nested = structuredClone(layers); nested.layers[1].mask.source = "data:image/png;base64," + writeLayerPng(f.dataUrl, layers).toString("base64");
  assert.throws(() => writeLayerPng(f.dataUrl, nested), /嵌套/);
  const small = await createTexture(f.library, { modelPath: path.join(f.dir, "model.geo.json"), name: "small", width: 4, height: 4 });
  const mismatch = structuredClone(layers); mismatch.layers[1].mask.source = "data:image/png;base64," + (await fs.readFile(small.path)).toString("base64");
  await assert.rejects(saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, revision: digest(f.original), layers: mismatch }), /尺寸不匹配/);
  assert.deepEqual(await fs.readFile(f.file), f.original);
  const oversized = { ...layers, layers: Array.from({ length: 3 }, () => ({ ...layers.layers[1] })) };
  assert.throws(() => validateLayers(oversized, 2048, 2048), /总像素/);
});

test("layer image decompression is bounded and truncated pixel data is rejected", async () => {
  const f = await fixture("inflate");
  const chunk = (name, data) => { const size = Buffer.alloc(4), body = Buffer.concat([Buffer.from(name), data]), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body)); return Buffer.concat([size, body, crc]); };
  for (const bytes of [Buffer.alloc(100000), Buffer.alloc(1)]) {
    const malformed = Buffer.concat([f.original.subarray(0, 33), chunk("IDAT", zlib.deflateSync(bytes)), f.original.subarray(-12)]);
    const layers = structuredClone(f.layers); layers.layers[1].source = "data:image/png;base64," + malformed.toString("base64");
    assert.throws(() => writeLayerPng(f.dataUrl, layers));
  }
});

test("retained layer metadata rejects an externally changed flattened PNG even with valid chunk CRC", async () => {
  const f = await fixture("mismatch"), encoded = writeLayerPng(f.dataUrl, f.layers);
  const name = Buffer.from("tEXt"), content = Buffer.from("test\0external"), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(content.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, content])));
  const changed = Buffer.concat([encoded.subarray(0, -12), size, name, content, crc, encoded.subarray(-12)]);
  assert.throws(() => readLayerPng(changed), /外部修改/);
});

test("saving atomically preserves backup, revision and layers; stale or concurrent requests cannot overwrite", async () => {
  const f = await fixture("save"), first = await readTexture(f.library, f.file);
  const saved = await saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, layers: f.layers, revision: first.revision });
  assert.deepEqual(await fs.readFile(f.file + ".bak"), f.original);
  const current = await readTexture(f.library, f.file); assert.deepEqual(current.layers, f.layers); assert.equal(current.revision, saved.revision);
  await assert.rejects(saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, revision: first.revision }), /外部修改/);
  await assert.rejects(saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, revision: current.revision }), /含图层/);
  const changed = structuredClone(f.layers); changed.layers[1].name = "已更名";
  const results = await Promise.allSettled([1, 2].map(() => saveTexture(f.library, { path: f.file, dataUrl: f.dataUrl, layers: changed, revision: current.revision })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.match(results.find(r => r.status === "rejected").reason.message, /外部修改/);
  assert.equal((await readTexture(f.library, f.file)).layers.layers[1].name, "已更名");
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ["ink.png", "ink.png.bak"]);
});

test("backup failures and redirected backups preserve the original image", async () => {
  const f = await fixture("failure"), before = await readTexture(f.library, f.file), args = { path: f.file, dataUrl: f.dataUrl, layers: f.layers, revision: before.revision };
  await fs.mkdir(f.file + ".bak"); await assert.rejects(saveTexture(f.library, args)); assert.deepEqual(await fs.readFile(f.file), f.original);
  await fs.rmdir(f.file + ".bak");
  const outside = path.join(f.dir, "outside"); await fs.mkdir(outside); await fs.symlink(outside, f.file + ".bak", process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(saveTexture(f.library, args), /链接|变化/); assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(digest(await fs.readFile(f.file)), before.revision);
});
