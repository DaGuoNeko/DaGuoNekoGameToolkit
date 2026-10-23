// Adapted from Dofes/mcdev-tools (MIT), pinned source listed in electron/debug/vendor/SOURCES.md.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var assert = __toESM(require("node:assert/strict"));
var import_node_events = require("node:events");
var net = __toESM(require("node:net"));
var import_node_test = __toESM(require("node:test"));
var import_protocol = require("../electron/debug/vendor/protocol.cjs");
var import_server = require("../electron/debug/vendor/server.cjs");
(0, import_node_test.default)("frame decoder handles fragmented and coalesced messages", () => {
  const first = { jsonrpc: "2.0", id: "mcdk:1", result: { value: "\u4F60\u597D" } };
  const second = { jsonrpc: "2.0", method: "mcdk/cancel", params: { id: "host:1" } };
  const firstFrame = (0, import_protocol.encodeHostBridgeFrame)(first);
  const secondFrame = (0, import_protocol.encodeHostBridgeFrame)(second);
  const decoder = new import_protocol.HostBridgeFrameDecoder();
  assert.deepEqual(decoder.push(firstFrame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(firstFrame.subarray(2, 7)), []);
  assert.deepEqual(
    decoder.push(Buffer.concat([firstFrame.subarray(7), secondFrame])),
    [first, second]
  );
  const invalidLength = Buffer.alloc(4);
  assert.throws(() => new import_protocol.HostBridgeFrameDecoder().push(invalidLength), /frame length/i);
});
(0, import_node_test.default)("server authenticates and manages concurrent MCDK sessions", async (t) => {
  const server = new import_server.HostBridgeServer({
    name: "mcdev-tools-test",
    version: "1.0.0",
    instanceId: "test-window"
  });
  t.after(async () => server.dispose());
  const port = await server.start(0);
  const firstLaunch = server.registerLaunch("D:/workspace/one");
  const secondLaunch = server.registerLaunch("D:/workspace/two");
  assert.deepEqual(server.getSnapshot().sessions, []);
  const first = await connectMcdk(
    port,
    firstLaunch.environment.MCDEV_HOST_TOKEN,
    "11111111-1111-4111-8111-111111111111",
    101,
    201
  );
  t.after(() => first.socket.destroy());
  const second = await connectMcdk(
    port,
    secondLaunch.environment.MCDEV_HOST_TOKEN,
    "22222222-2222-4222-8222-222222222222",
    102,
    202
  );
  t.after(() => second.socket.destroy());
  await waitFor(() => server.getSnapshot().sessions.filter((session) => session.connected).length === 2);
  assert.deepEqual(
    server.getSnapshot().sessions.filter((session) => session.connected).map((session) => session.id).sort(),
    ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
  );
  first.socket.write((0, import_protocol.encodeHostBridgeFrame)({
    jsonrpc: "2.0",
    method: "mcdk/session/stateChanged",
    params: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      sequence: 2,
      state: "game_ready",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      gameIpcConnected: true,
      reason: null,
      minecraftExitCode: null
    }
  }));
  await waitFor(() => server.getSnapshot().sessions.find((session) => session.id === "11111111-1111-4111-8111-111111111111")?.state === "game_ready");
  const firstRequest = server.request("11111111-1111-4111-8111-111111111111", "game/code/execute", { code: "1 + 1", isClient: true });
  const secondRequest = server.request("11111111-1111-4111-8111-111111111111", "game/code/execute", { code: "2 + 2", isClient: false });
  const firstMessage = await first.reader.next();
  const secondMessage = await first.reader.next();
  assert.equal(firstMessage.method, "game/code/execute");
  assert.equal(secondMessage.method, "game/code/execute");
  first.socket.write((0, import_protocol.encodeHostBridgeFrame)({ jsonrpc: "2.0", id: secondMessage.id, result: 4 }));
  first.socket.write((0, import_protocol.encodeHostBridgeFrame)({ jsonrpc: "2.0", id: firstMessage.id, result: 2 }));
  assert.deepEqual(await Promise.all([firstRequest, secondRequest]), [2, 4]);
  const firstSummary = server.getSnapshot().sessions.find((session) => session.id === "11111111-1111-4111-8111-111111111111");
  assert.equal(firstSummary?.methods?.some((method) => method.name === "game/code/execute"), true);
});
(0, import_node_test.default)("server rejects an unknown authentication token", async (t) => {
  const server = new import_server.HostBridgeServer({
    name: "mcdev-tools-test",
    version: "1.0.0",
    instanceId: "test-window"
  });
  t.after(async () => server.dispose());
  const port = await server.start(0);
  server.registerLaunch("D:/workspace/expected");
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const reader = new FrameReader(socket);
  t.after(() => socket.destroy());
  await (0, import_node_events.once)(socket, "connect");
  socket.write((0, import_protocol.encodeHostBridgeFrame)(createInitializeRequest(
    "0".repeat(64),
    "33333333-3333-4333-8333-333333333333",
    300,
    400
  )));
  const response = await reader.next();
  assert.equal(response.error.code, -32001);
  assert.equal(response.error.data.code, "AUTH_FAILED");
});
(0, import_node_test.default)("listeners use OS-assigned ports instead of a fixed port", async (t) => {
  const first = new import_server.HostBridgeServer({ name: "test", version: "1", instanceId: "one" });
  const second = new import_server.HostBridgeServer({ name: "test", version: "1", instanceId: "two" });
  t.after(async () => Promise.all([first.dispose(), second.dispose()]));
  const firstPort = await first.start(0);
  const secondPort = await second.start(0);
  assert.ok(firstPort > 0 && firstPort <= 65535);
  assert.ok(secondPort > 0 && secondPort <= 65535);
  assert.notEqual(firstPort, secondPort);
});
class FrameReader {
  decoder = new import_protocol.HostBridgeFrameDecoder();
  queued = [];
  waiters = [];
  constructor(socket) {
    socket.on("data", (chunk) => {
      for (const message of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          this.queued.push(message);
        }
      }
    });
  }
  async next(timeoutMs = 2e3) {
    const queued = this.queued.shift();
    if (queued) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Host Bridge frame")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}
async function connectMcdk(port, token, sessionId, mcdkPid, minecraftPid) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const reader = new FrameReader(socket);
  await (0, import_node_events.once)(socket, "connect");
  const initialize = createInitializeRequest(token, sessionId, mcdkPid, minecraftPid);
  const frame = (0, import_protocol.encodeHostBridgeFrame)(initialize);
  socket.write(frame.subarray(0, 3));
  socket.write(frame.subarray(3, 11));
  socket.write(frame.subarray(11));
  const response = await reader.next();
  assert.equal(response.id, initialize.id);
  assert.equal(response.result.protocolVersion, 1);
  const discovery = await reader.next();
  assert.equal(discovery.method, "mcdk/methods/list");
  socket.write((0, import_protocol.encodeHostBridgeFrame)({
    jsonrpc: "2.0",
    id: discovery.id,
    result: {
      methods: [{
        name: "game/code/execute",
        modes: ["request", "notification"],
        gameAvailability: "in_world",
        paramsSchema: { type: "object" },
        resultSchema: null
      }]
    }
  }));
  return { socket, reader };
}
function createInitializeRequest(token, sessionId, mcdkPid, minecraftPid) {
  return {
    jsonrpc: "2.0",
    id: `mcdk:init:${sessionId}`,
    method: "mcdk/initialize",
    params: {
      protocol: { minVersion: 1, maxVersion: 1 },
      authToken: token,
      session: {
        id: sessionId,
        connectionGeneration: 1,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        state: "process_started",
        stateSequence: 1
      },
      mcdk: { pid: mcdkPid, version: "1.0.0" },
      minecraft: { pid: minecraftPid },
      gameIpc: { host: "127.0.0.1", port: 49152, connected: false },
      project: { root: `D:/workspace/${sessionId}` },
      world: {
        name: sessionId,
        folderName: sessionId,
        runtimePath: `D:/runtime/${sessionId}`,
        sourcePath: null
      },
      capabilities: {
        methodDiscovery: true,
        notifications: true,
        cancellation: true,
        debugCapabilityEnabled: true
      },
      limits: {
        maxFrameBytes: 16 * 1024 * 1024,
        maxInFlightRequests: 64
      }
    }
  };
}
async function waitFor(predicate, timeoutMs = 2e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

require('node:test')('game exit notification preserves the native crash code independently of the launcher', async t => {
  const server = new import_server.HostBridgeServer({name:'test',version:'1',instanceId:'exit-test'});
  t.after(() => server.dispose());
  const port = await server.start();
  const registration = server.registerLaunch('C:/fixture');
  const id = '44444444-4444-4444-8444-444444444444';
  const peer = await connectMcdk(port,registration.environment.MCDEV_HOST_TOKEN,id,100,200);
  t.after(() => peer.socket.destroy());
  peer.socket.write(import_protocol.encodeHostBridgeFrame({jsonrpc:'2.0',method:'mcdk/session/stateChanged',params:{sessionId:id,sequence:3,state:'exited',gameIpcConnected:false,minecraftExitCode:0xC000041D}}));
  await waitFor(() => server.getSnapshot().sessions[0]?.state === 'exited');
  assert.equal(server.getSnapshot().sessions[0].minecraftExitCode,0xC000041D);
});
