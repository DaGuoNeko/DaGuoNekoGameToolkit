const fs = require("node:fs"),
  path = require("node:path");
const norm = (v) =>
  v
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .toLowerCase();
class NativeGameTitles {
  constructor(runtime) {
    if (process.platform !== "win32" || process.arch !== "x64")
      throw Error("Window titles require Windows x64");
    const k = (this.k = require(path.join(runtime, "native/koffi.node")));
    const user = k.load("user32.dll"),
      kernel = k.load("kernel32.dll"),
      nt = k.load("ntdll.dll");
    this.open = kernel.func(
      "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    );
    this.close = kernel.func("int __stdcall CloseHandle(void *handle)");
    this.wait = kernel.func(
      "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)",
    );
    this.image = kernel.func(
      "int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, void *buffer, _Inout_ uint32_t *length)",
    );
    this.query = nt.func(
      "int32_t __stdcall NtQueryInformationProcess(void *handle, uint32_t kind, void *buffer, uint32_t length, _Out_ uint32_t *written)",
    );
    this.nextWindow = user.func(
      "uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, void *className, void *title)",
    );
    this.pid = user.func(
      "uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)",
    );
    this.cls = user.func(
      "int __stdcall GetClassNameW(uintptr_t hwnd, void *buffer, int count)",
    );
    this.text = user.func(
      "int __stdcall GetWindowTextW(uintptr_t hwnd, void *buffer, int count)",
    );
    this.send = user.func(
      "intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t w, void *text, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)",
    );
    this.entries = new Map();
  }
  windows(pids) {
    const windows = [];
    let hwnd = 0;
    const seen = new Set(),
      className = Buffer.from("OGLES\0", "utf16le");
    while (
      (hwnd = this.nextWindow(0, hwnd, className, null)) &&
      !seen.has(hwnd) &&
      seen.size < 512
    ) {
      seen.add(hwnd);
      const pid = [0],
        cls = Buffer.alloc(128),
        text = Buffer.alloc(1024);
      this.pid(hwnd, pid);
      if (pids && !pids.has(pid[0])) continue;
      this.cls(hwnd, cls, 64);
      if (cls.toString("utf16le").split("\0")[0] !== "OGLES") continue;
      this.text(hwnd, text, 512);
      windows.push({
        hwnd,
        pid: pid[0],
        cls: cls.toString("utf16le").split("\0")[0],
        title: text.toString("utf16le").split("\0")[0],
      });
    }
    return windows;
  }
  adopt(target) {
    let game = null,
      parent = null;
    try {
      game = this.open(0x100000 | 0x400, 0, target.pid);
      parent = this.open(0x100000, 0, target.parentPid);
      if (!game || !parent) throw Error("process unavailable");
      const basic = Buffer.alloc(48),
        size = [0],
        image = Buffer.alloc(65536),
        length = [32768];
      if (
        this.query(game, 0, basic, 48, size) < 0 ||
        size[0] !== 48 ||
        Number(basic.readBigUInt64LE(40)) !== target.parentPid ||
        !this.image(game, 0, image, length) ||
        norm(image.toString("utf16le", 0, length[0] * 2)) !==
          norm(fs.realpathSync(target.exe))
      )
        throw Error("process identity mismatch");
      return { game, parent };
    } catch (e) {
      if (game) this.close(game);
      if (parent) this.close(parent);
      throw e;
    }
  }
  update(targets) {
    const keys = new Set(targets.map((t) => t.key));
    for (const [key, entry] of this.entries)
      if (!keys.has(key)) {
        this.close(entry.game);
        this.close(entry.parent);
        this.entries.delete(key);
      }
    const windows = this.windows(new Set(targets.map((t) => t.pid)));
    let changed = 0;
    for (const t of targets) {
      if (
        !Number.isInteger(t.pid) ||
        !Number.isInteger(t.parentPid) ||
        t.pid <= 0 ||
        t.parentPid <= 0 ||
        typeof t.title !== "string" ||
        t.title.length > 180 ||
        /[\x00-\x1f]/.test(t.title)
      )
        continue;
      let entry = this.entries.get(t.key);
      if (!entry) {
        try {
          entry = this.adopt(t);
          this.entries.set(t.key, entry);
        } catch {
          continue;
        }
      }
      if (
        this.wait(entry.game, 0) !== 0x102 ||
        this.wait(entry.parent, 0) !== 0x102
      )
        continue;
      const games = windows.filter((w) => w.pid === t.pid && w.cls === "OGLES");
      if (games.length !== 1 || games[0].title === t.title) continue;
      const w = games[0],
        owner = [0];
      this.pid(w.hwnd, owner);
      if (owner[0] !== t.pid) continue;
      if (
        this.send(
          w.hwnd,
          0x000c,
          0,
          Buffer.from(t.title + "\0", "utf16le"),
          0x23,
          200,
          [0],
        )
      )
        changed++;
    }
    return changed;
  }
  dispose() {
    for (const e of this.entries.values()) {
      this.close(e.game);
      this.close(e.parent);
    }
    this.entries.clear();
  }
}
module.exports = { NativeGameTitles };
