// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/pythonProfiler.ts; see licenses/MCDevTools-LICENSE.txt.
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
  buildPythonProfilerCleanupCode: () => buildPythonProfilerCleanupCode,
  buildPythonProfilerCollectCode: () => buildPythonProfilerCollectCode,
  buildPythonProfilerMarkCode: () => buildPythonProfilerMarkCode,
  buildPythonProfilerStartCode: () => buildPythonProfilerStartCode,
  parsePythonProfilerResult: () => parsePythonProfilerResult,
  parsePythonProfilerStart: () => parsePythonProfilerStart
});
module.exports = __toCommonJS(stdin_exports);
const MAX_FUNCTIONS = 160;
const MAX_CALLS = 480;
function buildPythonProfilerStartCode(options) {
  const duration = options.durationSeconds === void 0 ? "None" : String(validateDuration(options.durationSeconds));
  const clock = options.clock === "WALL" ? "WALL" : "CPU";
  const profileThreads = options.target === "all" ? "True" : "False";
  return [
    "import yappi,threading,time",
    `_mcdev_pp_clock='${clock}'`,
    `_mcdev_pp_duration=${duration}`,
    "if yappi.is_running() and not globals().get('_mcdev_pp_owned',False):",
    " _result={'ok':False,'reason':'busy'}",
    "else:",
    " _mcdev_pp_old=globals().get('_mcdev_pp_timer')",
    " if _mcdev_pp_old: _mcdev_pp_old.cancel()",
    " if globals().get('_mcdev_pp_owned',False) and yappi.is_running(): yappi.stop()",
    " yappi.clear_stats()",
    " yappi.set_clock_type(_mcdev_pp_clock)",
    ` yappi.start(False,${profileThreads})`,
    " globals()['_mcdev_pp_owned']=True",
    " globals()['_mcdev_pp_started']=time.time()",
    " globals()['_mcdev_pp_stopped']=None",
    " globals()['_mcdev_pp_clock']=_mcdev_pp_clock",
    " globals()['_mcdev_pp_timer']=None",
    " if _mcdev_pp_duration is not None:",
    "  def _mcdev_pp_timeout():",
    "   try:",
    "    if globals().get('_mcdev_pp_owned',False) and yappi.is_running():",
    "     yappi.stop()",
    "     globals()['_mcdev_pp_stopped']=time.time()",
    "   except: pass",
    "  _mcdev_pp_timer=threading.Timer(_mcdev_pp_duration,_mcdev_pp_timeout)",
    "  _mcdev_pp_timer.daemon=True",
    "  _mcdev_pp_timer.start()",
    "  globals()['_mcdev_pp_timer']=_mcdev_pp_timer",
    " _result={'ok':True,'running':True,'clock':_mcdev_pp_clock}"
  ].join("\n");
}
function buildPythonProfilerMarkCode(target) {
  const marker = `_mcdev_pp_${target}_marker`;
  return [
    `def ${marker}(): pass`,
    `${marker}()`,
    "_result=True"
  ].join("\n");
}
function buildPythonProfilerCollectCode(target) {
  const contextSetup = target === "all" ? [
    " _mcdev_pp_contexts={}",
    " _mcdev_pp_root=yappi.get_func_stats()",
    " for _mcdev_pp_stat in _mcdev_pp_root:",
    "  if _mcdev_pp_stat.name=='_mcdev_pp_client_marker': _mcdev_pp_contexts['client']=int(_mcdev_pp_stat.ctx_id or 0)",
    "  elif _mcdev_pp_stat.name=='_mcdev_pp_server_marker': _mcdev_pp_contexts['server']=int(_mcdev_pp_stat.ctx_id or 0)"
  ] : [" _mcdev_pp_contexts={}"];
  const scriptSetup = target === "all" ? [
    "  _mcdev_pp_side_scripts={'client':set(),'server':set()}",
    "  _mcdev_pp_side_scripts['client']=set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'clientScriptNameList',[]) or []) if _mcdev_pp_name)",
    "  _mcdev_pp_side_scripts['server']=set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'serverScriptNameList',[]) or []) if _mcdev_pp_name)",
    " except: _mcdev_pp_side_scripts={'client':set(),'server':set()}",
    " _mcdev_pp_sources=[]",
    " for _mcdev_pp_side in ('client','server'):",
    "  _mcdev_pp_ctx=_mcdev_pp_contexts.get(_mcdev_pp_side)",
    "  if _mcdev_pp_ctx is not None:",
    "   _mcdev_pp_sources.append((_mcdev_pp_side,yappi.get_func_stats({'ctx_id':_mcdev_pp_ctx}),_mcdev_pp_side_scripts[_mcdev_pp_side]))"
  ] : [
    `  _mcdev_pp_scripts=set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'${target === "client" ? "clientScriptNameList" : "serverScriptNameList"}',[]) or []) if _mcdev_pp_name)`,
    " except: _mcdev_pp_scripts=set()",
    ` _mcdev_pp_sources=[('${target}',yappi.get_func_stats(),_mcdev_pp_scripts)]`
  ];
  return [
    "import yappi,time",
    "if not globals().get('_mcdev_pp_owned',False):",
    " _result={'ok':False,'reason':'not_owned'}",
    "else:",
    " _mcdev_pp_timer=globals().get('_mcdev_pp_timer')",
    " if _mcdev_pp_timer: _mcdev_pp_timer.cancel()",
    " if yappi.is_running():",
    "  yappi.stop()",
    "  globals()['_mcdev_pp_stopped']=time.time()",
    ...contextSetup,
    " try:",
    "  import common.minecraftMod as _mcdev_pp_mod",
    "  _mcdev_pp_instance=_mcdev_pp_mod.instance()",
    ...scriptSetup,
    " _mcdev_pp_all=[]",
    " for _mcdev_pp_side,_mcdev_pp_stats,_mcdev_pp_scripts in _mcdev_pp_sources:",
    "  for _mcdev_pp_stat in _mcdev_pp_stats:",
    "   _mcdev_pp_module=_mcdev_pp_stat.module or ''",
    "   _mcdev_pp_parts=set(_mcdev_pp_module.replace('\\\\','/').split('/'))",
    "   _mcdev_pp_project=any(_mcdev_pp_name in _mcdev_pp_parts or _mcdev_pp_module==_mcdev_pp_name or _mcdev_pp_module.startswith(_mcdev_pp_name+'.') for _mcdev_pp_name in _mcdev_pp_scripts)",
    "   if _mcdev_pp_project and not _mcdev_pp_stat.name.startswith('_mcdev_pp_'): _mcdev_pp_all.append((_mcdev_pp_side,_mcdev_pp_stat))",
    " _mcdev_pp_all.sort(key=lambda _mcdev_pp_item:_mcdev_pp_item[1].ttot,reverse=True)",
    ` _mcdev_pp_keep=_mcdev_pp_all[:${MAX_FUNCTIONS}]`,
    " _mcdev_pp_ids=dict(((_mcdev_pp_side,_mcdev_pp_stat.index),_mcdev_pp_pos) for _mcdev_pp_pos,(_mcdev_pp_side,_mcdev_pp_stat) in enumerate(_mcdev_pp_keep))",
    " _mcdev_pp_nodes=[]",
    " for _mcdev_pp_pos,(_mcdev_pp_side,_mcdev_pp_stat) in enumerate(_mcdev_pp_keep):",
    "  _mcdev_pp_nodes.append([_mcdev_pp_pos,_mcdev_pp_stat.module or '',int(_mcdev_pp_stat.lineno or 0),_mcdev_pp_stat.name or '',int(_mcdev_pp_stat.ncall or 0),int(_mcdev_pp_stat.nactualcall or 0),float(_mcdev_pp_stat.tsub or 0),float(_mcdev_pp_stat.ttot or 0),int(_mcdev_pp_stat.ctx_id or 0),_mcdev_pp_stat.ctx_name or '',_mcdev_pp_side])",
    " _mcdev_pp_edges=[]",
    " for _mcdev_pp_side,_mcdev_pp_parent in _mcdev_pp_keep:",
    "  for _mcdev_pp_child in _mcdev_pp_parent.children:",
    "   _mcdev_pp_child_key=(_mcdev_pp_side,_mcdev_pp_child.index)",
    "   if _mcdev_pp_child_key in _mcdev_pp_ids:",
    "    _mcdev_pp_edges.append([_mcdev_pp_ids[(_mcdev_pp_side,_mcdev_pp_parent.index)],_mcdev_pp_ids[_mcdev_pp_child_key],int(_mcdev_pp_child.ncall or 0),float(_mcdev_pp_child.tsub or 0),float(_mcdev_pp_child.ttot or 0)])",
    `    if len(_mcdev_pp_edges)>=${MAX_CALLS}: break`,
    `  if len(_mcdev_pp_edges)>=${MAX_CALLS}: break`,
    " _mcdev_pp_end=globals().get('_mcdev_pp_stopped') or time.time()",
    " _result={'ok':True,'clock':globals().get('_mcdev_pp_clock','CPU'),'elapsed':max(0,_mcdev_pp_end-globals().get('_mcdev_pp_started',_mcdev_pp_end)),'total':len(_mcdev_pp_all),'truncated':len(_mcdev_pp_all)>len(_mcdev_pp_keep),'targets':list(_mcdev_pp_contexts.keys()),'nodes':_mcdev_pp_nodes,'edges':_mcdev_pp_edges}",
    " yappi.clear_stats()",
    " globals()['_mcdev_pp_owned']=False",
    " globals()['_mcdev_pp_timer']=None",
    " globals()['_mcdev_pp_stopped']=None"
  ].join("\n");
}
function buildPythonProfilerCleanupCode() {
  return [
    "import yappi",
    "_mcdev_pp_timer=globals().get('_mcdev_pp_timer')",
    "if _mcdev_pp_timer: _mcdev_pp_timer.cancel()",
    "if globals().get('_mcdev_pp_owned',False):",
    " if yappi.is_running(): yappi.stop()",
    " yappi.clear_stats()",
    "globals()['_mcdev_pp_owned']=False",
    "globals()['_mcdev_pp_timer']=None",
    "globals()['_mcdev_pp_stopped']=None",
    "_result=True"
  ].join("\n");
}
function parsePythonProfilerStart(value) {
  const record = asRecord(value);
  if (record.ok === true) {
    return;
  }
  if (record.reason === "busy") {
    throw new Error("Another Python profiler is already running in this target");
  }
  throw new Error("Python profiler could not be started");
}
function parsePythonProfilerResult(value, target = "client") {
  const record = asRecord(value);
  if (record.ok !== true) {
    throw new Error(record.reason === "not_owned" ? "No MC Dev Tools Python profile is active" : "Python profiler did not return a result");
  }
  const clock = record.clock === "WALL" ? "WALL" : "CPU";
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const edges = Array.isArray(record.edges) ? record.edges : [];
  if (target === "all") {
    const markedTargets = new Set(Array.isArray(record.targets) ? record.targets : []);
    if (!markedTargets.has("client") || !markedTargets.has("server")) {
      throw new Error("Python profiler could not distinguish client and server thread contexts");
    }
  }
  const functions = nodes.slice(0, MAX_FUNCTIONS).map((value2) => parseFunctionRow(value2, target)).filter(isDefined);
  const functionsById = new Map(functions.map((item) => [item.id, item]));
  const calls = edges.slice(0, MAX_CALLS).map(parseCallRow).filter(isDefined).filter((item) => functionsById.has(item.callerId) && functionsById.has(item.calleeId) && functionsById.get(item.callerId)?.target === functionsById.get(item.calleeId)?.target);
  return {
    clock,
    elapsedSeconds: finiteNumber(record.elapsed),
    totalFunctions: Math.max(functions.length, finiteInteger(record.total)),
    truncated: record.truncated === true,
    functions,
    calls
  };
}
function validateDuration(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Profile duration must be greater than zero");
  }
  return value;
}
function parseFunctionRow(value, fallbackTarget) {
  if (!Array.isArray(value) || value.length < 10) {
    return void 0;
  }
  const id = finiteInteger(value[0], -1);
  if (id < 0 || typeof value[1] !== "string" || typeof value[3] !== "string") {
    return void 0;
  }
  const rowTarget = value[10] === "client" || value[10] === "server" ? value[10] : void 0;
  const target = rowTarget ?? (fallbackTarget === "all" ? void 0 : fallbackTarget);
  if (!target) {
    return void 0;
  }
  return {
    id,
    target,
    module: value[1].slice(0, 4096),
    line: finiteInteger(value[2]),
    name: value[3].slice(0, 512),
    calls: finiteInteger(value[4]),
    actualCalls: finiteInteger(value[5]),
    selfTime: finiteNumber(value[6]),
    totalTime: finiteNumber(value[7]),
    contextId: finiteInteger(value[8]),
    contextName: typeof value[9] === "string" ? value[9].slice(0, 512) : ""
  };
}
function parseCallRow(value) {
  if (!Array.isArray(value) || value.length < 5) {
    return void 0;
  }
  const callerId = finiteInteger(value[0], -1);
  const calleeId = finiteInteger(value[1], -1);
  if (callerId < 0 || calleeId < 0) {
    return void 0;
  }
  return {
    callerId,
    calleeId,
    calls: finiteInteger(value[2]),
    selfTime: finiteNumber(value[3]),
    totalTime: finiteNumber(value[4])
  };
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Python profiler returned an invalid payload");
  }
  return value;
}
function finiteInteger(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function isDefined(value) {
  return value !== void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildPythonProfilerCleanupCode,
  buildPythonProfilerCollectCode,
  buildPythonProfilerMarkCode,
  buildPythonProfilerStartCode,
  parsePythonProfilerResult,
  parsePythonProfilerStart
});
