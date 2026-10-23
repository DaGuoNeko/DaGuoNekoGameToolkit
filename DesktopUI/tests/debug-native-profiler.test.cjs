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
var import_strict = __toESM(require("node:assert/strict"));
var import_node_test = __toESM(require("node:test"));
var import_nativeProfilerCapture = require("../electron/debug/vendor/nativeProfilerCapture.cjs");
(0, import_node_test.default)("Native profiler removes DEBUG_ENV_SCRIPT frames and promotes visible descendants", () => {
  const zone = (id, name, sourceFile, children = []) => ({
    id,
    name,
    sourceFile,
    sourceLine: 12,
    threadId: "1",
    threadName: "Main",
    calls: 2,
    totalNanoseconds: 100,
    selfNanoseconds: 40,
    meanNanoseconds: 50,
    maximumNanoseconds: 60,
    children
  });
  const result = (0, import_nativeProfilerCapture.parseNativeProfilerResult)(JSON.stringify({
    capturedSeconds: 5,
    totalZones: 3,
    truncated: false,
    callTreeTruncated: false,
    zones: [
      zone(0, "_recvAll", "DEBUG_ENV_SCRIPT.IPCSystem"),
      zone(1, "tick", "demo/main.cpp")
    ],
    threads: [
      {
        id: "1",
        name: "Main",
        calls: 4,
        totalNanoseconds: 200,
        roots: [zone(2, "_recvAll", "DEBUG_ENV_SCRIPT/IPCSystem.py", [
          zone(3, "tick", "demo/main.cpp")
        ])]
      },
      {
        id: "2",
        name: "IPC",
        calls: 2,
        totalNanoseconds: 100,
        roots: [zone(4, "_recvAll", "DEBUG_ENV_SCRIPT\\IPCSystem.py")]
      }
    ]
  }));
  import_strict.default.deepEqual(result.zones.map((item) => item.name), ["tick"]);
  import_strict.default.equal(result.threads.length, 1);
  import_strict.default.equal(result.threads[0].name, "Main");
  import_strict.default.deepEqual(result.threads[0].roots.map((item) => item.name), ["tick"]);
  import_strict.default.equal(result.threads[0].totalNanoseconds, 100);
  import_strict.default.equal(result.threads[0].calls, 2);
});
