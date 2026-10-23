// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/nativeProfilerPortDiscovery.ts; see licenses/MCDevTools-LICENSE.txt.
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
  TRACY_PORT_END: () => TRACY_PORT_END,
  TRACY_PORT_START: () => TRACY_PORT_START,
  discoverTracyListeners: () => discoverTracyListeners,
  parseNetstatTracyListeners: () => parseNetstatTracyListeners
});
module.exports = __toCommonJS(stdin_exports);
var path = __toESM(require("path"));
var import_child_process = require("child_process");
const TRACY_PORT_START = 8086;
const TRACY_PORT_END = 8105;
function parseNetstatTracyListeners(output) {
  const endpoints = /* @__PURE__ */ new Map();
  for (const rawLine of output.split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") {
      continue;
    }
    const state = columns[columns.length - 2].toUpperCase();
    if (state !== "LISTENING" && state !== "\u4FA6\u542C") {
      continue;
    }
    const pid = Number(columns[columns.length - 1]);
    const port = endpointPort(columns[1]);
    if (!Number.isInteger(pid) || pid <= 0 || port === void 0 || port < TRACY_PORT_START || port > TRACY_PORT_END) {
      continue;
    }
    endpoints.set(`${pid}:${port}`, { pid, port });
  }
  return [...endpoints.values()].sort((left, right) => left.port - right.port || left.pid - right.pid);
}
function discoverTracyListeners() {
  if (process.platform !== "win32") {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)(
      path.join(process.env.SystemRoot, "System32", "netstat.exe"),
      ["-ano", "-p", "tcp"],
      { windowsHide: true, timeout: 1e4, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Unable to inspect Tracy ports: ${error.message}`));
          return;
        }
        resolve(parseNetstatTracyListeners(stdout));
      }
    );
  });
}
function endpointPort(endpoint) {
  const match = /:(\d+)$/.exec(endpoint);
  if (!match) {
    return void 0;
  }
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TRACY_PORT_END,
  TRACY_PORT_START,
  discoverTracyListeners,
  parseNetstatTracyListeners
});
