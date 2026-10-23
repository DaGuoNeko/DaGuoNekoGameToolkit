const path = require("node:path");
const childProcess = require("node:child_process");

function menuPlayerName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value.trim()].length > 32 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("客户端玩家名应为 1–32 个字符，不能包含控制字符");
  return value.trim();
}
function nativeRequest(file, args) {
  return new Promise((resolve, reject) =>
    childProcess.execFile(
      file,
      args,
      { windowsHide: true, timeout: 45000, maxBuffer: 16384 },
      (error, stdout) => {
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(error || Error("玩家名助手没有返回有效结果"));
          return;
        }
        if (error || result.code !== 0) {
          const detail =
            result.code >= 120
              ? "当前游戏的名称接口与支持的格式不匹配"
              : result.code === 2 || result.code === 4
                ? "游戏进程归属或程序路径校验失败"
                : "无法初始化游戏名称接口";
          reject(Error(`${detail}（${result.code} / ${result.win32}）`));
          return;
        }
        resolve(result);
      },
    ),
  );
}
class MenuName {
  constructor(
    runtimeRoot,
    { request = nativeRequest, timeoutMs = 20000 } = {},
  ) {
    this.helper = path.join(runtimeRoot, "native/menu-name-helper.exe");
    this.library = path.join(runtimeRoot, "native/menu-name.dll");
    this.request = request;
    this.timeoutMs = timeoutMs;
  }
  async apply(bridge, worker, name, root, beforeApply) {
    const expected = menuPlayerName(name),
      registrationId = worker.session?.bridgeRegistrationId;
    if (!bridge || !registrationId)
      throw Error("菜单客户端设置玩家名需要内置启动器的会话连接");
    const session = await new Promise((resolve, reject) => {
      let timer, unsubscribe;
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe?.dispose();
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        if (!worker.session?.running) {
          finish(Error("设置玩家名前游戏已退出"));
          return;
        }
        const current = bridge
          .snapshot()
          .sessions.find(
            (s) => s.registrationId === registrationId && s.connected,
          );
        if (!current) return;
        if (
          current.mcdkPid !== worker.session.pid ||
          typeof current.projectRoot !== "string" ||
          path.resolve(current.projectRoot).toLowerCase() !==
            path.resolve(root).toLowerCase()
        ) {
          finish(Error("客户端会话与当前启动进程不匹配"));
          return;
        }
        if (current.state === "exited" || current.state === "exiting") {
          finish(Error("设置玩家名前客户端已结束"));
          return;
        }
        if (
          Number.isSafeInteger(current.minecraftPid) &&
          current.minecraftPid > 0
        )
          finish(null, current);
      };
      unsubscribe = bridge.server.onDidChange(check);
      timer = setTimeout(
        () => finish(Error("未收到客户端进程信息，请使用内置 MCDK 后重试")),
        this.timeoutMs,
      );
      check();
    });
    if (beforeApply) await beforeApply(session);
    await this.request(this.helper, [
      String(session.minecraftPid),
      String(worker.session.pid),
      worker.sourceSnapshot.config.game_executable_path,
      this.library,
      expected,
    ]);
    if (!worker.session.running) throw Error("设置玩家名期间游戏已退出");
    return { name: expected, pid: session.minecraftPid };
  }
}
module.exports = { MenuName, menuPlayerName };
