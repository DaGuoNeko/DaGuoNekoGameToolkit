const net = require("node:net"),
  crypto = require("node:crypto");
if (process.env.DGN_NATIVE_LOG_FIXTURE === "1") {
  const fs = require("node:fs"),
    path = require("node:path");
  const directory = path.join(
    process.env.APPDATA,
    "MinecraftPE_Netease",
    "logs",
  );
  fs.mkdirSync(directory, { recursive: true });
  const content = fs.openSync(
    path.join(directory, `ContentLog2026-10-13_09-00-00_${process.pid}.txt`),
    "a",
  );
  const engine = fs.openSync(
    path.join(directory, `Debug_Log2026-10-13_09-00-00_${process.pid}.txt`),
    "a",
  );
  fs.writeSync(
    content,
    `09:00:01[Json][error]-NATIVE_CONTENT ${process.pid} 中文\n`,
  );
  fs.writeSync(
    engine,
    `[2026-10-13 09:00:01:001 INFO PLATFORM] NATIVE_ENGINE ${process.pid}\n`,
  );
  let sent = false;
  setInterval(() => {
    if (
      !sent &&
      fs.existsSync(path.join(process.cwd(), "native-tail.fixture"))
    ) {
      sent = true;
      fs.writeSync(
        content,
        `09:00:02[Json][inform]-NATIVE_TAIL ${process.pid}\n`,
      );
    }
  }, 100).unref();
}
const {
  HostBridgeFrameDecoder,
  encodeHostBridgeFrame,
} = require("../../electron/debug/vendor/protocol.cjs");
if (process.env.MCDEV_HOST_PORT) {
  const state = {
    session: {
      id: crypto.randomUUID(),
      state: "process_started",
      stateSequence: 1,
      connectionGeneration: 1,
      startedAt: new Date().toISOString(),
    },
    minecraft: { pid: process.pid },
    mcdk: { pid: process.ppid },
    gameIpc: { connected: false },
    project: { root: process.cwd() },
    capabilities: { debugCapabilityEnabled: false },
  };
  const decoder = new HostBridgeFrameDecoder();
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: Number(process.env.MCDEV_HOST_PORT),
  });
  const send = (value) => socket.write(encodeHostBridgeFrame(value));
  socket.on("connect", () =>
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "mcdk/initialize",
      params: {
        ...state,
        authToken: process.env.MCDEV_HOST_TOKEN,
        protocol: { minVersion: 1, maxVersion: 1 },
        limits: { maxFrameBytes: 16777216, maxInFlightRequests: 64 },
      },
    }),
  );
  socket.on("data", (data) => {
    for (const msg of decoder.push(data))
      if (msg.method)
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: msg.method === "mcdk/methods/list" ? { methods: [] } : state,
        });
  });
  socket.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
