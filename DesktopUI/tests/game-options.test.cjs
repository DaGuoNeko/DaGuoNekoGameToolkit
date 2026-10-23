const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  GameOptions,
  patchOptions,
  valuesOf,
} = require("../electron/domains/game/game-options.cjs");
const { validateOverrides } = require("../shared/game-options-model.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-options-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = path.join(root, "minecraftpe/options.txt");
  await fs.mkdir(path.dirname(options));
  const original =
    "\ufeffunknown:https://example.test:a\r\ndev_connection_quality:0\r\naudio_music:0.06\r\nweird unparsed line\r\ndev_connection_quality:0\r\n";
  await fs.writeFile(options, original);
  return { root, options, original };
}
test("options patch preserves BOM, line endings, unknown colon values and updates every duplicate", () => {
  const text =
    "\ufeffdev_connection_quality:0\r\nunknown:http://host:a\r\ndev_connection_quality:0";
  const patch = patchOptions(text, {
    dev_connection_quality: "1",
    audio_main: "0.5",
  });
  assert.equal(
    patch.text,
    "\ufeffdev_connection_quality:1\r\nunknown:http://host:a\r\ndev_connection_quality:1\r\naudio_main:0.5\r\n",
  );
  assert.deepEqual(patch.changed, ["dev_connection_quality", "audio_main"]);
  assert.deepEqual(
    patchOptions(patch.text, {
      dev_connection_quality: "1",
      audio_main: "0.5",
    }),
    { text: patch.text, changed: [] },
  );
});
test("game settings reject unknown keys, control characters and out-of-range values", () => {
  for (const input of [
    { dev_connection_quality: "6" },
    { dev_connection_quality: "1\nkey:1" },
    { audio_main: "1.1" },
    { gfx_viewdistance: "81" },
    { constructor: "1" },
    null,
    [],
  ])
    assert.throws(() => validateOverrides(input));
  assert.deepEqual(
    validateOverrides({
      dev_connection_quality: "1",
      gfx_viewdistance: "304",
      audio_music: "0.06",
    }),
    {
      dev_connection_quality: "1",
      gfx_viewdistance: "304",
      audio_music: "0.06",
    },
  );
});
test("template save leaves actual options untouched; prepare backs up and preserves all unrelated bytes", async (t) => {
  const { root, options, original } = await fixture(t);
  const service = new GameOptions(root, options);
  const loaded = await service.snapshot();
  assert.equal(loaded.current.dev_connection_quality, "0");
  assert.equal(loaded.current.unknown, undefined);
  const saved = await service.save(loaded.revision, {
    dev_connection_quality: "1",
  });
  assert.equal(await fs.readFile(options, "utf8"), original);
  const result = await service.prepare();
  assert.deepEqual(result.changed, ["dev_connection_quality"]);
  assert.equal(await fs.readFile(result.backup, "utf8"), original);
  assert.equal(
    await fs.readFile(options, "utf8"),
    original.replaceAll("dev_connection_quality:0", "dev_connection_quality:1"),
  );
  assert.deepEqual((await service.prepare()).changed, []);
  assert.equal((await fs.readdir(service.backups)).length, 1);
  await assert.rejects(
    service.save(loaded.revision, { audio_music: "0.5" }),
    /其他窗口/,
  );
  await service.save(saved.revision, {});
  assert.deepEqual((await service.prepare()).changed, []);
  assert.equal(
    valuesOf(await fs.readFile(options, "utf8")).dev_connection_quality,
    "1",
  );
});
test("running games block changed shared options but allow no-op launches and saving future templates", async (t) => {
  const { root, options, original } = await fixture(t);
  const service = new GameOptions(root, options, {
    isRunning: async () => true,
  });
  await service.save(null, { dev_connection_quality: "1" });
  await assert.rejects(service.prepare(), /正在运行/);
  assert.equal(await fs.readFile(options, "utf8"), original);
  await service.save((await service.snapshot()).revision, {
    dev_connection_quality: "0",
  });
  assert.deepEqual((await service.prepare()).changed, []);
});
test("external options changes during preparation are detected and not overwritten", async (t) => {
  const { root, options, original } = await fixture(t);
  let checks = 0;
  const service = new GameOptions(root, options, {
    isRunning: async () => {
      if (++checks === 2)
        await fs.writeFile(options, original + "external:yes\r\n");
      return false;
    },
  });
  await service.save(null, { dev_connection_quality: "1" });
  await assert.rejects(service.prepare(), /其他程序修改/);
  assert.equal(
    await fs.readFile(options, "utf8"),
    original + "external:yes\r\n",
  );
});
test("missing, oversized, invalid encoding and damaged templates fail without replacing originals", async (t) => {
  const { root, options } = await fixture(t);
  const service = new GameOptions(root, options);
  await service.save(null, { dev_connection_quality: "1" });
  await fs.unlink(options);
  await assert.rejects(service.prepare(), /未找到/);
  await fs.writeFile(options, Buffer.from([255]));
  await assert.rejects(service.prepare());
  assert.deepEqual(await fs.readFile(options), Buffer.from([255]));
  await fs.writeFile(options, Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await assert.rejects(service.prepare(), /2 MB/);
  await fs.writeFile(service.file, "{ broken");
  await assert.rejects(service.snapshot());
  assert.equal(await fs.readFile(service.file, "utf8"), "{ broken");
});
