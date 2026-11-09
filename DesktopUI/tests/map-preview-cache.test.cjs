const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path");
const { Database } = require("@jsprismarine/leveldb");
const { renderWorld } = require("../electron/domains/worlds/map-preview.cjs");
const { MapPreviewJobs } = require("../electron/domains/worlds/map-preview-jobs.cjs");
const { bedrockMap, zipMap } = require("./fixtures/map-world.cjs");
const { inspectSelection } = require("../electron/file-selection.cjs");
const { artifactPath } = require("./fixtures/artifacts.cjs");

test("cached map index preserves all dimensions and selection results and invalidates on change", async () => {
  const source = artifactPath("source"), directory = artifactPath("cache");
  await bedrockMap(source); await fs.mkdir(directory, { recursive: true });
  const cache = { directory, state: {} };
  async function run(options) {
    const stages = [];
    const result = await renderWorld({ source, dataRoot: artifactPath("work"), cache, onProgress: stage => stages.push(stage), ...options });
    const expected = await renderWorld({ source, dataRoot: artifactPath("control"), ...options });
    assert.deepEqual(result, expected);
    return stages;
  }
  assert((await run({ chunks: [[-1, 0]] })).includes("索引基岩数据") === false); // 小夹具少于一次进度批次。
  assert(cache.state.index.keys.length > 0);
  assert((await run({ chunks: [[0, 0]] })).includes("复用基岩索引"));
  assert((await run({ dimension: "nether", chunks: [[0, 0]] })).includes("复用基岩索引"));
  const before = cache.state.index.stamp;
  const db = await Database.open(path.join(source, "db"));
  try { db.put(Buffer.from("cache-test-change"), Buffer.from([1])); } finally { await db.close(); }
  assert(!(await run({ chunks: [[0, 0]] })).includes("复用基岩索引"));
  assert.notEqual(cache.state.index.stamp, before);
  await fs.rename(source, source + "-previous"); await bedrockMap(source);
  assert(!(await run({ chunks: [[0, 0]] })).includes("复用基岩索引"));
});

test("archive reuse checks source identity; source switch removes the old extraction", async () => {
  const source = artifactPath("archive-source"), archive = artifactPath("source.mcworld"), directory = artifactPath("archive-cache");
  await bedrockMap(source); await zipMap(source, archive); await fs.mkdir(directory, { recursive: true });
  const cache = { directory, state: {} }, args = { source: archive, cache, dataRoot: artifactPath("archive-work"), chunks: [[0, 0]] };
  const first = await renderWorld(args), extraction = cache.state.archiveRoot;
  const stages = [], second = await renderWorld({ ...args, onProgress: stage => stages.push(stage) });
  assert.deepEqual(second, first); assert(stages.includes("复用已解压存档")); assert(!stages.includes("解压存档"));
  await zipMap(source, archive);
  await renderWorld(args);
  assert.notEqual(cache.state.archiveRoot, extraction); await assert.rejects(fs.stat(extraction), { code: "ENOENT" });
  const previous = cache.state.archiveRoot;
  await renderWorld({ ...args, source });
  assert.equal(cache.state.archiveRoot, undefined); await assert.rejects(fs.stat(previous), { code: "ENOENT" });
});

test("cached jobs verify authorization on every request and release all caches on failure/shutdown", async t => {
  const root = artifactPath("jobs"), source = artifactPath("jobs-source"); await bedrockMap(source);
  const service = new MapPreviewJobs(root, path.resolve("electron/domains/worlds/map-preview-worker.cjs"), { cachePreview: true });
  t.after(() => service.dispose());
  const identity = await inspectSelection(source);
  await service.render("one", { source, identity, chunks: [[0, 0]] });
  assert(service.previewCache.index); assert(service.cacheDirectory);
  await service.render("two", { source, identity, chunks: [[1, 0]] });
  const db = await Database.open(path.join(source, "db")); await db.close(); // 前次 worker 没有保留数据库句柄。
  await fs.rename(source, source + "-old"); await bedrockMap(source);
  await assert.rejects(service.render("stale", { source, identity, chunks: [[0, 0]] }), /变化/);
  assert.equal(service.previewCache, null); assert.equal(service.cacheDirectory, null);
  await service.render("fresh", { source, chunks: [[0, 0]] });
  const pending = service.render("cancelled", { source, chunks: [[1, 0]] });
  const rejected = assert.rejects(pending, /取消/);
  await service.cancel("cancelled"); await rejected;
  assert.equal(service.previewCache, null); assert.equal(service.cacheDirectory, null);
  await service.dispose(); assert.deepEqual(await fs.readdir(path.join(root, "map-preview-jobs")), []);
});

test("idle map cache is removed without holding a database or changing the source", async t => {
  const root = artifactPath("idle-jobs"), source = artifactPath("idle-source"); await bedrockMap(source);
  const service = new MapPreviewJobs(root, path.resolve("electron/domains/worlds/map-preview-worker.cjs"), { cachePreview: true, cacheIdleMs: 25 });
  t.after(() => service.dispose());
  await service.render("idle", { source, chunks: [[0, 0]] });
  for (let i = 0; i < 50 && service.cacheDirectory; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await service.cacheCleanup;
  assert.equal(service.cacheDirectory, null); assert.deepEqual(await fs.readdir(path.join(root, "map-preview-jobs")), []);
  await fs.access(path.join(source, "level.dat"));
});
