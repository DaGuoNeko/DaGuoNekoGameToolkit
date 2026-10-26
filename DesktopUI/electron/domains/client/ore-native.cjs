const path = require("node:path"),
  net = require("node:net");
const execFile = require("node:util").promisify(
  require("node:child_process").execFile,
);
const { inspectEngine, profilesForDiscovery } = require("./engine-profiles.cjs");
async function checkEngine(file) {
  const engine = await inspectEngine(file);
  if (!engine.profile?.autoJoin)
    throw Error(
      "当前游戏程序尚未适配原生自动联机；已验证开发版 " +
        profilesForDiscovery()
          .filter((item) => item.autoJoin)
          .map((item) => item.version)
          .join("、") +
        "。请使用已适配版本，或启动普通客户端手动联机。",
    );
  return engine;
}
async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () =>
      resolve({
        port: server.address().port,
        release: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}
async function nativeCall(runtime, worker, pid, operation, exec = execFile) {
  let stdout;
  try {
    ({ stdout } = await exec(
      path.join(runtime, "native/menu-name-helper.exe"),
      [
        String(pid),
        String(worker.session.pid),
        worker.sourceSnapshot.config.game_executable_path,
        path.join(runtime, "native/ore-join.dll"),
        String(operation),
      ],
      { windowsHide: true, timeout: 35000, maxBuffer: 8192 },
    ));
  } catch (e) {
    stdout = e.stdout;
    if (!stdout) throw Error("原生联机助手失败：" + e.message);
  }
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw Error("原生联机助手未返回有效结果");
  }
  if (r.code !== 0) {
    const reason =
      r.code >= 130 && r.code <= 133
        ? "游戏初始化超时，未读取到调试开关"
        : r.code === 2 || r.code === 4
          ? "游戏进程归属或程序路径已变化"
          : "原生接口结构不匹配或安全通道未就绪";
    throw Error(`${reason}（${r.code}/${r.win32}）`);
  }
  return r;
}
async function windowCall(runtime, worker, pid, mode, exec = execFile) {
  let stdout;
  try {
    ({ stdout } = await exec(
      path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(runtime, "automation/ore-window.ps1"),
        "-GameProcessId",
        String(pid),
        "-LauncherProcessId",
        String(worker.session.pid),
        "-GamePath",
        worker.sourceSnapshot.config.game_executable_path,
        "-Mode",
        mode,
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 16000 },
    ));
  } catch (e) {
    stdout = e.stdout;
    if (!stdout) throw Error("游戏窗口检查未完成：" + e.message);
  }
  const r = JSON.parse(stdout);
  if (!r.ok) {
    const e = Error(String(r.error).slice(0, 2000));
    if (e.message.includes("GAME_ASSERT_DIALOG:"))
      e.code = "GAME_ASSERT_DIALOG";
    e.transient = /WINDOW_NOT_READY|WINDOW_RESTORING/.test(e.message);
    throw e;
  }
  return r;
}
module.exports = { checkEngine, reservePort, nativeCall, windowCall };
