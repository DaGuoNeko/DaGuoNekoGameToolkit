const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const {
  GameProcesses,
  developmentBuild,
  queryProcesses,
} = require("../electron/domains/game/game-processes.cjs");
const { GameOptions } = require("../electron/domains/game/game-options.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-process-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("dgn-process-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const dev = path.join(root, "development/Minecraft.Windows.exe"),
    retail = path.join(root, "MCBedrock/Minecraft.Windows.exe");
  for (const file of [dev, retail]) {
    await fs.mkdir(path.join(path.dirname(file), "data"), { recursive: true });
    await fs.writeFile(file, "fixture");
  }
  await fs.writeFile(
    path.join(path.dirname(dev), "data/client_cfg.json"),
    '{"no_launch_mcp":0, // dev\n "count_script_raw_memory":1}',
  );
  await fs.writeFile(
    path.join(path.dirname(retail), "data/client_cfg.json"),
    '{"no_launch_mcp":1}',
  );
  return { root, dev, retail };
}
test("same-named retail process does not block a developer EXE, but exact configured paths still do", async (t) => {
  const { dev, retail } = await fixture(t);
  let rows = [{ pid: 1, name: "Minecraft.Windows.exe", path: retail }];
  const guard = new GameProcesses({
    paths: async () => [dev],
    query: async () => rows,
  });
  assert.deepEqual(await guard.pids(dev), []);
  assert.equal(await guard.any(), false);
  assert.deepEqual(await guard.pids(retail), [1]); // Deliberately selecting that same retail EXE is a conflict.
  rows.push({
    pid: 2,
    name: "Minecraft.Windows.exe",
    path: dev.toUpperCase().replaceAll("\\", "/"),
  });
  assert.deepEqual(await guard.pids(dev), [2]);
  assert.equal(await guard.any(), true);
});
test("other development versions and moved script builds still protect shared test data; uninspectable paths fail explicitly", async (t) => {
  const { dev } = await fixture(t);
  assert(await developmentBuild(dev));
  const rows = [
    { pid: 2, name: "Minecraft.Windows.exe", path: dev },
    {
      pid: 3,
      name: "Minecraft.Windows.exe",
      path: "D:\\MCStudioDownload\\game\\MinecraftPE_Netease\\3.9.0.1\\Minecraft.Windows.exe",
    },
  ];
  const guard = new GameProcesses({ query: async () => rows });
  assert.deepEqual(
    await guard.pids("D:\\selected\\Minecraft.Windows.exe"),
    [2, 3],
  );
  rows.push({ pid: 4, name: "Minecraft.Windows.exe", path: null });
  await assert.rejects(guard.any(), /PID 4.*程序路径/);
  await assert.rejects(guard.pids("Minecraft.Windows.exe"), /完整路径/);
});

test("only positively identified other Windows users are excluded from per-user save conflicts", async (t) => {
  const { dev } = await fixture(t),
    currentSid = "S-1-5-21-123-1001",
    other = "S-1-5-21-123-1002";
  let rows = [
    {
      pid: 1,
      name: "Minecraft.Windows.exe",
      path: dev,
      currentSid,
      ownerSid: other,
    },
  ];
  const guard = new GameProcesses({ query: async () => rows });
  assert.equal(await guard.any(), false);
  rows[0].ownerSid = currentSid;
  assert.equal(await guard.any(), true);
  rows[0].ownerSid = null;
  rows[0].path = null;
  await assert.rejects(guard.any(), /程序路径/);
});
test("retail allows isolated options application; a newly started developer blocks the second write check", async (t) => {
  const { root, dev, retail } = await fixture(t);
  const options = path.join(root, "options.txt");
  await fs.writeFile(options, "dev_connection_quality:0\n");
  let reads = 0,
    block = false;
  const guard = new GameProcesses({
    paths: async () => [dev],
    query: async () => {
      reads++;
      return [
        { pid: 1, name: "Minecraft.Windows.exe", path: retail },
        ...(block && reads >= 2
          ? [{ pid: 2, name: "Minecraft.Windows.exe", path: dev }]
          : []),
      ];
    },
  });
  const service = new GameOptions(path.join(root, "data"), options, {
    isRunning: () => guard.any(),
  });
  await service.save(null, { dev_connection_quality: "1" });
  await service.prepare();
  assert.match(await fs.readFile(options, "utf8"), /quality:1/);
  await fs.writeFile(options, "dev_connection_quality:0\n");
  block = true;
  reads = 0;
  await assert.rejects(service.prepare(), /测试端已开始运行/);
  assert.equal(
    await fs.readFile(options, "utf8"),
    "dev_connection_quality:0\n",
  );
});
test(
  "Windows process inventory returns executable identity, not command-line arguments",
  { skip: process.platform !== "win32" },
  async () => {
    const own = (await queryProcesses([path.basename(process.execPath)])).find(
      (p) => p.pid === process.pid,
    );
    assert(own);
    assert.equal(own.path.toLowerCase(), process.execPath.toLowerCase());
    assert.deepEqual(Object.keys(own).sort(), [
      "currentSid",
      "name",
      "ownerSid",
      "path",
      "pid",
    ]);
    assert.match(own.ownerSid, /^S-\d-/);
    assert.equal(own.ownerSid, own.currentSid);
  },
);
