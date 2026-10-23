const fs = require("node:fs"),
  path = require("node:path");
const config = JSON.parse(fs.readFileSync(".mcdev.json", "utf8"));
require("./menu-bridge.cjs");
if (process.env.DGN_OPTIONS_TEST === "1") {
  const options = fs.readFileSync(
    path.join(
      process.env.DGN_GAME_DATA_DIR,
      "game-data/MinecraftPE_Netease/minecraftpe/options.txt",
    ),
    "utf8",
  );
  if (!options.includes("dev_connection_quality:1"))
    throw Error("game options were not applied before process startup");
}
if (
  config.world_folder_name !== "MENU" &&
  !/^DaGuoNekoGameToolkit\/w_[a-f0-9]{32}$/.test(config.world_folder_name)
)
  throw Error("fixture requires managed world");
const root = path.resolve(
    process.env.APPDATA,
    "MinecraftPE_Netease",
    "minecraftWorlds",
  ),
  world = path.resolve(root, config.world_folder_name);
if (
  !root.startsWith(path.resolve(process.env.DGN_GAME_DATA_DIR) + path.sep) ||
  !world.startsWith(root + path.sep)
)
  throw Error("unsafe fixture world");
fs.mkdirSync(path.join(world, "db"), { recursive: true });
fs.writeFileSync(path.join(world, "level.dat"), "fixture level");
fs.writeFileSync(path.join(world, "db", "progress"), "WORLD_PROGRESS");
console.log(
  config.auto_join_game === false
    ? "MENU_READY " + config.user_name
    : "WORLD_READY " + config.world_name,
);
setInterval(() => {}, 1000);
