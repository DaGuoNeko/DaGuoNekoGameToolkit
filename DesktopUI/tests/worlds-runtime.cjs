// Exercises the bundled MCDK's real nested-world generation with a harmless fake
// game executable and isolated APPDATA. Does not launch Minecraft or use real saves.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-mcdk-world-"));
  try {
    const game = path.join(root, "DgnWorldProbe.exe"),
      source = path.join(root, "Probe.cs");
    await fs.writeFile(
      source,
      'using System;using System.IO;class Probe{static void Main(string[] args){File.WriteAllLines("game-arguments.txt",args);Console.WriteLine("PROBE_GAME_EXIT");}}',
    );
    const compiled = spawnSync(
      path.join(
        process.env.WINDIR,
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      ),
      ["/nologo", "/target:exe", "/out:" + game, source],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const folder = "DaGuoNekoGameToolkit/w_0123456789abcdef0123456789abcdef";
    const roaming = path.join(root, "Roaming"),
      local = path.join(root, "Local");
    await fs.mkdir(roaming);
    await fs.mkdir(local);
    await fs.writeFile(
      path.join(root, ".mcdev.json"),
      JSON.stringify({
        game_executable_path: game,
        included_mod_dirs: [],
        include_debug_mod: false,
        world_name: "Nested world probe",
        world_folder_name: folder,
        world_source_path: null,
        reset_world: false,
        auto_join_game: true,
        log_protocol: 0,
      }),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.toUpperCase().startsWith("MCDEV_"),
      ),
    );
    Object.assign(env, {
      APPDATA: roaming,
      LOCALAPPDATA: local,
      MCDEV_IS_PLUGIN_ENV: "1",
      MCDEV_OUTPUT_MODE: "1",
      MCDEV_IS_SUBPROCESS_MODE: "0",
    });
    const run = spawnSync(path.resolve("runtime/mcdk.exe"), [], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(
      run.status,
      0,
      (run.error?.message || "") + run.stdout + run.stderr,
    );
    const world = path.join(
      roaming,
      "MinecraftPE_Netease/minecraftWorlds",
      folder,
    );
    const level = await fs.readFile(path.join(world, "level.dat"));
    assert.ok(level.length > 8);
    assert.equal(level.readUInt32LE(4), level.length - 8);
    const info = require("../electron/world-info.cjs").readWorldInfo(level);
    assert.equal(info.gameMode, 1);
    assert.equal(info.worldType, 1);
    const cpp = JSON.parse(
      await fs.readFile(path.join(world, "dev_config.cppconfig"), "utf8"),
    );
    assert.equal(cpp.world_info.level_id, folder);
    assert.match(
      await fs.readFile(path.join(root, "game-arguments.txt"), "utf8"),
      /DaGuoNekoGameToolkit/,
    );
    // A second launch keeps an existing world's database contents.
    await fs.mkdir(path.join(world, "db"));
    await fs.writeFile(path.join(world, "db", "progress"), "PRESERVE");
    const again = spawnSync(path.resolve("runtime/mcdk.exe"), [], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(
      await fs.readFile(path.join(world, "db", "progress"), "utf8"),
      "PRESERVE",
    );
    const menuData = path.join(root, "menu-roaming");
    await fs.mkdir(menuData);
    const menuConfig = JSON.parse(
      await fs.readFile(path.join(root, ".mcdev.json"), "utf8"),
    );
    menuConfig.auto_join_game = false;
    menuConfig.world_folder_name = "MENU";
    await fs.writeFile(
      path.join(root, ".mcdev.json"),
      JSON.stringify(menuConfig),
    );
    const menu = spawnSync(path.resolve("runtime/mcdk.exe"), [], {
      cwd: root,
      env: { ...env, APPDATA: menuData },
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(menu.status, 0, menu.stdout + menu.stderr);
    assert.ok(
      !(
        await fs.readFile(path.join(root, "game-arguments.txt"), "utf8")
      ).includes("config="),
    );
    assert.equal(
      await fs.readFile(path.join(world, "db", "progress"), "utf8"),
      "PRESERVE",
    );
    console.log(
      "PASS bundled MCDK: nested save path, real level.dat and dev_config generation, passed game argument, retained progress on relaunch (fake game, isolated APPDATA)",
    );
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("dgn-mcdk-world-"));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
