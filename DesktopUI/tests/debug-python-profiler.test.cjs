const { runPython3 } = require("./fixtures/python3.cjs");
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
var import_pythonProfiler = require("../electron/debug/vendor/pythonProfiler.cjs");
(0, import_node_test.default)("Python profiler scripts stay bounded and distinguish client and server projects", () => {
  const timed = (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "client", clock: "CPU", durationSeconds: 12.5 });
  const manual = (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "server", clock: "WALL" });
  const allStart = (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "all", clock: "CPU" });
  import_strict.default.match(timed, /threading\.Timer\(_mcdev_pp_duration/);
  import_strict.default.match(timed, /yappi\.start\(False,False\)/);
  import_strict.default.doesNotMatch(timed, /yappi\.start\(False,True\)/);
  import_strict.default.match(allStart, /yappi\.start\(False,True\)/);
  import_strict.default.match(timed, /_mcdev_pp_duration=12\.5/);
  import_strict.default.match(manual, /_mcdev_pp_duration=None/);
  import_strict.default.match(manual, /_mcdev_pp_clock='WALL'/);
  import_strict.default.match((0, import_pythonProfiler.buildPythonProfilerCollectCode)("client"), /clientScriptNameList/);
  import_strict.default.match((0, import_pythonProfiler.buildPythonProfilerCollectCode)("server"), /serverScriptNameList/);
  import_strict.default.match((0, import_pythonProfiler.buildPythonProfilerCollectCode)("client"), /_mcdev_pp_module\.startswith\(_mcdev_pp_name\+'\.'\)/);
  import_strict.default.doesNotMatch((0, import_pythonProfiler.buildPythonProfilerCollectCode)("client"), /not _mcdev_pp_scripts/);
  const all = (0, import_pythonProfiler.buildPythonProfilerCollectCode)("all");
  import_strict.default.match(all, /clientScriptNameList/);
  import_strict.default.match(all, /serverScriptNameList/);
  import_strict.default.match(all, /_mcdev_pp_client_marker/);
  import_strict.default.match(all, /_mcdev_pp_server_marker/);
  import_strict.default.match(all, /get_func_stats\(\{'ctx_id':_mcdev_pp_ctx\}\)/);
  import_strict.default.match(all, /_mcdev_pp_side_scripts\[_mcdev_pp_side\]/);
  import_strict.default.match(all, /\(_mcdev_pp_side,_mcdev_pp_child\.index\)/);
  import_strict.default.match((0, import_pythonProfiler.buildPythonProfilerMarkCode)("client"), /def _mcdev_pp_client_marker/);
  import_strict.default.ok(timed.length < 2e3);
  import_strict.default.ok((0, import_pythonProfiler.buildPythonProfilerCollectCode)("client").length < 4500);
  import_strict.default.match((0, import_pythonProfiler.buildPythonProfilerCleanupCode)(), /_mcdev_pp_owned/);
});
(0, import_node_test.default)("Python profiler refuses invalid durations and existing external profilers", () => {
  import_strict.default.throws(
    () => (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "client", clock: "CPU", durationSeconds: 0 }),
    /greater than zero/
  );
  import_strict.default.throws(() => (0, import_pythonProfiler.parsePythonProfilerStart)({ ok: false, reason: "busy" }), /already running/);
  import_strict.default.doesNotThrow(() => (0, import_pythonProfiler.parsePythonProfilerStart)({ ok: true }));
});
(0, import_node_test.default)("Python profiler parses compact bounded call graph data", () => {
  const result = (0, import_pythonProfiler.parsePythonProfilerResult)({
    ok: true,
    clock: "WALL",
    elapsed: 3.25,
    total: 2,
    truncated: false,
    nodes: [
      [0, "demo/main.py", 12, "tick", 5, 5, 0.1, 0.8, 1, "MainThread"],
      [1, "demo/util.py", 8, "work", 10, 10, 0.5, 0.6, 1, "MainThread"]
    ],
    edges: [[0, 1, 10, 0.5, 0.6], [0, 999, 1, 0, 0.1]]
  });
  import_strict.default.equal(result.clock, "WALL");
  import_strict.default.equal(result.elapsedSeconds, 3.25);
  import_strict.default.equal(result.functions[0].target, "client");
  import_strict.default.equal(result.functions[0].name, "tick");
  import_strict.default.deepEqual(result.calls, [{ callerId: 0, calleeId: 1, calls: 10, selfTime: 0.5, totalTime: 0.6 }]);
});
(0, import_node_test.default)("Python profiler keeps marked client and server contexts separate in an ALL result", () => {
  const result = (0, import_pythonProfiler.parsePythonProfilerResult)({
    ok: true,
    clock: "CPU",
    elapsed: 2,
    total: 4,
    truncated: false,
    targets: ["client", "server"],
    nodes: [
      [0, "demo/client.py", 1, "ClientRoot", 1, 1, 0.1, 0.4, 1, "MainThread", "client"],
      [1, "demo/client_work.py", 2, "ClientWork", 1, 1, 0.2, 0.3, 1, "MainThread", "client"],
      [2, "demo/server.py", 1, "ServerRoot", 1, 1, 0.1, 0.4, 2, "MainThread", "server"],
      [3, "demo/server_work.py", 2, "ServerWork", 1, 1, 0.2, 0.3, 2, "MainThread", "server"]
    ],
    edges: [
      [0, 1, 1, 0.2, 0.3],
      [2, 3, 1, 0.2, 0.3],
      [1, 2, 1, 0.1, 0.1]
    ]
  }, "all");
  import_strict.default.deepEqual(result.functions.map((item) => [item.id, item.target, item.contextId]), [
    [0, "client", 1],
    [1, "client", 1],
    [2, "server", 2],
    [3, "server", 2]
  ]);
  import_strict.default.deepEqual(result.calls.map((call) => [call.callerId, call.calleeId]), [[0, 1], [2, 3]]);
  import_strict.default.throws(() => (0, import_pythonProfiler.parsePythonProfilerResult)({
    ok: true,
    clock: "CPU",
    elapsed: 1,
    total: 0,
    targets: ["client"],
    nodes: [],
    edges: []
  }, "all"), /could not distinguish/);
});
(0, import_node_test.default)("generated Python profiler scripts are syntactically valid", (t) => {
  const scripts = [
    (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "client", clock: "CPU", durationSeconds: 1.5 }),
    (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "server", clock: "WALL" }),
    (0, import_pythonProfiler.buildPythonProfilerStartCode)({ target: "all", clock: "CPU" }),
    (0, import_pythonProfiler.buildPythonProfilerMarkCode)("client"),
    (0, import_pythonProfiler.buildPythonProfilerMarkCode)("server"),
    (0, import_pythonProfiler.buildPythonProfilerCollectCode)("client"),
    (0, import_pythonProfiler.buildPythonProfilerCollectCode)("server"),
    (0, import_pythonProfiler.buildPythonProfilerCollectCode)("all"),
    (0, import_pythonProfiler.buildPythonProfilerCleanupCode)()
  ];
  for (const script of scripts) {
    const result = runPython3([
      "-c",
      "import sys; compile(sys.stdin.read(), '<mcdev-profiler>', 'exec')"
    ], { input: script, encoding: "utf8" });
    if (result.error && result.error.code === "ENOENT") {
      t.skip("Python is unavailable");
      return;
    }
    import_strict.default.equal(result.status, 0, result.stderr);
  }
});
