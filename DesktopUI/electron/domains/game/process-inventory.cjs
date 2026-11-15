const fs = require("node:fs"), path = require("node:path");
let native;

function api() {
  if (native) return native;
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("进程身份检查需要 Windows x64");
  const candidates = [process.resourcesPath && path.join(process.resourcesPath, "runtime/native/koffi.node"), path.join(__dirname, "../runtime/native/koffi.node"), path.join(__dirname, "../../../runtime/native/koffi.node")].filter(Boolean);
  const runtime = candidates.find(file => fs.existsSync(file));
  if (!runtime) throw Error("缺少进程身份检查运行库，请完整解压工具箱");
  const k = require(runtime), kernel = k.load("kernel32.dll"), security = k.load("advapi32.dll");
  const entryType = k.struct({
    dwSize: "uint32_t", cntUsage: "uint32_t", th32ProcessID: "uint32_t", th32DefaultHeapID: "uintptr_t",
    th32ModuleID: "uint32_t", cntThreads: "uint32_t", th32ParentProcessID: "uint32_t", pcPriClassBase: "int32_t", dwFlags: "uint32_t", szExeFile: k.array("uint16_t", 260),
  });
  native = {
    k, entryType, kernel, security,
    snapshot: kernel.func("CreateToolhelp32Snapshot", "intptr_t", ["uint32_t", "uint32_t"]),
    first: kernel.func("Process32FirstW", "bool", ["intptr_t", k.inout(k.pointer(entryType))]),
    next: kernel.func("Process32NextW", "bool", ["intptr_t", k.inout(k.pointer(entryType))]),
    open: kernel.func("OpenProcess", "intptr_t", ["uint32_t", "bool", "uint32_t"]),
    close: kernel.func("CloseHandle", "bool", ["intptr_t"]),
    error: kernel.func("GetLastError", "uint32_t", []),
    current: kernel.func("GetCurrentProcess", "intptr_t", []),
    image: kernel.func("QueryFullProcessImageNameW", "bool", ["intptr_t", "uint32_t", "void *", k.inout(k.pointer("uint32_t"))]),
    token: security.func("OpenProcessToken", "bool", ["intptr_t", "uint32_t", k.out(k.pointer("intptr_t"))]),
    info: security.func("GetTokenInformation", "bool", ["intptr_t", "int", "void *", "uint32_t", k.out(k.pointer("uint32_t"))]),
    validSid: security.func("IsValidSid", "bool", ["void *"]),
    sidLength: security.func("GetLengthSid", "uint32_t", ["void *"]),
  };
  return native;
}

function ownerSid(a, processHandle) {
  const token = [0];
  if (!a.token(processHandle, 8, token)) return null;
  try {
    const needed = [0];
    a.info(token[0], 1, null, 0, needed);
    if (needed[0] < 16 || needed[0] > 65536) return null;
    const buffer = Buffer.alloc(needed[0]);
    if (!a.info(token[0], 1, buffer, buffer.length, needed)) return null;
    const pointer = a.k.decode(buffer, "void *");
    if (!pointer || !a.validSid(pointer)) return null;
    const length = a.sidLength(pointer);
    if (length < 8 || length > 68) return null;
    const bytes = Buffer.from(a.k.decode(pointer, "uint8_t", length));
    if (length !== 8 + 4 * bytes[1]) return null;
    const parts = ["S", bytes[0], bytes.readUIntBE(2, 6)];
    for (let i = 0; i < bytes[1]; i++) parts.push(bytes.readUInt32LE(8 + i * 4));
    return parts.join("-");
  } finally { a.close(token[0]); }
}

function inventory(names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  if (!wanted.size) return [];
  const a = api(), currentSid = ownerSid(a, a.current());
  if (!currentSid) throw Error("无法读取当前用户 SID，未执行游戏操作");
  const snapshot = a.snapshot(2, 0);
  if (snapshot === -1 || snapshot === -1n) throw Error("无法枚举进程（" + a.error() + "）");
  const rows = [], entry = { dwSize: a.k.sizeof(a.entryType) };
  const started = Date.now();
  try {
    let ok = a.first(snapshot, entry);
    while (ok) {
      if (Date.now() - started > 10000) throw Error("进程身份检查超时，未执行游戏操作");
      const end = entry.szExeFile.indexOf(0);
      const name = String.fromCharCode(...entry.szExeFile.slice(0, end < 0 ? 260 : end));
      if (wanted.has(name.toLowerCase())) {
        const pid = entry.th32ProcessID;
        // 有限查询权限读取 EXE 和 token；无法确认时保留 null，让冲突保护拒绝继续。
        const handle = a.open(0x1000, false, pid);
        if (!handle) {
          if (![87, 1168].includes(a.error())) rows.push({ pid, name, path: null, ownerSid: null, currentSid });
        } else {
          try {
            const buffer = Buffer.alloc(65536), size = [32768];
            const file = a.image(handle, 0, buffer, size) ? buffer.toString("utf16le", 0, size[0] * 2) : null;
            if (file && path.win32.basename(file).toLowerCase() !== name.toLowerCase()) throw Error("进程身份在检查期间变化，请重试");
            rows.push({ pid, name, path: file, ownerSid: ownerSid(a, handle), currentSid });
          } finally { a.close(handle); }
        }
      }
      ok = a.next(snapshot, entry);
    }
    if (a.error() !== 18) throw Error("进程枚举未完成（" + a.error() + "）");
    return rows;
  } finally { a.close(snapshot); }
}

module.exports = { inventory };
