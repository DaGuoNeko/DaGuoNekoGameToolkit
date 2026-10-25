// 显式指定真实开发版游戏与官方 Chunker JAR；只使用本脚本新建的隔离存档。
const fs = require("node:fs/promises"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { _electron: electron } = require("playwright");
const { WorkspaceStore } = require("../electron/services.cjs");
const { Profiles } = require("../electron/domains/profiles/profiles.cjs");
const { WorldLibrary } = require("../electron/domains/worlds/worlds.cjs");
const runtime = require("../electron/domains/worlds/terrain-runtime.cjs");
const { copySnapshot } = require("../electron/domains/worlds/terrain-storage.cjs");
const { equal } = require("../shared/terrain-model.cjs");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const game = process.env.DGN_TERRAIN_GAME_EXE, jar = process.env.DGN_CHUNKER_JAR;
if (!game || !jar) throw Error("需要 DGN_TERRAIN_GAME_EXE 和 DGN_CHUNKER_JAR；此测试不会使用真实业务地图");

(async () => {
  const root = path.resolve("../.miao/test-data/terrain-e2e-" + Date.now());
  const store = new WorkspaceStore(root);
  await store.load();
  const profiles = new Profiles(store); await profiles.initialize();
  await store.updateSettings({ GamePath: game, IndependentWorlds: true });
  const fixtureMod = path.join(root, "dimension-fixture");
  await fs.mkdir(path.join(fixtureMod, "dgnTerrainFixture"), { recursive: true });
  await fs.writeFile(path.join(fixtureMod, "manifest.json"), JSON.stringify({ format_version: 1, header: { name: "Terrain acceptance dimension", uuid: "2f0a3e86-c7e8-4ee4-ab54-b547e898c0f3", version: [1,0,0] }, modules: [{ type: "data", uuid: "7e4ec2bb-30af-4eea-ae64-e9fe577811fd", version: [1,0,0] }] }));
  await fs.writeFile(path.join(fixtureMod, "dgnTerrainFixture/__init__.py"), "");
  await fs.writeFile(path.join(fixtureMod, "dgnTerrainFixture/modMain.py"), "from mod.common.mod import Mod\nimport mod.server.extraServerApi as api\n@Mod.Binding(name='dgnTerrainFixture',version='1.0')\nclass Fixture(object):\n @Mod.InitServer()\n def server(self):\n  api.RegisterSystem('dgnTerrainFixture','fixture','dgnTerrainFixture.server.Fixture')\n");
  await fs.writeFile(path.join(fixtureMod, "dgnTerrainFixture/server.py"), "import mod.server.extraServerApi as api\nclass Fixture(api.GetServerSystemCls()):\n def __init__(self,namespace,systemname):\n  super(Fixture,self).__init__(namespace,systemname)\n  self.created=api.GetEngineCompFactory().CreateDimension(api.GetLevelId()).CreateDimension(3)\n");
  const profile = await profiles.read(store.value.projects[0].id);
  await profiles.save(profile.project.id, profile.revision, { included_mod_dirs: [fixtureMod], user_name: "TerrainAcceptance", auto_hot_reload_mods: false });
  const worlds = new WorldLibrary(store, path.join(root, "game-data/MinecraftPE_Netease/minecraftWorlds"));
  const world = await worlds.create(profile.project.id, { name: "Terrain acceptance target" });
  let app, ipc, sessionId, target;
  const checks = [];
  try {
    app = await electron.launch({ args: [process.cwd()], env: { ...process.env, DGN_GAME_DATA_DIR: root, DGN_GAME_HEADLESS: "1" } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.toolkit);
    ipc = (method, args = {}) => page.evaluate(({ method, args }) => window.toolkit.call(method, args), { method, args });
    async function ready(worldId) {
      for (let i = 0; i < 120; i++) {
        const state = await ipc("world-actions.state", { worldId });
        const debug = await ipc("debug.state");
        const b = debug.sessions.find(b => b.id === state.target?.bridgeId && b.state === "game_ready");
        if (b) {
          const probe = await ipc("debug.execute", { sessionId: b.id, generation: b.connectionGeneration, isClient: false, code: "import mod.server.extraServerApi as api\n_ps=api.GetPlayerList()\n_result={'position':api.GetEngineCompFactory().CreatePos(_ps[0]).GetFootPos() if _ps else None}" });
          if (probe.position && probe.position[1] < 1000) { target = b; return; }
        }
        await sleep(1000);
      }
      throw Error("test game readiness timeout");
    }
    const execute = code => ipc("debug.execute", { sessionId: target.id, generation: target.connectionGeneration, code, isClient: false });
    async function batch(data) {
      let player;
      for (let i = 0; i < 30; i++) {
        player = await execute("import mod.server.extraServerApi as api\n_result=str(api.GetPlayerList()[0]) if api.GetPlayerList() else ''");
        if (player) break;
        await sleep(1000);
      }
      if (!player) throw Error("test player not ready");
      const id = require("node:crypto").randomUUID();
      await execute(runtime.startCode({ ...data, id, player }));
      for (let i = 0; i < 500; i++) {
        const result = await execute(runtime.statusCode(id));
        if (result.phase === "done") return result;
        if (result.phase === "error") throw Error(JSON.stringify(result));
        await sleep(100);
      }
      throw Error("fixture batch timeout");
    }
    async function settled(expected) {
      for (let i = 0; i < 900; i++) {
        const task = await ipc("architecture.state");
        if (!task.busy) {
          if (task.stage === "interrupted" && expected === "done") {
            const mismatch = await execute("_result={'actual':_dgn_terrain_batch.read((103,100,100)),'expected':[w for w in _dgn_terrain_batch.data.get('writes',[]) if w['pos']==[103,100,100]]}");
            console.log('fixture mismatch='+JSON.stringify(mismatch));
          }
          assert.equal(task.stage, expected, JSON.stringify(task));
          return task;
        }
        if (i % 15 === 0) console.log(task.stage + " " + JSON.stringify(task.progress));
        await sleep(1000);
      }
      throw Error("terrain operation timeout");
    }
    sessionId = (await ipc("launch.start", { profileId: profile.project.id, worldId: world.id })).selectedSession;
    await ready(world.id);
    const tile = { min: [-1, 100, 0], max: [2, 100, 0], dimension: 0 };
    const initial = (await batch({ op: "read", ...tile })).blocks;
    const stone = { name: "minecraft:stone", states: {}, entity: null };
    const air = { name: "minecraft:air", states: {}, entity: null };
    const stairs = { name: "minecraft:oak_stairs", states: { upside_down_bit: true, weirdo_direction: 2 }, entity: null };
    const desired = [stone, air, stairs, stone];
    await batch({ op: "write", ...tile, writes: desired.map((after, i) => ({ pos: [i - 1, 100, 0], before: initial[i], after })) });
    const readback = (await batch({ op: "read", ...tile })).blocks;
    console.log('readback=' + JSON.stringify(readback));
    assert(equal(readback, desired));
    checks.push("real-block-read-write-stair-state-negative-coordinates");
    await sleep(15000);
    await ipc("launch.stop", { sessionId }); sessionId = null;
    const java = path.join(root, "java-fixture");
    await require("./fixtures/java-world.cjs").javaWorld(java);
    console.log("Java Anvil fixture created with explicit blocks across negative chunk boundary");
    const sourceHash = require("node:crypto").createHash("sha256").update(await fs.readFile(path.join(java, "level.dat"))).digest("hex");
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, java);
    await ipc("worlds.pick-import", {});
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, jar);
    await ipc("architecture.pick-chunker");
    await ipc("architecture.prepare", { kind: "java", source: java, chunkerJar: jar, targetWorldId: world.id, name: "Java terrain acceptance" });
    let task = await settled("prepared");
    const args = { taskId: task.id };
    assert.equal(require("node:crypto").createHash("sha256").update(await fs.readFile(path.join(java, "level.dat"))).digest("hex"), sourceHash);
    await ipc("architecture.start-source", args); task = await settled("source-running"); sessionId = task.sourceSessionId;
    await ready(task.sourceWorldId);
    await ipc("architecture.save-source", { ...args, x1: -1, y1: 100, z1: 0, x2: 4, y2: 100, z2: 0 });
    task = await settled("source-ready");
    assert.equal(task.region.volume, 6);
    await ipc("architecture.source-done", args); await settled("source-saved"); sessionId = null;
    await ipc("architecture.start-target", args); task = await settled("target-running"); sessionId = task.targetSessionId;
    await ready(world.id);
    await batch({ op: "read", min: [100,100,100], max: [103,100,100], dimension: 0 });
    const dim = await execute("import mod.server.extraServerApi as api\nf=api.GetEngineCompFactory()\np=str(api.GetPlayerList()[0])\ns=api.GetSystem('dgnTerrainFixture','fixture')\n_result={'created':s.created if s else None,'pos':f.CreatePos(p).GetFootPos(),'move':f.CreateDimension(p).ChangePlayerDimension(3,(100,110,100))}");
    console.log('dimension probe='+JSON.stringify(dim));
    assert.equal(dim.move, true);
    for (let i = 0; i < 60; i++) {
      const where = await ipc("architecture.position", { ...args, which: "target" });
      if (where.dimension === 3) break;
      await sleep(1000);
    }
    const targetTile = { min: [100, 100, 100], max: [105, 100, 100], dimension: 3 };
    const baseline = (await batch({ op: "read", ...targetTile })).blocks;
    const targetInitial = [stone, stone, air, air, air, air];
    await batch({ op: "write", ...targetTile, writes: targetInitial.map((after, i) => ({ pos: [100 + i, 100, 100], before: baseline[i], after })) });
    await ipc("architecture.preview", { ...args, targetX: 100, targetY: 100, targetZ: 100, policy: "keep", includeAir: false });
    task = await settled("preview-ready");
    assert.equal(task.plan.dimension, 3);
    assert.equal(task.plan.counts.kept, 1);
    assert.equal(task.plan.counts.air, 1);
    assert.equal(task.plan.counts.changed, 4);
    await ipc("architecture.paste", { ...args, previewId: task.plan.id, confirmed: true }); task = await settled("done");
    const transferred = (await batch({ op: "read", ...targetTile })).blocks;
    assert.deepEqual(transferred.map(b=>b.name), ["minecraft:stone","minecraft:stone","minecraft:oak_stairs","minecraft:chest","minecraft:oak_stairs","minecraft:water"]);
    assert.match(JSON.stringify(transferred[3].entity), /minecraft:diamond/);
    assert.equal(transferred[4].name, "minecraft:oak_stairs");
    const warning = (await ipc("architecture.state")).warnings || [];
    assert(warning.some(w => /含水/.test(w)), "waterlogged limitation should be explicit");
    checks.push("java-to-bedrock-current-IPC-custom-dimension-keep-readback");
    await ipc("architecture.revoke", { ...args, confirmed: true }); await settled("undone");
    const undoneNames = (await batch({ op: "read", ...targetTile })).blocks.map(b => b.name);
    assert.deepEqual(undoneNames, ["minecraft:stone","minecraft:stone","minecraft:air","minecraft:air","minecraft:water","minecraft:air"]);
    await ipc("architecture.preview", { ...args, targetX: 100, targetY: 100, targetZ: 100, policy: "overwrite", includeAir: true });
    task = await settled("preview-ready");
    assert.equal(task.plan.counts.changed, 5);
    await ipc("architecture.paste", { ...args, previewId: task.plan.id, confirmed: true }); await settled("done");
    const finalBlocks = (await batch({ op: "read", ...targetTile })).blocks;
    assert.equal(finalBlocks[1].name, "minecraft:air");
    assert(equal(finalBlocks.slice(2), transferred.slice(2)));
    checks.push("chest-items-waterlogged-stairs-and-custom-dimension-readback");
    await ipc("architecture.revoke", { ...args, confirmed: true }); await settled("undone");
    checks.push("overwrite-including-air-undo-preserves-unrelated-world");
    await fs.mkdir("test-results", { recursive: true });
    await fs.writeFile("test-results/terrain-live.json", JSON.stringify({ passed: true, checks, root, task: task.id }, null, 2));
    console.log("PASS " + checks.join("; "));
  } finally {
    if (app) {
      if (sessionId) await ipc("launch.stop", { sessionId });
      await app.close();
    }
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
