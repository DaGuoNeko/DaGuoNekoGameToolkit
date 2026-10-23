// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/pythonMemoryProfiler.ts; see licenses/MCDevTools-LICENSE.txt.
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
  PYTHON_MEMORY_DEFAULT_DEPTH: () => PYTHON_MEMORY_DEFAULT_DEPTH,
  PYTHON_MEMORY_MAX_DEPTH: () => PYTHON_MEMORY_MAX_DEPTH,
  buildPythonMemoryCleanupCode: () => buildPythonMemoryCleanupCode,
  buildPythonMemoryCollectCode: () => buildPythonMemoryCollectCode,
  buildPythonMemoryStartCode: () => buildPythonMemoryStartCode,
  parsePythonMemoryResult: () => parsePythonMemoryResult,
  parsePythonMemoryStart: () => parsePythonMemoryStart
});
module.exports = __toCommonJS(stdin_exports);
const PYTHON_MEMORY_DEFAULT_DEPTH = 8;
const PYTHON_MEMORY_MAX_DEPTH = 16;
const MAX_ALLOCATIONS = 80;
function buildPythonMemoryStartCode(options) {
  const depth = validateDepth(options.tracebackDepth);
  return [
    "import tracemalloc,time",
    "if tracemalloc.is_tracing() and not globals().get('_mcdev_pm_owned',False):",
    " _result={'ok':False,'reason':'busy'}",
    "else:",
    " if globals().get('_mcdev_pm_owned',False) and tracemalloc.is_tracing(): tracemalloc.stop()",
    ` tracemalloc.start(${depth})`,
    " globals()['_mcdev_pm_owned']=True",
    ` globals()['_mcdev_pm_depth']=${depth}`,
    " globals()['_mcdev_pm_started']=time.time()",
    " globals()['_mcdev_pm_base']=tracemalloc.take_snapshot()",
    ` _result={'ok':True,'depth':${depth}}`
  ].join("\n");
}
function buildPythonMemoryCollectCode(collectGarbage) {
  return [
    "import tracemalloc,time,gc",
    "if not globals().get('_mcdev_pm_owned',False) or not tracemalloc.is_tracing():",
    " _result={'ok':False,'reason':'not_owned'}",
    "else:",
    collectGarbage ? " gc.collect()" : " pass",
    " _mcdev_pm_base=globals().get('_mcdev_pm_base')",
    " _mcdev_pm_now=tracemalloc.take_snapshot()",
    " _mcdev_pm_stats=_mcdev_pm_now.compare_to(_mcdev_pm_base,'traceback')",
    " try:",
    "  import common.minecraftMod as _mcdev_pm_mod",
    "  _mcdev_pm_instance=_mcdev_pm_mod.instance()",
    "  _mcdev_pm_scripts=set(_mcdev_pm_name for _mcdev_pm_name in ((getattr(_mcdev_pm_instance,'clientScriptNameList',[]) or [])+(getattr(_mcdev_pm_instance,'serverScriptNameList',[]) or [])) if _mcdev_pm_name)",
    " except: _mcdev_pm_scripts=[]",
    " _mcdev_pm_all=[]",
    " for _mcdev_pm_stat in _mcdev_pm_stats:",
    "  _mcdev_pm_project=False",
    "  _mcdev_pm_origin=(_mcdev_pm_stat.traceback[0].filename or '').replace('\\\\','/').lower()",
    "  if 'qumodlibs' in set(_mcdev_pm_origin.split('/')): continue",
    "  for _mcdev_pm_frame in _mcdev_pm_stat.traceback:",
    "   _mcdev_pm_file=_mcdev_pm_frame.filename or ''",
    "   _mcdev_pm_norm=_mcdev_pm_file.replace('\\\\','/').lower()",
    "   _mcdev_pm_parts=set(_mcdev_pm_norm.split('/'))",
    "   if any(_mcdev_pm_name.lower() in _mcdev_pm_parts or _mcdev_pm_norm==_mcdev_pm_name.lower() or _mcdev_pm_norm.startswith(_mcdev_pm_name.lower()+'.') for _mcdev_pm_name in _mcdev_pm_scripts):",
    "    _mcdev_pm_project=True",
    "    break",
    "  if _mcdev_pm_project: _mcdev_pm_all.append(_mcdev_pm_stat)",
    " _mcdev_pm_all.sort(key=lambda _mcdev_pm_stat:abs(_mcdev_pm_stat.size_diff),reverse=True)",
    ` _mcdev_pm_keep=_mcdev_pm_all[:${MAX_ALLOCATIONS}]`,
    " _mcdev_pm_rows=[]",
    " for _mcdev_pm_id,_mcdev_pm_stat in enumerate(_mcdev_pm_keep):",
    "  _mcdev_pm_frames=[[_mcdev_pm_frame.filename or '',int(_mcdev_pm_frame.lineno or 0)] for _mcdev_pm_frame in _mcdev_pm_stat.traceback]",
    "  _mcdev_pm_rows.append([_mcdev_pm_id,int(_mcdev_pm_stat.size_diff),int(_mcdev_pm_stat.count_diff),int(_mcdev_pm_stat.size),int(_mcdev_pm_stat.count),_mcdev_pm_frames])",
    " _result={'ok':True,'elapsed':max(0,time.time()-globals().get('_mcdev_pm_started',time.time())),'depth':int(globals().get('_mcdev_pm_depth',1)),'sizeDiff':sum(_mcdev_pm_stat.size_diff for _mcdev_pm_stat in _mcdev_pm_all),'countDiff':sum(_mcdev_pm_stat.count_diff for _mcdev_pm_stat in _mcdev_pm_all),'size':sum(_mcdev_pm_stat.size for _mcdev_pm_stat in _mcdev_pm_all),'count':sum(_mcdev_pm_stat.count for _mcdev_pm_stat in _mcdev_pm_all),'total':len(_mcdev_pm_all),'truncated':len(_mcdev_pm_all)>len(_mcdev_pm_keep),'rows':_mcdev_pm_rows}",
    " tracemalloc.stop()",
    " globals()['_mcdev_pm_owned']=False",
    " globals()['_mcdev_pm_base']=None",
    " globals()['_mcdev_pm_started']=None"
  ].join("\n");
}
function buildPythonMemoryCleanupCode() {
  return [
    "import tracemalloc",
    "if globals().get('_mcdev_pm_owned',False) and tracemalloc.is_tracing(): tracemalloc.stop()",
    "globals()['_mcdev_pm_owned']=False",
    "globals()['_mcdev_pm_base']=None",
    "globals()['_mcdev_pm_started']=None",
    "_result=True"
  ].join("\n");
}
function parsePythonMemoryStart(value) {
  const record = asRecord(value);
  if (record.ok === true) {
    return;
  }
  if (record.reason === "busy") {
    throw new Error("Another Python memory tracer is already active in this game process");
  }
  throw new Error("Python memory tracing could not be started");
}
function parsePythonMemoryResult(value) {
  const record = asRecord(value);
  if (record.ok !== true) {
    throw new Error(record.reason === "not_owned" ? "No MC Dev Tools Python memory capture is active" : "Python memory tracer did not return a result");
  }
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const allocations = rows.slice(0, MAX_ALLOCATIONS).map(parseAllocation).filter(isDefined);
  return {
    elapsedSeconds: nonNegativeNumber(record.elapsed),
    tracebackDepth: clampInteger(record.depth, 1, PYTHON_MEMORY_MAX_DEPTH, 1),
    netSizeDiff: finiteInteger(record.sizeDiff),
    netCountDiff: finiteInteger(record.countDiff),
    currentSize: nonNegativeInteger(record.size),
    currentCount: nonNegativeInteger(record.count),
    totalAllocations: Math.max(allocations.length, nonNegativeInteger(record.total)),
    truncated: record.truncated === true,
    allocations
  };
}
function parseAllocation(value) {
  if (!Array.isArray(value) || value.length < 6 || !Array.isArray(value[5])) {
    return void 0;
  }
  const id = nonNegativeInteger(value[0], -1);
  if (id < 0) {
    return void 0;
  }
  const traceback = value[5].slice(0, PYTHON_MEMORY_MAX_DEPTH).map(parseFrame).filter(isDefined);
  if (traceback.length === 0) {
    return void 0;
  }
  return {
    id,
    sizeDiff: finiteInteger(value[1]),
    countDiff: finiteInteger(value[2]),
    currentSize: nonNegativeInteger(value[3]),
    currentCount: nonNegativeInteger(value[4]),
    traceback
  };
}
function parseFrame(value) {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return void 0;
  }
  return {
    file: value[0].slice(0, 4096),
    line: nonNegativeInteger(value[1])
  };
}
function validateDepth(value) {
  if (!Number.isInteger(value) || value < 1 || value > PYTHON_MEMORY_MAX_DEPTH) {
    throw new Error(`Traceback depth must be between 1 and ${PYTHON_MEMORY_MAX_DEPTH}`);
  }
  return value;
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Python memory tracer returned an invalid payload");
  }
  return value;
}
function finiteInteger(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}
function nonNegativeInteger(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function clampInteger(value, minimum, maximum, fallback) {
  return Math.max(minimum, Math.min(maximum, finiteInteger(value, fallback)));
}
function isDefined(value) {
  return value !== void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PYTHON_MEMORY_DEFAULT_DEPTH,
  PYTHON_MEMORY_MAX_DEPTH,
  buildPythonMemoryCleanupCode,
  buildPythonMemoryCollectCode,
  buildPythonMemoryStartCode,
  parsePythonMemoryResult,
  parsePythonMemoryStart
});
