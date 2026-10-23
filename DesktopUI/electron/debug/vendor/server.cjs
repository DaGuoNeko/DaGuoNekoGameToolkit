// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/server.ts; see licenses/MCDevTools-LICENSE.txt.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  HostBridgeDisconnectedError: () => HostBridgeDisconnectedError,
  HostBridgeRpcError: () => HostBridgeRpcError,
  HostBridgeServer: () => HostBridgeServer
});
module.exports = __toCommonJS(stdin_exports);
var crypto = __toESM(require("crypto"));
var net = __toESM(require("net"));
var import_events = require("events");
var import_protocol = require("./protocol.cjs");
const HANDSHAKE_TIMEOUT_MS = 3e3;
const DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
const MAX_WRITE_QUEUE_BYTES = import_protocol.HOST_BRIDGE_MAX_FRAME_BYTES * 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_STATES = /* @__PURE__ */ new Set([
  "process_started",
  "game_ready",
  "game_unavailable",
  "exiting",
  "exited"
]);
class HostBridgeRpcError extends Error {
  constructor(rpcCode, message, data) {
    super(message);
    this.rpcCode = rpcCode;
    this.data = data;
    this.name = "HostBridgeRpcError";
  }
  rpcCode;
  data;
  get symbolicCode() {
    return (0, import_protocol.getString)(this.data?.code);
  }
}
class HostBridgeDisconnectedError extends Error {
  constructor(message = "MCDK Host Bridge connection closed") {
    super(message);
    this.name = "HostBridgeDisconnectedError";
  }
}
class HostBridgeServer {
  constructor(hostInfo) {
    this.hostInfo = hostInfo;
  }
  hostInfo;
  events = new import_events.EventEmitter();
  registrations = /* @__PURE__ */ new Map();
  connections = /* @__PURE__ */ new Set();
  sessions = /* @__PURE__ */ new Map();
  server;
  startPromise;
  nextRequestId = 1;
  disposed = false;
  serverStatus = "idle";
  serverPort;
  serverError;
  onDidChange(listener) {
    this.events.on("change", listener);
    return { dispose: () => this.events.off("change", listener) };
  }
  get port() {
    return this.serverPort;
  }
  get isListening() {
    return this.serverStatus === "listening" && this.server !== void 0;
  }
  getSnapshot() {
    const sessions = [...this.sessions.values()].map((record) => ({ ...record.summary })).sort((left, right) => {
      if (left.connected !== right.connected) {
        return left.connected ? -1 : 1;
      }
      return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
    });
    return {
      status: this.serverStatus,
      port: this.serverPort,
      error: this.serverError,
      sessions
    };
  }
  async start(preferredPort = 0) {
    if (this.disposed) {
      throw new Error("Host Bridge server has been disposed");
    }
    if (this.isListening && this.serverPort !== void 0) {
      return this.serverPort;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.listen(preferredPort);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = void 0;
    }
  }
  registerLaunch(workspacePath) {
    if (!this.isListening || this.serverPort === void 0) {
      throw new Error("Host Bridge listener is not running");
    }
    const registration = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(32).toString("hex"),
      workspacePath,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };
    this.registrations.set(registration.id, registration);
    this.emitChange();
    return {
      registrationId: registration.id,
      environment: {
        MCDEV_HOST_PORT: String(this.serverPort),
        MCDEV_HOST_TOKEN: registration.token
      }
    };
  }
  releaseRegistration(registrationId) {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return;
    }
    this.registrations.delete(registrationId);
    if (registration.sessionId) {
      const session = this.sessions.get(registration.sessionId);
      if (session?.connection) {
        session.connection.socket.destroy();
      }
      if (session?.removalTimer) {
        clearTimeout(session.removalTimer);
      }
      this.sessions.delete(registration.sessionId);
    }
    this.emitChange();
  }
  pruneRegistrations(now = Date.now()) {
    const pendingMaxAge = 60 * 60 * 1e3;
    const sessionMaxAge = 7 * 24 * 60 * 60 * 1e3;
    let changed = false;
    for (const registration of [...this.registrations.values()]) {
      const session = registration.sessionId ? this.sessions.get(registration.sessionId) : void 0;
      if (session?.connection) {
        continue;
      }
      const maxAge = registration.sessionId ? sessionMaxAge : pendingMaxAge;
      if (now - registration.lastSeenAt > maxAge) {
        this.registrations.delete(registration.id);
        if (registration.sessionId) {
          this.sessions.delete(registration.sessionId);
        }
        changed = true;
      }
    }
    if (changed) {
      this.emitChange();
    }
  }
  async request(sessionId, method, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const session = this.sessions.get(sessionId);
    const connection = session?.connection;
    if (!connection || connection.phase !== "active") {
      throw new HostBridgeDisconnectedError();
    }
    if (connection.pending.size >= connection.maxInFlightRequests) {
      throw new HostBridgeRpcError(-32004, "MCDK request limit reached", {
        code: "SERVER_BUSY"
      });
    }
    const id = `host:${this.nextRequestId++}`;
    const key = (0, import_protocol.rpcIdKey)(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(key);
        this.sendMessage(connection, {
          jsonrpc: "2.0",
          method: "mcdk/cancel",
          params: { id }
        });
        reject(new HostBridgeRpcError(-32014, `Host Bridge request timed out: ${method}`, {
          code: "HANDLER_TIMEOUT"
        }));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      connection.pending.set(key, { resolve, reject, timer });
      if (!this.sendMessage(connection, {
        jsonrpc: "2.0",
        id,
        method,
        params
      })) {
        clearTimeout(timer);
        connection.pending.delete(key);
        reject(new HostBridgeDisconnectedError());
      }
    });
  }
  notify(sessionId, method, params = {}) {
    const connection = this.sessions.get(sessionId)?.connection;
    if (!connection || connection.phase !== "active") {
      throw new HostBridgeDisconnectedError();
    }
    if (!this.sendMessage(connection, { jsonrpc: "2.0", method, params })) {
      throw new HostBridgeDisconnectedError();
    }
  }
  async refreshSessions() {
    const sessionIds = [...this.sessions.values()].filter((record) => record.connection?.phase === "active").map((record) => record.summary.id);
    await Promise.allSettled(sessionIds.map(async (sessionId) => {
      const [snapshot, methods] = await Promise.all([
        this.request(sessionId, "mcdk/session/get", {}, 3e3),
        this.request(sessionId, "mcdk/methods/list", {}, 3e3)
      ]);
      this.applySessionSnapshot(sessionId, snapshot);
      this.applyMethodList(sessionId, methods);
      this.emitChange();
    }));
  }
  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const record of this.sessions.values()) {
      if (record.removalTimer) {
        clearTimeout(record.removalTimer);
      }
    }
    for (const connection of [...this.connections]) {
      this.closeConnection(connection, new HostBridgeDisconnectedError("Host Bridge server stopped"));
    }
    const server = this.server;
    this.server = void 0;
    this.serverPort = void 0;
    this.serverStatus = "idle";
    this.emitChange();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    this.events.removeAllListeners();
  }
  async listen(port) {
    const server = net.createServer({ allowHalfOpen: false }, (socket) => this.acceptSocket(socket));
    this.server = server;
    try {
      const boundPort = await new Promise((resolve, reject) => {
        const handleError = (error) => {
          server.off("listening", handleListening);
          reject(error);
        };
        const handleListening = () => {
          server.off("error", handleError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Host Bridge listener did not expose a TCP address"));
            return;
          }
          resolve(address.port);
        };
        server.once("error", handleError);
        server.once("listening", handleListening);
        server.listen({ host: "127.0.0.1", port, exclusive: true });
      });
      server.on("error", (error) => {
        this.serverStatus = "error";
        this.serverError = error.message;
        this.emitChange();
      });
      server.unref();
      this.serverStatus = "listening";
      this.serverPort = boundPort;
      this.serverError = void 0;
      this.emitChange();
      return boundPort;
    } catch (error) {
      this.server = void 0;
      this.serverPort = void 0;
      this.serverStatus = "error";
      this.serverError = error instanceof Error ? error.message : String(error);
      server.close();
      this.emitChange();
      throw error;
    }
  }
  acceptSocket(socket) {
    if (this.disposed || !isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 3e4);
    const connection = {
      socket,
      decoder: new import_protocol.HostBridgeFrameDecoder(),
      phase: "handshake",
      handshakeTimer: setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS),
      generation: 0,
      maxFrameBytes: import_protocol.HOST_BRIDGE_MAX_FRAME_BYTES,
      maxInFlightRequests: import_protocol.HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS,
      pending: /* @__PURE__ */ new Map()
    };
    connection.handshakeTimer.unref?.();
    this.connections.add(connection);
    socket.on("data", (chunk) => this.receiveData(connection, chunk));
    socket.on("error", () => {
    });
    socket.on("close", () => this.closeConnection(connection));
  }
  receiveData(connection, chunk) {
    if (connection.phase === "closed") {
      return;
    }
    let messages;
    try {
      messages = connection.decoder.push(chunk);
    } catch {
      connection.socket.destroy();
      return;
    }
    for (const message of messages) {
      if (connection.phase === "handshake") {
        this.handleInitialize(connection, message);
      } else if (connection.phase === "active") {
        this.handleActiveMessage(connection, message);
      }
      if (connection.socket.destroyed) {
        return;
      }
    }
  }
  handleInitialize(connection, message) {
    const id = message.id;
    if (message.jsonrpc !== "2.0" || !(0, import_protocol.isJsonRpcId)(id) || message.method !== "mcdk/initialize" || !(0, import_protocol.isJsonObject)(message.params)) {
      this.rejectHandshake(connection, (0, import_protocol.isJsonRpcId)(id) ? id : "mcdk:initialize", -32600, "Invalid initialize request", "INVALID_REQUEST");
      return;
    }
    const params = message.params;
    const token = (0, import_protocol.getString)(params.authToken);
    const registration = token ? this.findRegistration(token) : void 0;
    if (!registration) {
      this.rejectHandshake(connection, id, -32001, "Host Bridge authentication failed", "AUTH_FAILED");
      return;
    }
    const protocol = (0, import_protocol.isJsonObject)(params.protocol) ? params.protocol : void 0;
    const minVersion = (0, import_protocol.getInteger)(protocol?.minVersion);
    const maxVersion = (0, import_protocol.getInteger)(protocol?.maxVersion);
    if (minVersion === void 0 || maxVersion === void 0 || minVersion > import_protocol.HOST_BRIDGE_PROTOCOL_VERSION || maxVersion < import_protocol.HOST_BRIDGE_PROTOCOL_VERSION) {
      this.rejectHandshake(
        connection,
        id,
        -32002,
        "Host Bridge protocol version is not supported",
        "PROTOCOL_VERSION_UNSUPPORTED"
      );
      return;
    }
    const initialize = this.parseInitialize(params, registration);
    if (!initialize) {
      this.rejectHandshake(connection, id, -32600, "Invalid initialize parameters", "INVALID_REQUEST");
      return;
    }
    if (registration.sessionId && registration.sessionId !== initialize.sessionId) {
      this.rejectHandshake(connection, id, -32001, "Host Bridge authentication failed", "AUTH_FAILED");
      return;
    }
    const existing = this.sessions.get(initialize.sessionId);
    if (existing?.connection && initialize.generation <= existing.summary.connectionGeneration) {
      this.rejectHandshake(connection, id, -32600, "Stale connection generation", "INVALID_REQUEST");
      return;
    }
    clearTimeout(connection.handshakeTimer);
    connection.phase = "active";
    connection.registration = registration;
    connection.sessionId = initialize.sessionId;
    connection.generation = initialize.generation;
    connection.maxFrameBytes = initialize.remoteMaxFrameBytes;
    connection.maxInFlightRequests = initialize.remoteMaxInFlightRequests;
    registration.sessionId = initialize.sessionId;
    registration.mcdkPid = initialize.mcdkPid;
    registration.minecraftPid = initialize.minecraftPid;
    registration.lastSeenAt = Date.now();
    const summary = {
      id: initialize.sessionId,
      registrationId: registration.id,
      connected: true,
      state: initialize.state,
      stateSequence: initialize.stateSequence,
      connectionGeneration: initialize.generation,
      startedAt: initialize.startedAt,
      mcdkPid: initialize.mcdkPid,
      minecraftPid: initialize.minecraftPid,
      projectRoot: initialize.projectRoot,
      worldName: initialize.worldName,
      worldFolderName: initialize.worldFolderName,
      gameIpcConnected: initialize.gameIpcConnected,
      debugCapabilityEnabled: initialize.debugCapabilityEnabled,
      methods: existing?.summary.methods
    };
    if (existing?.removalTimer) {
      clearTimeout(existing.removalTimer);
    }
    this.sessions.set(initialize.sessionId, { summary, connection });
    const responseSent = this.sendMessage(connection, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: import_protocol.HOST_BRIDGE_PROTOCOL_VERSION,
        connectionId: crypto.randomUUID(),
        host: this.hostInfo,
        heartbeatIntervalMs: import_protocol.HOST_BRIDGE_HEARTBEAT_INTERVAL_MS,
        limits: {
          maxFrameBytes: import_protocol.HOST_BRIDGE_MAX_FRAME_BYTES,
          maxInFlightRequests: import_protocol.HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS
        }
      }
    }, initialize.remoteMaxFrameBytes);
    if (!responseSent) {
      return;
    }
    if (existing?.connection && existing.connection !== connection) {
      existing.connection.socket.destroy();
    }
    this.emitChange();
    setImmediate(() => {
      void this.discoverMethods(initialize.sessionId);
    });
  }
  parseInitialize(params, registration) {
    const session = (0, import_protocol.isJsonObject)(params.session) ? params.session : void 0;
    const mcdk = (0, import_protocol.isJsonObject)(params.mcdk) ? params.mcdk : void 0;
    const minecraft = (0, import_protocol.isJsonObject)(params.minecraft) ? params.minecraft : void 0;
    const project = (0, import_protocol.isJsonObject)(params.project) ? params.project : void 0;
    const world = (0, import_protocol.isJsonObject)(params.world) ? params.world : void 0;
    const gameIpc = (0, import_protocol.isJsonObject)(params.gameIpc) ? params.gameIpc : void 0;
    const capabilities = (0, import_protocol.isJsonObject)(params.capabilities) ? params.capabilities : void 0;
    const limits = (0, import_protocol.isJsonObject)(params.limits) ? params.limits : void 0;
    const sessionId = (0, import_protocol.getString)(session?.id);
    const generation = (0, import_protocol.getInteger)(session?.connectionGeneration);
    const state = (0, import_protocol.getString)(session?.state);
    const stateSequence = (0, import_protocol.getInteger)(session?.stateSequence);
    const mcdkPid = (0, import_protocol.getInteger)(mcdk?.pid);
    const minecraftPid = (0, import_protocol.getInteger)(minecraft?.pid);
    const projectRoot = (0, import_protocol.getString)(project?.root) ?? registration.workspacePath;
    const remoteMaxFrameBytes = (0, import_protocol.getInteger)(limits?.maxFrameBytes) ?? import_protocol.HOST_BRIDGE_MAX_FRAME_BYTES;
    const remoteMaxInFlightRequests = (0, import_protocol.getInteger)(limits?.maxInFlightRequests) ?? import_protocol.HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS;
    if (!sessionId || !UUID_PATTERN.test(sessionId) || generation === void 0 || generation < 1 || !state || !VALID_STATES.has(state) || stateSequence === void 0 || stateSequence < 0 || mcdkPid === void 0 || mcdkPid < 1 || minecraftPid === void 0 || minecraftPid < 1 || remoteMaxFrameBytes < 1 || remoteMaxFrameBytes > import_protocol.HOST_BRIDGE_MAX_FRAME_BYTES || remoteMaxInFlightRequests < 1) {
      return void 0;
    }
    return {
      registration,
      sessionId,
      generation,
      state,
      stateSequence,
      startedAt: (0, import_protocol.getString)(session?.startedAt),
      mcdkPid,
      minecraftPid,
      projectRoot,
      worldName: (0, import_protocol.getString)(world?.name),
      worldFolderName: (0, import_protocol.getString)(world?.folderName),
      gameIpcConnected: gameIpc?.connected === true,
      debugCapabilityEnabled: capabilities?.debugCapabilityEnabled === true,
      remoteMaxFrameBytes,
      remoteMaxInFlightRequests: Math.min(remoteMaxInFlightRequests, import_protocol.HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS)
    };
  }
  handleActiveMessage(connection, message) {
    if (message.jsonrpc !== "2.0") {
      connection.socket.destroy();
      return;
    }
    if (typeof message.method === "string") {
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        this.handleInboundRequest(connection, message);
      } else {
        this.handleNotification(connection, message);
      }
      return;
    }
    this.handleResponse(connection, message);
  }
  handleInboundRequest(connection, message) {
    const id = message.id;
    if (!(0, import_protocol.isJsonRpcId)(id)) {
      connection.socket.destroy();
      return;
    }
    if (message.method === "mcdk/ping") {
      this.sendMessage(connection, {
        jsonrpc: "2.0",
        id,
        result: { receivedAt: (/* @__PURE__ */ new Date()).toISOString() }
      });
      return;
    }
    this.sendMessage(connection, {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Host method not found",
        data: { code: "METHOD_NOT_FOUND" }
      }
    });
  }
  handleNotification(connection, message) {
    if (message.method === "mcdk/cancel") {
      return;
    }
    if (message.method !== "mcdk/session/stateChanged" || !(0, import_protocol.isJsonObject)(message.params)) {
      return;
    }
    const sessionId = (0, import_protocol.getString)(message.params.sessionId);
    const sequence = (0, import_protocol.getInteger)(message.params.sequence);
    const state = (0, import_protocol.getString)(message.params.state);
    if (!sessionId || sessionId !== connection.sessionId || sequence === void 0 || !state || !VALID_STATES.has(state)) {
      return;
    }
    const record = this.sessions.get(sessionId);
    if (!record || sequence <= record.summary.stateSequence) {
      return;
    }
    record.summary.stateSequence = sequence;
    record.summary.state = state;
    record.summary.gameIpcConnected = message.params.gameIpcConnected === true;
    const exitCode = (0, import_protocol.getInteger)(message.params.minecraftExitCode);
    if (exitCode !== void 0) record.summary.minecraftExitCode = exitCode;
    const registration = connection.registration;
    if (registration) {
      registration.lastSeenAt = Date.now();
    }
    if (state === "exited") {
      this.retireExitedSession(record);
    }
    this.emitChange();
  }
  handleResponse(connection, message) {
    const id = message.id;
    if (!(0, import_protocol.isJsonRpcId)(id)) {
      connection.socket.destroy();
      return;
    }
    const pending = connection.pending.get((0, import_protocol.rpcIdKey)(id));
    if (!pending) {
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError) {
      connection.socket.destroy();
      return;
    }
    connection.pending.delete((0, import_protocol.rpcIdKey)(id));
    clearTimeout(pending.timer);
    if (hasResult) {
      pending.resolve(message.result);
      return;
    }
    const error = (0, import_protocol.isJsonObject)(message.error) ? message.error : {};
    const data = (0, import_protocol.isJsonObject)(error.data) ? error.data : void 0;
    pending.reject(new HostBridgeRpcError(
      (0, import_protocol.getInteger)(error.code) ?? -32603,
      (0, import_protocol.getString)(error.message) ?? "MCDK request failed",
      data
    ));
  }
  async discoverMethods(sessionId) {
    try {
      const result = await this.request(sessionId, "mcdk/methods/list", {}, 3e3);
      this.applyMethodList(sessionId, result);
      this.emitChange();
    } catch {
    }
  }
  applyMethodList(sessionId, value) {
    if (!(0, import_protocol.isJsonObject)(value) || !Array.isArray(value.methods)) {
      return;
    }
    const methods = [];
    for (const item of value.methods) {
      if (!(0, import_protocol.isJsonObject)(item) || typeof item.name !== "string") {
        continue;
      }
      methods.push({
        name: item.name,
        modes: Array.isArray(item.modes) ? item.modes.filter((mode) => typeof mode === "string") : [],
        gameAvailability: (0, import_protocol.getString)(item.gameAvailability) ?? "none"
      });
    }
    methods.sort((left, right) => left.name.localeCompare(right.name));
    const record = this.sessions.get(sessionId);
    if (record) {
      record.summary.methods = methods;
    }
  }
  applySessionSnapshot(sessionId, value) {
    if (!(0, import_protocol.isJsonObject)(value)) {
      return;
    }
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    const session = (0, import_protocol.isJsonObject)(value.session) ? value.session : void 0;
    const mcdk = (0, import_protocol.isJsonObject)(value.mcdk) ? value.mcdk : void 0;
    const minecraft = (0, import_protocol.isJsonObject)(value.minecraft) ? value.minecraft : void 0;
    const project = (0, import_protocol.isJsonObject)(value.project) ? value.project : void 0;
    const world = (0, import_protocol.isJsonObject)(value.world) ? value.world : void 0;
    const gameIpc = (0, import_protocol.isJsonObject)(value.gameIpc) ? value.gameIpc : void 0;
    const capabilities = (0, import_protocol.isJsonObject)(value.capabilities) ? value.capabilities : void 0;
    const state = (0, import_protocol.getString)(session?.state);
    const sequence = (0, import_protocol.getInteger)(session?.stateSequence);
    if (sequence !== void 0 && sequence < record.summary.stateSequence) return;
    if (state && VALID_STATES.has(state)) {
      record.summary.state = state;
    }
    if (sequence !== void 0 && sequence >= record.summary.stateSequence) {
      record.summary.stateSequence = sequence;
    }
    record.summary.startedAt = (0, import_protocol.getString)(session?.startedAt) ?? record.summary.startedAt;
    record.summary.mcdkPid = (0, import_protocol.getInteger)(mcdk?.pid) ?? record.summary.mcdkPid;
    record.summary.minecraftPid = (0, import_protocol.getInteger)(minecraft?.pid) ?? record.summary.minecraftPid;
    record.summary.projectRoot = (0, import_protocol.getString)(project?.root) ?? record.summary.projectRoot;
    record.summary.worldName = (0, import_protocol.getString)(world?.name) ?? record.summary.worldName;
    record.summary.worldFolderName = (0, import_protocol.getString)(world?.folderName) ?? record.summary.worldFolderName;
    record.summary.gameIpcConnected = gameIpc?.connected === true;
    record.summary.debugCapabilityEnabled = capabilities?.debugCapabilityEnabled === true;
  }
  retireExitedSession(record) {
    const registrationId = record.summary.registrationId;
    this.registrations.delete(registrationId);
    if (record.removalTimer) {
      clearTimeout(record.removalTimer);
    }
    record.removalTimer = setTimeout(() => {
      const current = this.sessions.get(record.summary.id);
      if (current === record) {
        this.sessions.delete(record.summary.id);
        this.emitChange();
      }
    }, 5e3);
    record.removalTimer.unref?.();
  }
  findRegistration(candidate) {
    if (!/^[0-9a-fA-F]{64}$/.test(candidate)) {
      return void 0;
    }
    const candidateBytes = Buffer.from(candidate, "hex");
    let match;
    for (const registration of this.registrations.values()) {
      const expectedBytes = Buffer.from(registration.token, "hex");
      if (expectedBytes.length === candidateBytes.length && crypto.timingSafeEqual(expectedBytes, candidateBytes)) {
        match = registration;
      }
    }
    return match;
  }
  rejectHandshake(connection, id, code, message, symbolicCode) {
    if (connection.phase === "closed") {
      return;
    }
    clearTimeout(connection.handshakeTimer);
    connection.phase = "closed";
    let frame;
    try {
      frame = (0, import_protocol.encodeHostBridgeFrame)({
        jsonrpc: "2.0",
        id,
        error: { code, message, data: { code: symbolicCode } }
      });
    } catch {
      connection.socket.destroy();
      return;
    }
    connection.socket.end(frame);
  }
  sendMessage(connection, message, maxFrameBytes = connection.maxFrameBytes) {
    if (connection.phase === "closed" || connection.socket.destroyed || !connection.socket.writable) {
      return false;
    }
    let frame;
    try {
      frame = (0, import_protocol.encodeHostBridgeFrame)(message, maxFrameBytes);
    } catch {
      connection.socket.destroy();
      return false;
    }
    if (connection.socket.writableLength + frame.length > MAX_WRITE_QUEUE_BYTES) {
      connection.socket.destroy();
      return false;
    }
    try {
      connection.socket.write(frame);
      return true;
    } catch {
      connection.socket.destroy();
      return false;
    }
  }
  closeConnection(connection, reason = new HostBridgeDisconnectedError()) {
    if (connection.phase === "closed" && !this.connections.has(connection)) {
      return;
    }
    connection.phase = "closed";
    clearTimeout(connection.handshakeTimer);
    connection.decoder.reset();
    this.connections.delete(connection);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    connection.pending.clear();
    if (!connection.socket.destroyed) {
      connection.socket.destroy();
    }
    if (connection.sessionId) {
      const record = this.sessions.get(connection.sessionId);
      if (record?.connection === connection) {
        record.connection = void 0;
        record.summary.connected = false;
        if (connection.registration) {
          connection.registration.lastSeenAt = Date.now();
        }
        this.emitChange();
      }
    }
  }
  emitChange() {
    this.events.emit("change", this.getSnapshot());
  }
}
function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HostBridgeDisconnectedError,
  HostBridgeRpcError,
  HostBridgeServer
});
