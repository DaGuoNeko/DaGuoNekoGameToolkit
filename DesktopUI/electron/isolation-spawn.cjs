const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const net = require("node:net"),
  crypto = require("node:crypto"),
  path = require("node:path");
async function pipe(name, output, sockets) {
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.pipe(output, { end: false });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, resolve);
  });
  return server;
}
async function reserveIsolation(runtime, lockName, worldLock) {
  const entry = path.join(__dirname, "isolation-worker.cjs");
  const helper = process.versions.electron
    ? require("electron").utilityProcess.fork(entry, [], {
        stdio: "ignore",
        serviceName: "DGN Isolated World",
      })
    : require("node:child_process").fork(entry, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
  const send = (value) =>
    helper.postMessage ? helper.postMessage(value) : helper.send(value);
  let child,
    ended = false,
    lastError = "",
    reserve,
    startup,
    servers = [],
    sockets = new Set(),
    launchCalled = false;
  const reserved = new Promise((resolve, reject) => {
    reserve = { resolve, reject };
  });
  let complete;
  const completion = new Promise((resolve) => {
    complete = resolve;
  });
  const deadline = setTimeout(() => helper.kill(), 45000);
  function close(code, error) {
    if (ended) return;
    ended = true;
    lastError = error || "隔离服务已退出";
    clearTimeout(deadline);
    reserve.reject(Error(lastError));
    startup?.reject(Error(lastError));
    for (const s of servers) s.close();
    setTimeout(() => {
      for (const s of sockets) s.destroy();
      if (child) {
        child.exitCode = code ?? -1;
        child.stdout.end();
        child.stderr.end();
        if (error) child.emit("error", Error(error));
        child.emit("close", code);
      }
      complete();
    }, 100);
  }
  helper.on("message", (message) => {
    if (message.type === "reserved") {
      clearTimeout(deadline);
      reserve.resolve();
    } else if (message.type === "ready") {
      child.pid = message.pid;
      startup.resolve(child);
    } else if (message.type === "spawn") child.emit("spawn");
    else if (message.type === "exit") close(message.code, message.error);
  });
  helper.on("error", (e) => close(-1, e.message || "隔离服务启动失败"));
  helper.on("exit", (code) => {
    if (!ended) close(code, "隔离服务异常结束");
  });
  const stop = async () => {
    if (!ended) send({ type: "stop" });
    let timeout;
    try {
      await Promise.race([
        completion,
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            helper.kill();
            resolve();
          }, 35000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  helper.once("spawn", () =>
    send({ type: "init", runtime, lockName, worldLock, ownerPid: process.pid }),
  );
  await reserved;
  return {
    helperPid: helper.pid,
    abort: () => helper.kill(),
    stop,
    async spawn(exe, options) {
      if (ended) throw Error(lastError);
      if (launchCalled) throw Error("隔离启动不可重复调用");
      launchCalled = true;
      child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.on("error", () => {});
      const nonce = crypto.randomUUID(),
        outPipe = "\\\\.\\pipe\\dgn-isolation-" + nonce + "-out",
        errPipe = outPipe + "-err";
      const ready = new Promise((resolve, reject) => {
        startup = { resolve, reject };
      });
      try {
        servers.push(await pipe(outPipe, child.stdout, sockets));
        servers.push(await pipe(errPipe, child.stderr, sockets));
        if (ended) throw Error(lastError);
        child.start = () => send({ type: "resume" });
        child.stop = stop;
        send({ type: "launch", exe, ...options, outPipe, errPipe });
        return await ready;
      } catch (e) {
        await stop();
        throw e;
      }
    },
  };
}
async function spawnIsolated(runtime, exe, options) {
  const lease = await reserveIsolation(
    runtime,
    "Local\\DgnHost-" +
      crypto.createHash("sha256").update(options.cwd).digest("hex"),
    null,
  );
  return lease.spawn(exe, options);
}
module.exports = { reserveIsolation, spawnIsolated };
