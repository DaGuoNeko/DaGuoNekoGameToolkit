const { EditorWindow } = require("./editor-window.cjs");
let callbackType;
// Reuse the DPI-aware native viewport; only a newly spawned profiler is adopted.
class TracyWindow extends EditorWindow {
  constructor(runtime) {
    super(runtime);
    this.showAsync = this.library.func(
      "int __stdcall ShowWindowAsync(uintptr_t hwnd, int command)",
    );
    this.enumWindows = this.library.func(
      "int __stdcall EnumWindows(void *callback, intptr_t param)",
    );
    this.title = this.library.func(
      "int __stdcall GetWindowTextW(uintptr_t hwnd, void *text, int count)",
    );
    this.visible = this.library.func(
      "int __stdcall IsWindowVisible(uintptr_t hwnd)",
    );
    this.callbackType = callbackType ||= this.koffi.proto(
      "int __stdcall TracyEnumWindow(uintptr_t hwnd, intptr_t param)",
    );
  }
  attach(hwnd, processId, window) {
    super.attach(hwnd, processId, window);
    this.placement = null;
    this.shown = false;
    this.frameDirty = true;
  }
  // Dragging must never wait for Tracy's render thread. In particular, a
  // synchronous ShowWindow after SWP_ASYNCWINDOWPOS defeats its benefit.
  bounds(rect, window) {
    if (!this.hwnd || !this.host || !window || !this.owned()) return;
    if (!rect || !window.isVisible() || window.isMinimized())
      return this.hide();
    if (
      !["x", "y", "width", "height"].every(
        (k) => Number.isFinite(rect[k]) && rect[k] >= 0 && rect[k] <= 20000,
      )
    )
      throw Error("Tracy 区域尺寸无效");
    const [w, h] = window.getContentSize(),
      zoom = window.webContents.getZoomFactor();
    const x = rect.x * zoom,
      y = rect.y * zoom,
      width = Math.min(rect.width * zoom, w - x),
      height = Math.min(rect.height * zoom, h - y);
    if (width < 16 || height < 16) return this.hide();
    const screen = this.screen || require("electron").screen;
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor,
      content = window.getContentBounds();
    const origin = screen.dipToScreenPoint({
      x: Math.round(content.x + x),
      y: Math.round(content.y + y),
    });
    const next = {
        x: origin.x,
        y: origin.y,
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      },
      old = this.placement;
    const samePosition = old && old.x === next.x && old.y === next.y;
    const sameSize =
      old && old.width === next.width && old.height === next.height;
    if (samePosition && sameSize && this.shown && !this.frameDirty) return;
    // ASYNCWINDOWPOS | NOACTIVATE | NOZORDER | NOOWNERZORDER.
    let flags = 0x4000 | 0x10 | 0x4 | 0x200;
    if (sameSize) flags |= 0x1; // Pure movement must not resize the OpenGL surface.
    if (samePosition) flags |= 0x2;
    if (!this.shown) flags |= 0x40;
    if (this.frameDirty) flags |= 0x20; // Once after style/owner changes only.
    const previous = this.dpiContext(-4);
    try {
      if (
        !this.position(
          this.hwnd,
          0,
          next.x,
          next.y,
          next.width,
          next.height,
          flags,
        )
      )
        throw Error("无法同步 Tracy 窗口位置");
      this.placement = next;
      this.shown = true;
      this.frameDirty = false;
    } finally {
      if (previous) this.dpiContext(previous);
    }
  }
  hide() {
    if (!this.hwnd || !this.owned() || !this.shown) return;
    if (!this.showAsync(this.hwnd, 0)) throw Error("无法隐藏 Tracy 窗口");
    this.shown = false;
  }
  find(pid) {
    let found = 0;
    const callback = this.koffi.register((hwnd) => {
      const owner = [0],
        text = Buffer.alloc(1024);
      this.pid(hwnd, owner);
      if (owner[0] === pid) {
        this.title(hwnd, text, 512);
        if (text.toString("utf16le").includes("Tracy Profiler")) {
          found = Number(hwnd);
          return 0;
        }
      }
      return 1;
    }, this.koffi.pointer(this.callbackType));
    try {
      this.enumWindows(callback, 0);
    } finally {
      this.koffi.unregister(callback);
    }
    return found;
  }
  detach() {
    if (!this.hwnd || !this.owned()) return;
    this.setStyle(this.hwnd, -8, this.previousParent || 0);
    this.setStyle(this.hwnd, -16, this.style);
    this.setStyle(this.hwnd, -20, this.exStyle);
    this.host = null;
    this.position(this.hwnd, 0, 0, 0, 0, 0, 0x4 | 0x2 | 0x1 | 0x20 | 0x40);
    this.show(this.hwnd, 9);
    this.placement = null;
    this.shown = true;
  }
  requestClose() {
    if (this.hwnd && this.owned()) this.post(this.hwnd, 0x10, 0, 0);
  }
}
module.exports = { TracyWindow };
