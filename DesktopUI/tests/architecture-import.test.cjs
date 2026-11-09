const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const model = require("../shared/terrain-model.cjs");
const { ArchitectureImport } = require("../electron/domains/worlds/architecture-import.cjs");
const { copySnapshot, readData, writeData } = require("../electron/domains/worlds/terrain-storage.cjs");
const { levelData } = require("./fixtures/zip.cjs");
const air = { name: "minecraft:air", states: {}, entity: null };
const stone = { name: "minecraft:stone", states: {}, entity: null };
const dirt = { name: "minecraft:dirt", states: {}, entity: null };

test("terrain planning validates a three-dimensional selection and independent target dimension", () => {
  const input = { x1: 6, y1: 95, z1: 12, x2: -4, y2: 64, z2: -3, targetX: 80, targetY: 90, targetZ: -120, sourceDimension: 0, targetDimension: 818555435, policy: "keep", includeAir: false };
  const plan = model.normalizePlan(input);
  assert.deepEqual([plan.x1, plan.y1, plan.z1], [-4, 64, -3]);
  assert.deepEqual([plan.x2, plan.y2, plan.z2], [6, 95, 12]);
  assert.equal(plan.targetDimension, 818555435);
  for (const patch of [{ targetDimension: NaN }, { sourceDimension: 2.5 }, { targetX: 29999984 }, { y2: 3000 }, { policy: "guess" }])
    assert.throws(() => model.normalizePlan({ ...input, ...patch }));
});

