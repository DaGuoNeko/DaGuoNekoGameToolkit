const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { validateWorldAssets } = require("../electron/domains/worlds/asset-validation.cjs");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-assets-"));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const pack = path.join(root, "resource_packs", "Test");
  await fs.mkdir(path.join(pack, "textures"), { recursive: true });
  await fs.writeFile(path.join(pack, "textures", "ok.png"), png);
  await fs.writeFile(path.join(pack, "manifest.json"), JSON.stringify({
    header: { uuid: "11111111-1111-4111-8111-111111111111", version: [1, 0, 0] },
    modules: [{ type: "resources" }],
  }));
  return { root, pack };
}
test("world asset preflight validates PNG structure, empty paths and missing references", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.pack, "ui.jsonc"), `{
    "texture": "textures/ok.png",
    "missing_texture": "textures/missing.png",
    "empty_texture": ""
  }`);
  const result = await validateWorldAssets(f.root);
  assert.equal(result.ok, false);
  assert(result.errors.some(e => e.type === "missing_resource_reference"));
  assert(result.errors.some(e => e.type === "empty_resource_path"));
  assert.equal(result.packs[0].pngs, 1);
});
test("world asset preflight rejects truncated PNGs and accepts a clean pack", async (t) => {
  const f = await fixture(t);
  assert.equal((await validateWorldAssets(f.root)).ok, true);
  await fs.writeFile(path.join(f.pack, "textures", "bad.png"), png.subarray(0, 20));
  const result = await validateWorldAssets(f.root);
  assert(result.errors.some(e => e.type === "invalid_png" && e.file.endsWith("bad.png")));
});
test("preflight rejects header-only PNGs and reports uncertain references as warnings", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.pack, "textures", "empty.png"), Buffer.concat([png.subarray(0,33),png.subarray(-12)]));
  await fs.writeFile(path.join(f.pack, "ui.json"), JSON.stringify({texture:"textures/vanilla_alias"}));
  const result = await validateWorldAssets(f.root);
  assert(result.errors.some(e => e.type === "invalid_png" && e.file.endsWith("empty.png")));
  assert.equal(result.warnings.length,1);
  assert.equal(result.warnings[0].reason,"extensionless_alias_or_vanilla_reference");
});
test("preflight reports redirected packs and continues checking independent packs", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root,"behavior_packs");
  await fs.symlink(path.join(f.root,"resource_packs"),alias,process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.unlink(alias).catch(() => {}));
  const result = await validateWorldAssets(f.root);
  assert.equal(result.ok,false);
  assert(result.errors.some(e => e.type === "asset_scan_failed" && e.file === "behavior_packs"));
  assert.equal(result.packs.length,1);
});
