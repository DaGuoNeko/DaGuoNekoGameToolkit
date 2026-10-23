// A separate utility process owns every native handle. If it dies, Windows
// closes the kill-on-close Job and terminates only this launch's descendants.
const path = require("node:path");
const { environmentBlock } = require("./isolation-environment.cjs");
const port = process.parentPort;
const send = (value) =>
  port ? port.postMessage(value) : process.send?.(value);
const listen = (fn) =>
  port ? port.on("message", (e) => fn(e.data)) : process.on("message", fn);
let api,
  kernel,
  info = {},
  mutex,
  owner,
  timer,
  deadline,
  initialized = false,
  finished = false;
function finish(code = 0, error) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(deadline);
  if (info.process) api.close(info);
  if (mutex) api.release(mutex);
  if (owner) kernel.close(owner);
  send({ type: "exit", code, error });
  setTimeout(() => process.exit(0), 100);
}
listen((message) => {
  if (finished) return;
  try {
    if (message.type === "init") {
      if (initialized) throw Error("重复初始化隔离服务");
      initialized = true;
      const { runtime, lockName, worldLock, ownerPid } = message;
      const koffi = require(path.join(runtime, "native/koffi.node"));
      const lib = koffi.load(
        path.join(runtime, "native/dgn-host-isolation.dll"),
      );
      if(lib.func("DgnIsolationVersion","uint32_t",[])()!==1)throw Error("独立主机运行库版本不匹配，请完整解压新版工具箱");
      const Process = koffi.struct("DgnProcess", {
        process: "void *",
        thread: "void *",
        job: "void *",
        gate: "void *",
        pid: "uint32_t",
        error: "uint32_t",
      });
      api = {
        spawn: lib.func("DgnSpawn", "bool", [
          "str16",
          "str16",
          "void *",
          "str16",
          "str16",
          koffi.out(koffi.pointer(Process)),
        ]),
        resume: lib.func("DgnResume", "bool", [koffi.pointer(Process)]),
        poll: lib.func("DgnPoll", "bool", [
          koffi.pointer(Process),
          koffi.out(koffi.pointer("uint32_t")),
        ]),
        close: lib.func("DgnClose", "void", [koffi.pointer(Process)]),
        acquire: lib.func("DgnAcquire", "void *", ["str16"]),
        release: lib.func("DgnRelease", "void", ["void *"]),
        free: lib.func("DgnWorldFree", "bool", ["str16"]),
      };
      const k32 = koffi.load("kernel32.dll");
      kernel = {
        open: k32.func("OpenProcess", "void *", [
          "uint32_t",
          "bool",
          "uint32_t",
        ]),
        wait: k32.func("WaitForSingleObject", "uint32_t", [
          "void *",
          "uint32_t",
        ]),
        close: k32.func("CloseHandle", "bool", ["void *"]),
      };
      owner = kernel.open(0x100000, false, ownerPid);
      if (!owner) throw Error("无法确认工具箱进程身份");
      mutex = api.acquire(lockName);
      if (!mutex)
        throw Error(
          "此存档已有主机运行，或上次隔离进程异常退出，请确认旧游戏已结束后重试",
        );
      if (worldLock && !api.free(worldLock))
        throw Error("此存档仍被其他游戏占用，请先在该游戏中保存并退出");
      deadline = setTimeout(() => finish(-1, "隔离启动准备超时"), 120000);
      timer = setInterval(() => {
        try {
          if (kernel.wait(owner, 0) !== 0x102)
            return finish(-1, "工具箱已退出");
          if (info.process) {
            const code = [0];
            if (api.poll(info, code)) finish(code[0]);
          }
        } catch (e) {
          finish(-1, e.message);
        }
      }, 100);
      send({ type: "reserved" });
    } else if (message.type === "launch") {
      if (!api || info.process) throw Error("无效隔离启动状态");
      const env = environmentBlock(message.env);
      if (
        !api.spawn(
          message.exe,
          message.cwd,
          env,
          message.outPipe,
          message.errPipe,
          info,
        )
      )
        throw Error("无法创建隔离启动器，Windows 错误 " + info.error);
      send({ type: "ready", pid: info.pid });
    } else if (message.type === "resume") {
      if (!info.process || !api.resume(info)) throw Error("无法恢复隔离启动器");
      clearTimeout(deadline);
      send({ type: "spawn" });
    } else if (message.type === "stop") finish(1);
  } catch (e) {
    finish(-1, e.message);
  }
});
if (!port) process.on("disconnect", () => finish(-1, "工具箱连接已断开"));
setTimeout(() => {
  if (!initialized) process.exit(1);
}, 15000).unref();