test("terrain geometry preserves negative bounds and partial chunks; inputs reject empty, fractional and oversized regions", () => {
  const r = model.region({ x1: 1, y1: 66, z1: 0, x2: -17, y2: 64, z2: -1 });
  const positions = [...model.tiles(r)].flatMap(model.positions);
  assert.equal(positions.length, r.volume);
  assert.equal(new Set(positions.map(String)).size, r.volume);
  assert(positions.some(p => p.join() === "-17,64,-1"));
  for (const v of ["", NaN, 2.5, Infinity, 30000000]) assert.throws(() => model.region({ x1: v, y1: 1, z1: 1, x2: 1, y2: 2, z2: 2 }));
  assert.throws(() => model.region({ x1: 0, y1: 0, z1: 0, x2: 9999, y2: 319, z2: 9999 }), /分区/);
  assert.throws(() => model.placement({ targetX: 0, targetY: 0, targetZ: 0, policy: "guess", includeAir: false }, r));
});
test("terrain conflict policies distinguish source air, target preservation and exact state/entity differences", () => {
  const tile = { min: [-1, 64, 0], max: [0, 65, 0] };
  const src = [stone, air, dirt, stone], dst = [air, stone, dirt, dirt];
  const a = model.changes(src, dst, tile, [10, 0, 0], { policy: "overwrite", includeAir: false });
  assert.deepEqual(a.counts, { changed: 2, kept: 0, air: 1, identical: 1 });
  assert.deepEqual(a.writes[0].pos, [9, 64, 0]);
  const b = model.changes(src, dst, tile, [0, 0, 0], { policy: "keep", includeAir: true });
  assert.equal(b.writes.length, 1);
  assert.equal(b.counts.kept, 3);
  const c = model.changes(src, dst, tile, [0, 0, 0], { policy: "overwrite", includeAir: true });
  assert.equal(c.writes.length, 3);
});
test("terrain snapshots preserve source bytes, reject links, and detect corrupt journals", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-terrain-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "source"));
  await fs.writeFile(path.join(root, "source/level.dat"), Buffer.from([0, 1, 255]));
  const result = await copySnapshot(path.join(root, "source"), path.join(root, "copy"));
  assert.equal(result.bytes, 3);
  assert.deepEqual(await fs.readFile(path.join(root, "source/level.dat")), await fs.readFile(path.join(root, "copy/level.dat")));
  const file = await writeData(root, "batch", [stone, air]);
  assert.deepEqual(await readData(root, file), [stone, air]);
  await fs.appendFile(path.join(root, "batch.json.gz"), "tampered");
  await assert.rejects(readData(root, file), /校验/);
  await assert.rejects(readData(root, { name: "../outside", digest: "x" }), /文件名/);
  await fs.symlink(path.join(root, "copy"), path.join(root, "source/link"), "junction");
  await assert.rejects(copySnapshot(path.join(root, "source"), path.join(root, "bad")), /链接/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-terrain-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = { session: { id: "target-session", worldId: "target", running: true } };
  const target = { bridgeId: "bridge", generation: 1, sequence: 1, sessionId: worker.session.id };
  let dimension = 3;
  const actions = {
    worker: () => worker, target: () => target, record: () => ({ busy: false, phase: "idle" }), player: async () => "123",
    code: async () => ({ dimension, position: [0, 64, 0], min: [0, -64, 0], max: [15, 319, 15] }),
  };
  const worlds = { read: async () => ({}), find: () => ({}), inspect: async () => ({ path: root }) };
  const service = new ArchitectureImport({ dataRoot: root, worlds, actions });
  await service.load();
  service.task = { version: 2, id: crypto.randomUUID(), stage: "target-running", targetWorldId: "target", targetSessionId: worker.session.id, backup: { folder: "backup", original: root }, attempted: 0, region: model.region({ x1: -2, y1: 64, z1: 0, x2: -1, y2: 64, z2: 0 }) };
  await fs.mkdir(service.directory(), { recursive: true });
  const tile = { min: [-2, 64, 0], max: [-1, 64, 0], ...await writeData(service.directory(), "source", [stone, air]) };
  service.task.capture = await writeData(service.directory(), "capture", [tile]);
  let blocks = [air, dirt];
  const operations = [];
  service.batch = async (_, data) => {
    service.check();
    operations.push(structuredClone(data));
    if (data.op === "read") return { blocks: structuredClone(blocks) };
    if (data.op === "write") {
      const persisted = JSON.parse(await fs.readFile(service.file, "utf8"));
      assert.equal(persisted.attempted, 1, "write-ahead journal persisted before any game change");
      for (const w of data.writes) blocks[w.pos[0] - 20] = structuredClone(w.after);
    } else for (const w of data.writes) blocks[w.pos[0] - 20] = structuredClone(w.before);
    return { completed: data.writes.length };
  };
  return { service, operations, target, dimension: value => { dimension = value; }, blocks: () => blocks };
}
test("terrain preview binds edited origin/policy and dimension, journals before mutation, then restores only recorded cells", async t => {
  const { service: s, operations, dimension, blocks } = await fixture(t);
  const args = { taskId: s.task.id, targetX: 20, targetY: 64, targetZ: 0, policy: "overwrite", includeAir: true };
  await s.preview(args); await s.job;
  assert.equal(s.task.stage, "preview-ready");
  assert.equal(s.task.plan.counts.changed, 2);
  assert.deepEqual(operations[0].min, [20, 64, 0]);
  dimension(4);
  await assert.rejects(s.targetPaste({ taskId: s.task.id, previewId: s.task.plan.id, confirmed: true }), /维度已变化/);
  dimension(3);
  await assert.rejects(s.targetPaste({ taskId: s.task.id, previewId: "stale", confirmed: true }), /预览/);
  await s.targetPaste({ taskId: s.task.id, previewId: s.task.plan.id, confirmed: true }); await s.job;
  assert.equal(s.task.stage, "done");
  assert.deepEqual(blocks(), [stone, air]);
  await s.revoke({ taskId: s.task.id, confirmed: true }); await s.job;
  assert.equal(s.task.stage, "undone");
  assert.deepEqual(blocks(), [air, dirt]);
});
test("terrain uncertain write stops, preserves journal and never automatically repeats; reopening marks interrupted", async t => {
  const { service: s } = await fixture(t);
  await s.preview({ taskId: s.task.id, targetX: 20, targetY: 64, targetZ: 0, policy: "keep", includeAir: false }); await s.job;
  let calls = 0;
  s.batch = async () => { calls++; throw Error("connection lost after dispatch"); };
  await s.targetPaste({ taskId: s.task.id, previewId: s.task.plan.id, confirmed: true }); await s.job;
  assert.equal(calls, 1);
  assert.equal(s.task.attempted, 1);
  assert.equal(s.task.stage, "interrupted");
  await assert.rejects(s.preview({ taskId: s.task.id }), /撤销/);
  s.task.busy = true; await s.save();
  const reopened = new ArchitectureImport({ dataRoot: path.dirname(s.root) });
  await reopened.load();
  assert.equal(reopened.task.stage, "interrupted");
  assert.equal(reopened.task.attempted, 1);
  assert.equal(calls, 1);
});
test("terrain task can keep snapshots, runs and game logs in an external root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-terrain-external-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-terrain-task-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(external, { recursive: true, force: true })]));
  await fs.writeFile(path.join(root, "level.dat"), levelData("external terrain"));
  const service = new ArchitectureImport({
    dataRoot: root,
    protectedRoots: [root],
    worlds: { store: { project: () => ({ id: "profile", root }) }, read: async () => ({}), find: () => ({ id: "target", profileId: "profile", name: "target" }), inspect: async () => ({ path: root }) },
    sessions: { workers: [] }, profiles: {}, actions: {},
  });
  const planning = { x1: -1, y1: 10, z1: -3, x2: 1, y2: 20, z2: 3, targetX: 100, targetY: 64, targetZ: 100, sourceDimension: 0, targetDimension: 3, policy: "keep", includeAir: false };
  await service.prepare({ kind: "bedrock", source: root, name: "external", targetWorldId: "target", externalDataRoot: external, planning });
  await service.job;
  assert.equal(service.task.stage, "prepared", service.task.error);
  assert.equal(service.task.externalDataRoot, path.resolve(external));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(external, "task.json"), "utf8")).planning, planning);
  assert.equal(path.dirname(service.directory()), path.resolve(external));
  assert.equal(await fs.stat(path.join(external, "task.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(root, "settings.json")).catch(() => null), null);
});
