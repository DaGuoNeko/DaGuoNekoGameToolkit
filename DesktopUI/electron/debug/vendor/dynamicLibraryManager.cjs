// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/native/dynamicLibraryManager.ts; see licenses/MCDevTools-LICENSE.txt.
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
  dynamicLibraryManager: () => dynamicLibraryManager
});
module.exports = __toCommonJS(stdin_exports);
var path = __toESM(require("path"));
class DynamicLibraryManager {
  handles = /* @__PURE__ */ new Map();
  pendingCalls = /* @__PURE__ */ new Set();
  koffi;
  disposing = false;
  unloadPromise;
  run(libraryPath, operation) {
    if (this.disposing) {
      return Promise.reject(new Error("Native libraries are being unloaded"));
    }
    const call = Promise.resolve().then(() => {
      if (this.disposing) {
        throw new Error("Native libraries are being unloaded");
      }
      const resolvedPath = path.resolve(libraryPath);
      const libraryKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
      const koffi = this.koffi ?? require(path.join(path.dirname(resolvedPath), "koffi.node"));
      this.koffi = koffi;
      let entry = this.handles.get(libraryKey);
      if (!entry) {
        entry = { path: resolvedPath, handle: koffi.load(resolvedPath) };
        this.handles.set(libraryKey, entry);
      }
      return operation(entry.handle, koffi);
    });
    this.pendingCalls.add(call);
    void call.finally(() => this.pendingCalls.delete(call)).catch(() => void 0);
    return call;
  }
  unloadAll() {
    if (!this.unloadPromise) {
      this.disposing = true;
      this.unloadPromise = this.finishUnload();
    }
    return this.unloadPromise;
  }
  async finishUnload() {
    await Promise.allSettled(Array.from(this.pendingCalls));
    for (const { path: libraryPath, handle } of Array.from(this.handles.values()).reverse()) {
      try {
        handle.unload();
      } catch (error) {
        console.error(`Failed to unload native library: ${libraryPath}`, error);
      }
    }
    this.handles.clear();
    this.koffi = void 0;
  }
}
const dynamicLibraryManager = new DynamicLibraryManager();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  dynamicLibraryManager
});
