const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { HostIsolation } = require("../electron/host-isolation.cjs");
const { GameOptions } = require("../electron/domains/game/game-options.cjs");
test("an auto-join entry without isolation capability cannot reserve or create private guest data", { skip: process.platform !== "win32" }, async () => {
  const runtime = path.resolve("runtime");
  const isolation = new HostIsolation(runtime, null, null, {
    reserve: async () => { assert.fail("unverified isolation must not reserve a process group"); },
  });
  for (const digest of ["9be281dbe08bc591336680d5a50f94d87f3c57ee75b3afcb3cabdf03347e0269", "unknown"]) {
    isolation.digest = async () => digest;
    assert.equal(await isolation.prepareClient("unused", { game_executable_path: "unused" }, path.join(runtime, "mcdk.exe")), null);
  }
});
test(
  "joined clients get separate known-folder roots and private OreUI options without mounting host worlds",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.homedir(), "dgn-client-test-"));
    t.after(async () => {
      assert.equal(path.dirname(root), path.resolve(os.homedir()));
      assert(path.basename(root).startsWith("dgn-client-test-"));
      assert.equal(await fs.realpath(root), root);
      await fs.rm(root, { recursive: true, force: true });
    });
    const runtime = path.join(root, "runtime"),
      launcher = path.join(runtime, "mcdk.exe"),
      shared = path.join(root, "options.txt"),
      config = { game_executable_path: path.join(root, "game.exe") };
    const original = "new_play_screen_beta_v2:0\nunknown:KEEP\n";
    await fs.writeFile(shared, original);
    const launches = [],
      leases = [];
    const isolation = new HostIsolation(
      runtime,
      null,
      new GameOptions(root, shared, { isRunning: async () => true }),
      {
        base: root,
        reserve: async (runtime, lock, worldLock) => {
          assert.equal(worldLock, null);
          const lease = {
            stop: async () => {
              lease.stopped = true;
            },
            spawn: async (exe, opts) => {
              launches.push(opts);
              return {};
            },
          };
          leases.push(lease);
          return lease;
        },
      },
    );
    let gameHash;
    isolation.digest = async (file) =>
      file === launcher
        ? "2cd4348c05a1b3855f4397526a9c4c3deea359d2e57f07a61e2669bd5b47349b"
        : gameHash;
    const clients = [];
    for (const name of ["a", "b"]) {
      gameHash = name === "a"
        ? "489a164d5f37048fcebf941bfefba4a50ee0dabfbb7f2f2169c09600b2a4579c"
        : "248421df4f3eb4fe1a232887385e0adebca2d545d5958d728b18585658c339d5";
      const run = path.join(root, name),
        client = await isolation.prepareClient(run, config, launcher);
      clients.push(client);
      await client.options();
      await client.spawn(launcher, [], {
        cwd: run,
        env: { DGN_WORLD_VIEW: "STALE" },
      });
      const options = await fs.readFile(
        path.join(
          client.roaming,
          "MinecraftPE_Netease/minecraftpe/options.txt",
        ),
        "utf8",
      );
      assert.match(options, /new_play_screen_beta_v2:1/);
      assert.match(options, /unknown:KEEP/);
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(client.roaming, ".dgn-owner.json"),
            "utf8",
          ),
        ).run,
        run,
      );
    }
    assert.notEqual(clients[0].roaming, clients[1].roaming);
    assert.notEqual(launches[0].env.LOCALAPPDATA, launches[1].env.LOCALAPPDATA);
    assert.equal(launches[0].env.DGN_WORLD_VIEW, "");
    assert.equal(launches[0].env.APPDATA, clients[0].roaming);
    assert.equal(await fs.readFile(shared, "utf8"), original);
    gameHash = "489a164d5f37048fcebf941bfefba4a50ee0dabfbb7f2f2169c09600b2a4579c";
    await assert.rejects(
      clients[1].spawn(launcher, [], { cwd: root, env: {} }),
      /游戏或启动器已变化/,
    );
    gameHash = "248421df4f3eb4fe1a232887385e0adebca2d545d5958d728b18585658c339d5";
    await assert.rejects(
      isolation.prepareClient(path.join(root, "a"), config, launcher),
      /已存在/,
    );
    assert(leases[2].stopped);
    await clients[0].stop();
    assert(!leases[1].stopped);
    await clients[1].stop();
  },
);
