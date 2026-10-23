// Real-game harness: Windows native known-folder lookup ignores APPDATA for
// world storage. Keep the toolbox index isolated, use unique test world IDs in
// the native world directory. No game, network, PID or debug APIs are mocked.
const path = require("node:path"),
  Module = require("node:module");
const root = path.resolve(__dirname, "../..");
require("electron").app.setAppPath(root);
const entry = path.join(root, "dist/main.cjs"),
  original = Module.prototype._compile;
Module.prototype._compile = function (code, file) {
  if (path.resolve(file) === entry) {
    const marker = "await worlds.migrateProfiles();";
    if (code.split(marker).length !== 2)
      throw Error("Real test world initialization marker changed");
    code = code.replace(
      marker,
      `worlds.worldsRoot = path.join(process.env.APPDATA, 'MinecraftPE_Netease', 'minecraftWorlds'); worlds.root = path.join(worlds.worldsRoot, 'DaGuoNekoGameToolkit'); worlds.file = path.join(dataRoot, 'real-test-worlds.json'); worlds.appDataOverride = null; ${marker}`,
    );
  }
  return original.call(this, code, file);
};
require(entry);
