// Adapted from Dofes/mcdev-tools a31d4a4514593c78745dded5cad19eab0d87fb4b (MIT).
// Original: src/hostBridge/nativeProfilerCapture.ts; see licenses/MCDevTools-LICENSE.txt.
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
  NativeProfilerCapture: () => NativeProfilerCapture,
  parseNativeProfilerResult: () => parseNativeProfilerResult,
  resolveTracyBridge: () => resolveTracyBridge,
  shutdownAllNativeProfilerCaptures: () => shutdownAllNativeProfilerCaptures
});
module.exports = __toCommonJS(stdin_exports);
var import_fs = require("fs");
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_dynamicLibraryManager = require("./dynamicLibraryManager.cjs");
const BRIDGE_API_VERSION = 1;
const MAXIMUM_RESULT_BYTES = 16 * 1024 * 1024;
const STATUS_COMPLETED = 4;
const STATUS_FAILED = 5;
const bindingsByLibrary = /* @__PURE__ */ new WeakMap();
let bridgeActivated = false;
class NativeProfilerCapture {
  constructor(libraryPath, temporaryDirectory, tracePath, handle) {
    this.libraryPath = libraryPath;
    this.temporaryDirectory = temporaryDirectory;
    this.tracePath = tracePath;
    this.handle = handle;
    this.completion = this.waitForCompletion();
  }
  libraryPath;
  temporaryDirectory;
  tracePath;
  completion;
  handle;
  released = false;
  disposePromise;
  static async start(options) {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("Native Tracy profiling currently supports Windows x64 only");
    }
    const libraryPath = resolveTracyBridge(options.extensionRoot);
    await import_fs.promises.access(libraryPath);
    const temporaryDirectory = await import_fs.promises.mkdtemp(path.join(os.tmpdir(), "mcdev-native-profile-"));
    const tracePath = path.join(temporaryDirectory, "capture.tracy");
    try {
      bridgeActivated = true;
      const handle = await withBridge(libraryPath, (bindings) => {
        const apiVersion = Number(bindings.apiVersion());
        const protocolVersion = String(bindings.protocolVersion());
        if (apiVersion !== BRIDGE_API_VERSION) {
          throw new Error(`Unsupported MC Dev Tools Tracy bridge API: ${apiVersion}`);
        }
        if (protocolVersion !== "0.11.1") {
          throw new Error(`Unsupported Tracy bridge protocol version: ${protocolVersion}`);
        }
        const value = bindings.start(
          "127.0.0.1",
          options.port,
          Math.ceil(options.maximumSeconds),
          options.memoryLimitPercent ?? 50,
          160,
          tracePath
        );
        if (value === null || value === void 0) {
          throw new Error(readLastError(bindings) || "Unable to start native Tracy capture");
        }
        return value;
      });
      return new NativeProfilerCapture(libraryPath, temporaryDirectory, tracePath, handle);
    } catch (error) {
      await removeTemporaryDirectory(temporaryDirectory);
      throw error;
    }
  }
  async stop() {
    const handle = this.handle;
    if (this.released || handle === void 0) return;
    await withBridge(this.libraryPath, (bindings) => {
      if (Number(bindings.stop(handle)) !== 0) {
        throw new Error("The native Tracy capture handle is no longer available");
      }
    });
  }
  dispose() {
    this.disposePromise ??= this.performDispose();
    return this.disposePromise;
  }
  async performDispose() {
    await this.stop().catch(() => void 0);
    await this.completion.catch(() => void 0);
    await removeTemporaryDirectory(this.temporaryDirectory);
  }
  async waitForCompletion() {
    try {
      while (true) {
        const status = await withBridge(this.libraryPath, (bindings) => Number(bindings.status(this.handle)));
        if (status === STATUS_COMPLETED) {
          const json = await withBridge(this.libraryPath, (bindings) => readSessionString(bindings, this.handle, false));
          const result = parseNativeProfilerResult(json);
          const stat = await import_fs.promises.stat(this.tracePath);
          if (!stat.isFile() || stat.size === 0) {
            throw new Error("Native Tracy capture completed without producing a trace");
          }
          return {
            tracePath: this.tracePath,
            capturedSeconds: result.capturedSeconds,
            result
          };
        }
        if (status === STATUS_FAILED) {
          const error = await withBridge(this.libraryPath, (bindings) => readSessionString(bindings, this.handle, true));
          throw new Error(error || "Native Tracy capture failed");
        }
        if (status < 1 || status > STATUS_FAILED) {
          throw new Error(`Native Tracy bridge returned an invalid status: ${status}`);
        }
        await delay(40);
      }
    } finally {
      await this.release();
    }
  }
  async release() {
    if (this.released) return;
    this.released = true;
    const handle = this.handle;
    this.handle = void 0;
    if (handle === void 0) return;
    await withBridge(this.libraryPath, (bindings) => new Promise((resolve, reject) => {
      bindings.release.async(handle, (error, result) => {
        if (error) {
          reject(error);
        } else if (Number(result) !== 0) {
          reject(new Error("Unable to release the native Tracy capture handle"));
        } else {
          resolve();
        }
      });
    }));
  }
}
function resolveTracyBridge(extensionRoot) {
  return path.join(
    extensionRoot,
    "native",
    "mcdev-tracy-bridge.dll"
  );
}
async function shutdownAllNativeProfilerCaptures(extensionRoot) {
  if (!bridgeActivated) return;
  const libraryPath = resolveTracyBridge(extensionRoot);
  try {
    await import_fs.promises.access(libraryPath);
  } catch {
    return;
  }
  await withBridge(libraryPath, (bindings) => new Promise((resolve, reject) => {
    bindings.shutdownAll.async((error) => error ? reject(error) : resolve());
  }));
}
function withBridge(libraryPath, operation) {
  return import_dynamicLibraryManager.dynamicLibraryManager.run(libraryPath, (library) => {
    let bindings = bindingsByLibrary.get(library);
    if (!bindings) {
      bindings = bindBridge(library);
      bindingsByLibrary.set(library, bindings);
    }
    return operation(bindings);
  });
}
function bindBridge(library) {
  return {
    apiVersion: library.func("uint32_t mcdev_tracy_api_version()"),
    protocolVersion: library.func("const char *mcdev_tracy_protocol_version()"),
    start: library.func("void *mcdev_tracy_start(const char *, uint16_t, uint32_t, uint32_t, uint32_t, const char *)"),
    status: library.func("int32_t mcdev_tracy_get_status(void *)"),
    stop: library.func("int32_t mcdev_tracy_stop(void *)"),
    resultSize: library.func("size_t mcdev_tracy_result_size(void *)"),
    copyResult: library.func("int32_t mcdev_tracy_copy_result(void *, void *, size_t)"),
    errorSize: library.func("size_t mcdev_tracy_error_size(void *)"),
    copyError: library.func("int32_t mcdev_tracy_copy_error(void *, void *, size_t)"),
    lastErrorSize: library.func("size_t mcdev_tracy_last_error_size()"),
    copyLastError: library.func("int32_t mcdev_tracy_copy_last_error(void *, size_t)"),
    release: library.func("int32_t mcdev_tracy_release(void *)"),
    shutdownAll: library.func("void mcdev_tracy_shutdown_all()")
  };
}
function readLastError(bindings) {
  return copyNativeString(Number(bindings.lastErrorSize()), (buffer) => Number(bindings.copyLastError(buffer, buffer.length)));
}
function readSessionString(bindings, handle, error) {
  const size = Number(error ? bindings.errorSize(handle) : bindings.resultSize(handle));
  return copyNativeString(size, (buffer) => Number(
    error ? bindings.copyError(handle, buffer, buffer.length) : bindings.copyResult(handle, buffer, buffer.length)
  ));
}
function copyNativeString(size, copy) {
  if (size === 0) return "";
  if (!Number.isSafeInteger(size) || size < 1 || size > MAXIMUM_RESULT_BYTES) {
    throw new Error(`Native Tracy bridge returned an invalid string size: ${size}`);
  }
  const buffer = Buffer.alloc(size);
  if (copy(buffer) !== 0 || buffer[size - 1] !== 0) {
    throw new Error("Native Tracy bridge returned an invalid string buffer");
  }
  return buffer.toString("utf8", 0, size - 1);
}
function parseNativeProfilerResult(json) {
  const value = JSON.parse(json);
  if (!value || typeof value !== "object") {
    throw new Error("Native Tracy bridge returned an invalid result");
  }
  const result = value;
  if (!finiteNonNegative(result.capturedSeconds) || !Number.isSafeInteger(result.totalZones) || result.totalZones < 0 || typeof result.truncated !== "boolean" || typeof result.callTreeTruncated !== "boolean" || !Array.isArray(result.zones) || result.zones.length > 1e4 || !Array.isArray(result.threads) || result.threads.length > 128) {
    throw new Error("Native Tracy bridge returned invalid profile metadata");
  }
  for (const zone of result.zones) {
    if (!validZone(zone) || typeof zone.threadId !== "string" || zone.threadId.length > 64 || typeof zone.threadName !== "string" || zone.threadName.length > 4096) {
      throw new Error("Native Tracy bridge returned an invalid profile zone");
    }
  }
  const callNodes = result.threads.flatMap((thread) => {
    if (!thread || typeof thread.id !== "string" || thread.id.length > 64 || typeof thread.name !== "string" || thread.name.length > 4096 || !Number.isSafeInteger(thread.calls) || thread.calls < 0 || !finiteNonNegative(thread.totalNanoseconds) || !Array.isArray(thread.roots)) {
      throw new Error("Native Tracy bridge returned an invalid profile thread");
    }
    return thread.roots;
  });
  let callNodeCount = 0;
  while (callNodes.length > 0) {
    const node = callNodes.pop();
    if (!node || !validZone(node) || !Array.isArray(node.children)) {
      throw new Error("Native Tracy bridge returned an invalid call tree node");
    }
    callNodeCount += 1;
    if (callNodeCount > 1e4) {
      throw new Error("Native Tracy bridge returned too many call tree nodes");
    }
    callNodes.push(...node.children);
  }
  result.zones = result.zones.filter((zone) => !isIgnoredNativeSource(zone.sourceFile));
  result.threads = result.threads.flatMap((thread) => {
    thread.roots = filterIgnoredCallNodes(thread.roots);
    if (thread.roots.length === 0) return [];
    thread.totalNanoseconds = thread.roots.reduce((total, root) => total + root.totalNanoseconds, 0);
    thread.calls = countCallNodeInvocations(thread.roots);
    return [thread];
  });
  return result;
}
function filterIgnoredCallNodes(nodes) {
  return nodes.flatMap((node) => {
    node.children = filterIgnoredCallNodes(node.children);
    return isIgnoredNativeSource(node.sourceFile) ? node.children : [node];
  });
}
function countCallNodeInvocations(nodes) {
  let calls = 0;
  const pending = nodes.slice();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    calls += node.calls;
    pending.push(...node.children);
  }
  return calls;
}
function isIgnoredNativeSource(sourceFile) {
  const prefix = "DEBUG_ENV_SCRIPT";
  if (sourceFile === prefix) return true;
  if (!sourceFile.startsWith(prefix) || sourceFile.length <= prefix.length) return false;
  return [".", "/", "\\"].includes(sourceFile[prefix.length]);
}
function validZone(zone) {
  return Boolean(
    zone && typeof zone.name === "string" && zone.name.length <= 4096 && typeof zone.sourceFile === "string" && zone.sourceFile.length <= 32 * 1024 && Number.isSafeInteger(zone.id) && zone.id >= 0 && Number.isSafeInteger(zone.sourceLine) && zone.sourceLine >= 0 && Number.isSafeInteger(zone.calls) && zone.calls >= 0 && finiteNonNegative(zone.totalNanoseconds) && finiteNonNegative(zone.selfNanoseconds) && finiteNonNegative(zone.meanNanoseconds) && finiteNonNegative(zone.maximumNanoseconds)
  );
}
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
async function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("mcdev-native-profile-")) throw new Error("Unsafe native capture cleanup");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await import_fs.promises.rm(directory, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 5) await delay(400);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NativeProfilerCapture,
  parseNativeProfilerResult,
  resolveTracyBridge,
  shutdownAllNativeProfilerCaptures
});
