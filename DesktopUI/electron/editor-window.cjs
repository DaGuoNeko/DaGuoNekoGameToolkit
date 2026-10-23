const path = require("node:path");
// Only adopts the HWND returned by our own newly-created engine process.
class EditorWindow {
  constructor(runtime) {
    this.koffi = require(path.join(runtime, "native", "koffi.node"));
    const u = this.koffi.load("user32.dll");
    this.library = u;
    this.pid = u.func(
      "uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)",
    );
    this.parent = u.func("uintptr_t __stdcall GetParent(uintptr_t hwnd)");
    this.setParent = u.func(
      "uintptr_t __stdcall SetParent(uintptr_t hwnd, uintptr_t parent)",
    );
    this.getStyle = u.func(
      "intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)",
    );
    this.setStyle = u.func(
      "intptr_t __stdcall SetWindowLongPtrW(uintptr_t hwnd, int index, intptr_t value)",
    );
    this.position = u.func(
      "int __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t after, int x, int y, int w, int h, uint32_t flags)",
    );
    this.show = u.func("int __stdcall ShowWindow(uintptr_t hwnd, int command)");
    this.post = u.func(
      "int __stdcall PostMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t w, intptr_t l)",
    );
    this.dpi = u.func("uint32_t __stdcall GetDpiForWindow(uintptr_t hwnd)");
    this.dpiContext = u.func(
      "intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)",
    );
  }
  owned() {
    const out = [0];
    this.pid(this.hwnd, out);
    return (
      out[0] === this.processId &&
      (!this.host || Number(this.parent(this.hwnd)) === this.host)
    );
  }
  attach(hwnd, processId, window) {
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0)
      throw Error("引擎返回了无效窗口句柄");
    this.hwnd = hwnd;
    this.processId = processId;
    if (!this.owned()) throw Error("引擎窗口不属于本次启动的进程");
    const buf = window.getNativeWindowHandle();
    this.host = Number(buf.readBigUInt64LE());
    const own = [0];
    this.pid(this.host, own);
    if (own[0] !== process.pid) throw Error("目标窗口不属于工具箱");
    this.previousParent = Number(this.parent(hwnd));
    this.style = Number(this.getStyle(hwnd, -16));
    this.show(hwnd, 0);
    // Owned borderless viewport: avoids Chromium covering a foreign child HWND.
    const style = ((this.style & ~0x40cf0000) | 0x80000000) >>> 0;
    this.setStyle(hwnd, -16, style);
    this.setStyle(hwnd, -8, this.host);
    if (Number(this.parent(hwnd)) !== this.host) {
      this.setStyle(hwnd, -16, this.style);
      throw Error("Windows 拒绝附着引擎窗口");
    }
    this.exStyle = Number(this.getStyle(hwnd, -20));
    this.setStyle(hwnd, -20, ((this.exStyle & ~0x40000) | 0x80) >>> 0);
  }
  bounds(rect, window) {
    if (!this.hwnd || !this.owned()) return;
    if (!rect || !window.isVisible() || window.isMinimized()) {
      this.show(this.hwnd, 0);
      return;
    }
    const [w, h] = window.getContentSize();
    const zoom = window.webContents.getZoomFactor();
    if (
      !["x", "y", "width", "height"].every(
        (k) => Number.isFinite(rect[k]) && rect[k] >= 0 && rect[k] <= 20000,
      )
    )
      throw Error("预览区域尺寸无效");
    const x = Math.max(0, rect.x * zoom),
      y = Math.max(0, rect.y * zoom),
      width = Math.min(rect.width * zoom, w - x),
      height = Math.min(rect.height * zoom, h - y);
    if (width < 16 || height < 16) {
      this.show(this.hwnd, 0);
      return;
    }
    const screen = require("electron").screen;
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
    const content = window.getContentBounds();
    const origin = screen.dipToScreenPoint({
      x: Math.round(content.x + x),
      y: Math.round(content.y + y),
    });
    const previous = this.dpiContext(-4);
    try {
      if (
        !this.position(
          this.hwnd,
          0,
          origin.x,
          origin.y,
          Math.round(width * scale),
          Math.round(height * scale),
          0x4000 | 0x10 | 0x20 | 0x40,
        )
      )
        throw Error("无法调整引擎窗口大小");
      this.show(this.hwnd, 4);
    } finally {
      if (previous) this.dpiContext(previous);
    }
  }
  hide() {
    if (this.hwnd && this.owned()) this.show(this.hwnd, 0);
  }
  close() {
    if (this.hwnd && this.owned()) {
      this.show(this.hwnd, 0);
      this.post(this.hwnd, 0x10, 0, 0);
    }
  }
}
module.exports = { EditorWindow };
