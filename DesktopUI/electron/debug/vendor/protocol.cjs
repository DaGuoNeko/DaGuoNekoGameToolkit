// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/protocol.ts; see licenses/MCDevTools-LICENSE.txt.
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  HOST_BRIDGE_HEARTBEAT_INTERVAL_MS: () => HOST_BRIDGE_HEARTBEAT_INTERVAL_MS,
  HOST_BRIDGE_MAX_FRAME_BYTES: () => HOST_BRIDGE_MAX_FRAME_BYTES,
  HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS: () => HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS,
  HOST_BRIDGE_PROTOCOL_VERSION: () => HOST_BRIDGE_PROTOCOL_VERSION,
  HostBridgeFrameDecoder: () => HostBridgeFrameDecoder,
  HostBridgeProtocolError: () => HostBridgeProtocolError,
  encodeHostBridgeFrame: () => encodeHostBridgeFrame,
  getInteger: () => getInteger,
  getString: () => getString,
  isJsonObject: () => isJsonObject,
  isJsonRpcId: () => isJsonRpcId,
  rpcIdKey: () => rpcIdKey
});
module.exports = __toCommonJS(stdin_exports);
var import_util = require("util");
const HOST_BRIDGE_PROTOCOL_VERSION = 1;
const HOST_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS = 64;
const HOST_BRIDGE_HEARTBEAT_INTERVAL_MS = 1e4;
class HostBridgeProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostBridgeProtocolError";
  }
}
class HostBridgeFrameDecoder {
  constructor(maxFrameBytes = HOST_BRIDGE_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }
  maxFrameBytes;
  buffer = Buffer.alloc(0);
  decoder = new import_util.TextDecoder("utf-8", { fatal: true });
  push(chunk) {
    if (chunk.length === 0) {
      return [];
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const messages = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = this.buffer.readUInt32BE(offset);
      if (length === 0 || length > this.maxFrameBytes) {
        throw new HostBridgeProtocolError(`Invalid Host Bridge frame length: ${length}`);
      }
      if (this.buffer.length - offset - 4 < length) {
        break;
      }
      const payload = this.buffer.subarray(offset + 4, offset + 4 + length);
      let decoded;
      try {
        decoded = this.decoder.decode(payload);
      } catch {
        throw new HostBridgeProtocolError("Host Bridge frame is not valid UTF-8");
      }
      let message;
      try {
        message = JSON.parse(decoded);
      } catch {
        throw new HostBridgeProtocolError("Host Bridge frame is not valid JSON");
      }
      if (!isJsonObject(message)) {
        throw new HostBridgeProtocolError("Host Bridge payload must be a JSON object");
      }
      messages.push(message);
      offset += 4 + length;
    }
    if (offset > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(offset));
    }
    return messages;
  }
  reset() {
    this.buffer = Buffer.alloc(0);
  }
}
function encodeHostBridgeFrame(message, maxFrameBytes = HOST_BRIDGE_MAX_FRAME_BYTES) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length === 0 || payload.length > maxFrameBytes) {
    throw new HostBridgeProtocolError(`Host Bridge payload is ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcId(value) {
  return typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isSafeInteger(value);
}
function rpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}
function getString(value) {
  return typeof value === "string" ? value : void 0;
}
function getInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOST_BRIDGE_HEARTBEAT_INTERVAL_MS,
  HOST_BRIDGE_MAX_FRAME_BYTES,
  HOST_BRIDGE_MAX_IN_FLIGHT_REQUESTS,
  HOST_BRIDGE_PROTOCOL_VERSION,
  HostBridgeFrameDecoder,
  HostBridgeProtocolError,
  encodeHostBridgeFrame,
  getInteger,
  getString,
  isJsonObject,
  isJsonRpcId,
  rpcIdKey
});
