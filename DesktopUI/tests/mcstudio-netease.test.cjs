const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listGlobalConfigs, NeteaseConfigs } = require("../electron/domains/game/netease-config.cjs");
const { scanMcStudio, McStudioIndex } = require("../electron/domains/game/mcstudio.cjs");

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

test("netease global config lists player folders and the direct config directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-netease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const users = path.join(root, "MinecraftPE_Netease", "storge", "stream", "users");
  await writeJson(path.join(users, "player", "config", "hud.json"), { data: { on: true } });
  await writeJson(path.join(users, "config", "menu.json"), { data: {} });
  await fs.mkdir(path.join(users, "None"), { recursive: true });
  await fs.writeFile(path.join(users, "None", "skin.txt"), "no");
  const listed = await listGlobalConfigs(root, "测试端", "");
  assert.deepEqual(listed.players.sort(), ["config", "player"]);
  assert.equal(listed.entries.length, 1);
  const configs = new NeteaseConfigs(root);
  const again = await configs.list("正式端", "player");
  assert.equal(again.missing, true);
  assert.equal(configs.known(listed.entries[0].path), false);
  await configs.list("测试端", "player");
  assert.equal(configs.known(path.join(users, "player", "config", "hud.json")), true);
  assert.equal(configs.known(path.join(users, "config", "menu.json")), false);
});

test("netease config edit keeps json valid, backs up, and rejects stale or unlisted files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-netease-edit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const users = path.join(root, "MinecraftPE_Netease", "storge", "stream", "users");
  const file = path.join(users, "player", "config", "hud.json");
  await writeJson(file, { data: { on: true } });
  await fs.writeFile(path.join(users, "player", "config", "note.txt"), "plain");
  const configs = new NeteaseConfigs(root);
  await configs.list("测试端", "player");
  const read = await configs.read(file);
  assert.match(read.text, /\"on\":true/);
  await assert.rejects(configs.save(file, "{ ", read.modified), /有效 JSON/);
  const saved = await configs.save(file, "{\"data\":{\"on\":false}}", read.modified);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).data.on, false);
  assert.equal(JSON.parse(await fs.readFile(file + ".bak", "utf8")).data.on, true);
  await assert.rejects(configs.save(file, "{\"data\":{}}", read.modified), /重新打开/);
  const note = path.join(users, "player", "config", "note.txt");
  const plain = await configs.read(note);
  await configs.save(note, "changed", plain.modified);
  assert.equal(await fs.readFile(note, "utf8"), "changed");
  const again = await configs.list("测试端", "player");
  assert.equal(again.entries.some((item) => item.name.endsWith(".bak")), false);
  await assert.rejects(configs.read(path.join(users, "player", "config", "missing.json")), /不属于当前配置列表/);
  assert.ok(saved.modified);
});

test("mcstudio scan marks test worlds and pack directories without treating the project root as a pack", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dgn-studio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, "local");
  const install = path.join(root, "install");
  const work = path.join(root, "external");
  const world = path.join(root, "roaming", "MinecraftPE_Netease", "minecraftWorlds", "level-1");
  await writeJson(path.join(local, "Netease", "MCStudio", "config", "app", "app.conf"), {
    X64EditorPath: path.join(install, "MCX64Editor", "editor.exe"),
  });
  await writeJson(path.join(install, "work", "account", "Cpp", "AddOn", "project", "work.mcscfg"), {
    Name: "示例项目",
    UID: "project",
    CustomWorkDir: work,
    Preserve: 1,
  });
  await writeJson(path.join(install, "work", "account", "Cpp", "AddOn", "project", "demoB", "pack_manifest.json"), {});
  await writeJson(path.join(work, "modB", "manifest.json"), {});
  await fs.mkdir(world, { recursive: true });
  await fs.writeFile(path.join(world, "level.dat"), "x");
  await fs.writeFile(path.join(world, "levelname.txt"), "测试世界\n");
  await writeJson(path.join(install, "game", "config", "account", "Cpp", "MC_GAME", "save.cppconfig"), {
    MainComponentId: "project",
    world_info: { level_id: "level-1" },
    LocalComponentPathsDict: { project: { work_path: work } },
  });
  await writeJson(path.join(install, "game", "config", "account", "Cpp", "MC_GAME", "bad.cppconfig"), {
    world_info: { level_id: "nested/level" },
  });
  const scanned = await scanMcStudio(local, path.join(root, "roaming"));
  assert.equal(scanned.available, true);
  assert.equal(scanned.worlds.length, 1);
  assert.equal(scanned.worlds[0].name, "测试世界");
  assert.equal(scanned.worlds[0].projectName, "示例项目");
  const importable = scanned.mods.filter((item) => item.importable).map((item) => path.basename(item.directory)).sort();
  assert.deepEqual(importable, ["demoB", "modB"]);
  assert.equal(scanned.mods.find((item) => item.directory === work).importable, false);
  const index = new McStudioIndex(local, path.join(root, "roaming"));
  assert.equal((await index.world(world)).level, "level-1");
  await assert.rejects(index.mod(work), /模组目录已变化/);
  assert.equal((await scanMcStudio(path.join(root, "missing"), path.join(root, "roaming"))).available, false);
});
