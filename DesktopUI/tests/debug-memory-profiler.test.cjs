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
var import_node_child_process = require("node:child_process");
var import_node_test = __toESM(require("node:test"));
var import_pythonMemoryProfiler = require("../electron/debug/vendor/pythonMemoryProfiler.cjs");
(0, import_node_test.default)("Python memory scripts are compact, bounded, and project-filtered", () => {
  const start = (0, import_pythonMemoryProfiler.buildPythonMemoryStartCode)({ tracebackDepth: 8 });
  const collect = (0, import_pythonMemoryProfiler.buildPythonMemoryCollectCode)(true);
  import_strict.default.match(start, /tracemalloc\.start\(8\)/);
  import_strict.default.match(collect, /gc\.collect\(\)/);
  import_strict.default.match(collect, /compare_to\(_mcdev_pm_base,'traceback'\)/);
  import_strict.default.match(collect, /clientScriptNameList/);
  import_strict.default.match(collect, /serverScriptNameList/);
  import_strict.default.match(collect, /'qumodlibs' in set\(_mcdev_pm_origin\.split\('\/'\)\)/);
  import_strict.default.match(collect, /_mcdev_pm_all\[:80\]/);
  import_strict.default.ok(start.length < 1e3);
  import_strict.default.ok(collect.length < 4500);
  import_strict.default.throws(() => (0, import_pythonMemoryProfiler.buildPythonMemoryStartCode)({ tracebackDepth: 17 }), /between 1 and 16/);
});
(0, import_node_test.default)("Python memory parser preserves signed deltas and bounded tracebacks", () => {
  const result = (0, import_pythonMemoryProfiler.parsePythonMemoryResult)({
    ok: true,
    elapsed: 4.25,
    depth: 8,
    sizeDiff: 1536,
    countDiff: -2,
    size: 8192,
    count: 12,
    total: 2,
    truncated: false,
    rows: [
      [0, 2048, 3, 4096, 6, [["demo/main.py", 12], ["demo/cache.py", 4]]],
      [1, -512, -5, 4096, 6, [["demo/old.py", 20]]],
      ["bad", 1, 1, 1, 1, []]
    ]
  });
  import_strict.default.equal(result.netSizeDiff, 1536);
  import_strict.default.equal(result.netCountDiff, -2);
  import_strict.default.equal(result.allocations.length, 2);
  import_strict.default.deepEqual(result.allocations[1], {
    id: 1,
    sizeDiff: -512,
    countDiff: -5,
    currentSize: 4096,
    currentCount: 6,
    traceback: [{ file: "demo/old.py", line: 20 }]
  });
});
(0, import_node_test.default)("Python memory parser reports ownership conflicts", () => {
  import_strict.default.throws(() => (0, import_pythonMemoryProfiler.parsePythonMemoryStart)({ ok: false, reason: "busy" }), /already active/);
  import_strict.default.throws(() => (0, import_pythonMemoryProfiler.parsePythonMemoryResult)({ ok: false, reason: "not_owned" }), /No MC Dev Tools/);
});
(0, import_node_test.default)("generated Python memory scripts are syntactically valid", (t) => {
  for (const script of [
    (0, import_pythonMemoryProfiler.buildPythonMemoryStartCode)({ tracebackDepth: 1 }),
    (0, import_pythonMemoryProfiler.buildPythonMemoryStartCode)({ tracebackDepth: 16 }),
    (0, import_pythonMemoryProfiler.buildPythonMemoryCollectCode)(false),
    (0, import_pythonMemoryProfiler.buildPythonMemoryCollectCode)(true),
    (0, import_pythonMemoryProfiler.buildPythonMemoryCleanupCode)()
  ]) {
    const result = (0, import_node_child_process.spawnSync)("python", [
      "-c",
      "import sys; compile(sys.stdin.read(), '<mcdev-memory>', 'exec')"
    ], { input: script, encoding: "utf8" });
    if (result.error && result.error.code === "ENOENT") {
      t.skip("Python is unavailable");
      return;
    }
    import_strict.default.equal(result.status, 0, result.stderr);
  }
});
