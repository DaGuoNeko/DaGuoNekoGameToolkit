module.exports = (app, pid) =>
  app.evaluate(({ app, BrowserWindow }, pid) => {
    if (!globalThis.tracyWindowTest) {
      const path = process.mainModule.require("node:path"),
        k = process.mainModule.require(
          path.join(
            app.isPackaged ? process.resourcesPath : app.getAppPath(),
            "runtime/native/koffi.node",
          ),
        ),
        u = k.load("user32.dll");
      globalThis.tracyWindowTest = {
        k,
        u,
        callback: k.proto(
          "int __stdcall DgnTracyTestEnum(uintptr_t hwnd, intptr_t param)",
        ),
        enumerate: u.func(
          "int __stdcall EnumWindows(void *callback, intptr_t param)",
        ),
        pid: u.func(
          "uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)",
        ),
        title: u.func(
          "int __stdcall GetWindowTextW(uintptr_t hwnd, void *text, int count)",
        ),
        parent: u.func("uintptr_t __stdcall GetParent(uintptr_t hwnd)"),
        visible: u.func("int __stdcall IsWindowVisible(uintptr_t hwnd)"),
        rect: u.func("int __stdcall GetWindowRect(uintptr_t hwnd, void *rect)"),
      };
    }
    const t = globalThis.tracyWindowTest;
    let value;
    const cb = t.k.register((hwnd) => {
      const owner = [0],
        text = Buffer.alloc(1024);
      t.pid(hwnd, owner);
      t.title(hwnd, text, 512);
      if (
        owner[0] === pid &&
        text.toString("utf16le").includes("Tracy Profiler")
      ) {
        const rect = Buffer.alloc(16);
        t.rect(hwnd, rect);
        value = {
          hwnd: Number(hwnd),
          owner: Number(t.parent(hwnd)),
          visible: !!t.visible(hwnd),
          rect: [0, 4, 8, 12].map((n) => rect.readInt32LE(n)),
        };
        return 0;
      }
      return 1;
    }, t.k.pointer(t.callback));
    try {
      t.enumerate(cb, 0);
    } finally {
      t.k.unregister(cb);
    }
    return {
      ...value,
      host: Number(
        BrowserWindow.getAllWindows()[0]
          .getNativeWindowHandle()
          .readBigUInt64LE(),
      ),
    };
  }, pid);
