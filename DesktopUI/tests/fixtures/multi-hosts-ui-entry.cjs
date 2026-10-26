// UI-only fixture: keep the real Sessions/HostBridge/world routing, replace
// native launch isolation with owned test processes. No Minecraft is started.
const path = require("node:path"),
  Module = require("node:module"),
  cp = require("node:child_process"),
  { promisify } = require("node:util");
const root = process.env.DGN_UI_BUNDLE_DIR || path.resolve(__dirname, "../..");
require("electron").app.setAppPath(root);
if (process.env.DGN_LOCAL_JOIN_PROBE) {
  globalThis.dgnLocalJoinProbe = {
    async create(config) {
      // 仅替代原生入房边界，产品 IPC、主机校验和快照选择仍使用真实实现。
      require("node:fs").writeFileSync(process.env.DGN_LOCAL_JOIN_PROBE, JSON.stringify({world:config.world_name,mods:config.included_mod_dirs}));
      throw Error("测试已确认目标：" + config.world_name);
    },
  };
}
globalThis.dgnTestIsolation = {
  prepare: async (worldId) => {
    let child;
    return {
      roaming: path.join(process.env.DGN_GAME_DATA_DIR, "isolated", worldId),
      actualWorld: path.join(
        process.env.DGN_GAME_DATA_DIR,
        "fixture-worlds",
        worldId,
      ),
      mode: "isolated",
      options: async () => ({ changed: [] }),
      spawn: (exe, args, options) => {
        child = cp.spawn(exe, args, options);
        return child;
      },
      stop: async () => {
        if (child && child.exitCode === null)
          await promisify(cp.execFile)(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true },
          );
      },
    };
  },
};
const entry = path.join(
    root,
    process.env.DGN_UI_BUNDLE_DIR ? "app.asar/dist/main.cjs" : "dist/main.cjs",
  ),
  compile = Module.prototype._compile;
Module.prototype._compile = function (code, file) {
  if (path.resolve(file) === entry) {
    if (process.env.DGN_LOCAL_JOIN_PROBE) {
      const marker = "new ClientJoiner(launcher, debuggerService, runtimeRoot)";
      if (code.split(marker).length !== 2) throw Error("Client join fixture marker changed");
      code = code.replace(marker, "new ClientJoiner(launcher, debuggerService, runtimeRoot, { transport: globalThis.dgnLocalJoinProbe })");
    }
    for (const [marker, replacement] of [
      ["query = queryProcesses,", "query = async () => [],"],
      [
        "new HostIsolation(runtimeRoot, worlds, gameOptions)",
        "globalThis.dgnTestIsolation",
      ],
    ]) {
      if (code.split(marker).length !== 2)
        throw Error("Multi-host fixture marker changed: " + marker);
      code = code.replace(marker, replacement);
    }
  }
  return compile.call(this, code, file);
};
require(entry);
