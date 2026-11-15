const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const yauzl = require("yauzl");
const { NpcSkins, zipStore, modernizeSkinPng, pngInfo, decodePng } = require("../electron/domains/skins/npc-skins.cjs");

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([head, body, crc]);
}
function paintedPng(width, height, pixels) {
  const rgba = Buffer.alloc(width * height * 4);
  for (const [x, y, r, g, b, a] of pixels) {
    const index = (y * width + x) * 4;
    rgba[index] = r; rgba[index + 1] = g; rgba[index + 2] = b; rgba[index + 3] = a;
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = width * 4 + 1;
  const raw = Buffer.alloc(row * height);
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          entries.push({ name: entry.fileName, data: Buffer.alloc(0) });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks = [];
          stream.on("data", (item) => chunks.push(item));
          stream.on("end", () => {
            entries.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-skins-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, skins: new NpcSkins(root), out: path.join(root, "out") };
}

test("npc skin draft exports a pack and keeps ids", async (t) => {
  const { skins, out } = await workspace(t);
  await fs.mkdir(out);
  const staged = await skins.stage(png(64, 64), "守卫.png");
  const added = await skins.add([{ ...staged, name: "守卫", author: "作者" }]);
  assert.match(added.items[0].id, /^skin_[0-9A-F]{5}$/);
  assert.equal(added.items[0].textureSlot, "skin_4");
  const first = await skins.exportZip(path.join(out, "a.zip"));
  const again = await skins.exportZip(path.join(out, "b.zip"));
  const entries = await readZip(first.path);
  const config = entries.find((entry) => entry.name.includes("/modconfigs/") && entry.name.endsWith(".json"));
  const parsed = JSON.parse(config.data.toString("utf8"));
  assert.equal(parsed.npcskinlist[0].ID, added.items[0].id);
  assert.equal(parsed.npcskinlist[0].name, "守卫");
  assert.equal(parsed.npcskinlist[0].texture, "textures/entity/npc_dlcskin/" + added.items[0].id);
  const script = entries.find((entry) => entry.name.endsWith("/init_modnpcskinClientSystem.py"));
  const configFile = path.posix.basename(config.name);
  assert.match(configFile, /^[a-z][a-z0-9]{4}\.json$/);
  assert.equal(script.data.includes(configFile), true);
  assert.equal(script.data.includes("ModName_skindlc.json"), false);
  assert.equal(script.data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  const manifest = JSON.parse(entries.find((entry) => entry.name.endsWith("_npc_skinB/manifest.json")).data.toString("utf8"));
  assert.notEqual(manifest.header.uuid, "6d45992b-a37d-4a82-9ab7-fe1390530992");
  assert.equal(entries.some((entry) => entry.name.endsWith("/textures/entity/npc_dlcskin/" + added.items[0].id + ".png")), true);
  const imported = await skins.importZip(again.path);
  assert.equal(imported.items[0].id, added.items[0].id);
  assert.equal(imported.items[0].fromImport, true);
  const round = await skins.exportZip(path.join(out, "c.zip"));
  const roundConfig = (await readZip(round.path)).find((entry) => entry.name.includes("/modconfigs/") && entry.data.includes("守卫"));
  assert.equal(JSON.parse(roundConfig.data.toString("utf8")).npcskinlist[0].ID, added.items[0].id);
});

test("human skins reject the wrong size and custom targets keep the texture", async (t) => {
  const { skins } = await workspace(t);
  const small = await skins.stage(png(32, 32), "small.png");
  await assert.rejects(skins.add([{ ...small, name: "人", author: "作者" }]), /皮肤尺寸/);
  assert.deepEqual((await skins.list()).items, []);
  const wolf = (await skins.targets()).find((item) => item.human === false);
  const added = await skins.add([{ ...small, name: "狼皮肤", author: "测试", targetIdentifier: wolf.identifier }]);
  assert.equal(added.items[0].textureSlot, wolf.texture_slot);
  const custom = await skins.stage(png(32, 32), "boss.png");
  const next = await skins.add([{
    ...custom, name: "自定义模型皮肤", author: "测试", targetIdentifier: "customnpc:my_boss_dlcnpc", textureSlot: "wea",
  }]);
  assert.equal(next.items[1].textureSlot, "wea");
  await assert.rejects(skins.update(added.items[0].id, {
    name: "人型", author: "测试", targetIdentifier: "", textureSlot: "skin_4",
  }), /皮肤尺寸/);
  assert.equal((await skins.list()).items[0].name, "狼皮肤");
});

test("import replaces the list only after the pack is valid", async (t) => {
  const { root, skins, out } = await workspace(t);
  await fs.mkdir(out);
  const image = png(64, 64);
  const shared = path.join(out, "shared.zip");
  await fs.writeFile(shared, zipStore([
    { name: "rp/modconfigs/a.json", data: Buffer.from(JSON.stringify({ npcskinlist: [
      { ID: "shared_a", name: "甲", texture: "textures/entity/shared" },
      { ID: "shared_b", name: "乙", by: "", texture: "textures/entity/shared" },
    ] }), "utf8") },
    { name: "rp/textures/entity/shared.png", data: image },
  ]));
  const imported = await skins.importZip(shared);
  assert.deepEqual(imported.items.map((item) => item.id), ["shared_a", "shared_b"]);
  assert.equal(imported.items[1].author, "NPC皮肤拓展");
  const output = await skins.exportZip(path.join(out, "pack.zip"));
  const entries = await readZip(output.path);
  assert.equal(entries.filter((entry) => entry.name.endsWith("/textures/entity/shared.png")).length, 1);
  const invalid = path.join(out, "bad.zip");
  await fs.writeFile(invalid, zipStore([
    { name: "rp/modconfigs/a.json", data: Buffer.from(JSON.stringify({ npcskinlist: [
      { ID: "", name: "bad", texture: "textures/entity/shared" },
    ] }), "utf8") },
    { name: "rp/textures/entity/shared.png", data: image },
  ]));
  await assert.rejects(skins.importZip(invalid), /非空/);
  assert.deepEqual((await skins.list()).items.map((item) => item.id), ["shared_a", "shared_b"]);
  const gbk = path.join(out, "gbk.zip");
  const broken = Buffer.from([0x7b, 0x22, 0x6e, 0x70, 0x63, 0x73, 0x6b, 0x69, 0x6e, 0x6c, 0x69, 0x73, 0x74, 0x22, 0x3a, 0xd6, 0xd0, 0x7d]);
  await fs.writeFile(gbk, zipStore([{ name: "rp/modconfigs/a.json", data: broken }]));
  await assert.rejects(skins.importZip(gbk), /rp\/modconfigs\/a\.json/);
  assert.equal((await fs.readdir(path.join(root, "npc-skins", "files"))).length, 2);
});

test("new skins start from a human template and painted pixels replace it", async (t) => {
  const { skins } = await workspace(t);
  const created = await skins.create({ name: "新人", author: "作者" });
  assert.match(created.skin.id, /^skin_[0-9A-F]{5}$/);
  const original = await skins.image(created.skin.id);
  assert.equal(original.startsWith("data:image/png;base64,"), true);
  const replacement = "data:image/png;base64," + png(64, 64).toString("base64");
  assert.notEqual(replacement, original);
  await skins.update(created.skin.id, { name: "新人", author: "作者", image: replacement });
  assert.equal(await skins.image(created.skin.id), replacement);
  await assert.rejects(skins.update(created.skin.id, {
    name: "新人", author: "作者", image: "data:image/png;base64," + png(32, 32).toString("base64"),
  }), /皮肤尺寸/);
  assert.equal(await skins.image(created.skin.id), replacement);
});

test("removing several skins deletes only those drafts", async (t) => {
  const { skins, root } = await workspace(t);
  const first = await skins.create({ name: "甲", author: "作者" });
  const second = await skins.create({ name: "乙", author: "作者" });
  const third = await skins.create({ name: "丙", author: "作者" });
  const removed = await skins.remove([first.skin.id, third.skin.id]);
  assert.deepEqual(removed.items.map((item) => item.name), ["乙"]);
  await assert.rejects(skins.image(first.skin.id), /找不到这个皮肤/);
  assert.equal((await fs.readdir(path.join(root, "npc-skins", "files"))).length, 1);
  assert.equal((await skins.remove(second.skin.id)).items.length, 0);
});

test("a new non-human skin starts from that model's texture", async (t) => {
  const { skins } = await workspace(t);
  const created = await skins.create({
    name: "马",
    author: "作者",
    targetIdentifier: "customnpc:horse_dlcnpc",
  });
  const textures = require("../shared/skins/npc-textures.json");
  assert.equal(await skins.image(created.skin.id), textures["customnpc:horse_dlcnpc"]);
  assert.equal(created.skin.textureSlot, "base_white");
});

test("legacy skins with trailing bytes convert to square skins with mirrored limbs", async (t) => {
  const source = Buffer.concat([paintedPng(64, 32, [[4, 20, 255, 0, 0, 255], [44, 20, 0, 0, 255, 255]]), Buffer.from("trailing")]);
  assert.equal(pngInfo(source).height, 32);
  const pixels = decodePng(modernizeSkinPng(source)).pixels;
  assert.equal(pixels[(52 * 64 + 23) * 4], 255);
  assert.equal(pixels[(52 * 64 + 39) * 4 + 2], 255);
  const { skins, out } = await workspace(t);
  await fs.mkdir(out);
  const staged = await skins.stage(source, "old.png");
  await skins.add([{ ...staged, name: "旧版/皮肤", author: "作者" }]);
  const exported = await skins.exportModern(out);
  assert.equal(exported.converted, 1);
  assert.equal(exported.copied, 0);
  const written = decodePng(await fs.readFile(path.join(out, "旧版_皮肤.png")));
  assert.deepEqual([written.width, written.height], [64, 64]);
  assert.equal(written.pixels[(52 * 64 + 23) * 4], 255);
});
