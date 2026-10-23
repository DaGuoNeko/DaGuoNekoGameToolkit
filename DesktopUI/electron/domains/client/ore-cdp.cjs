const { ownedEndpoint } = require("../automation/mcp-endpoint.cjs");
const MAX_BYTES = 1024 * 1024;
class OreCdp {
  constructor(
    port,
    pid,
    check,
    {
      fetchImpl = fetch,
      Socket = WebSocket,
      owner = ownedEndpoint,
      timeoutMs = 8000,
    } = {},
  ) {
    Object.assign(this, {
      port,
      pid,
      check,
      fetchImpl,
      Socket,
      owner,
      timeoutMs,
    });
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
  }
  async owned() {
    this.check();
    await this.owner(
      { enabled: true, server_ip: "127.0.0.1", server_port: this.port },
      this.pid,
    );
    this.check();
  }
  async connect() {
    await this.owned();
    const r = await this.fetchImpl(`http://127.0.0.1:${this.port}/json/list`, {
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw Error("OreUI 页面查询失败");
    const reader = r.body.getReader();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BYTES) throw Error("OreUI 页面列表过大");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    const pages = JSON.parse(text);
    // This pinned engine returns JSON null while only native menus are open.
    if (pages === null)
      throw Object.assign(Error("原生菜单尚未打开 OreUI 页面"), {
        code: "ORE_MENU_NOT_PRESENT",
      });
    if (!Array.isArray(pages) || pages.length > 32)
      throw Error("OreUI 页面列表无效");
    const target = pages.filter(
      (p) =>
        p.url === "ui://./hbui/index.html" &&
        /^[0-9]{1,10}$/.test(String(p.id)),
    );
    if (target.length !== 1)
      throw Object.assign(Error("尚未找到唯一的游戏 OreUI 菜单"), {
        code:
          target.length === 0 ? "ORE_MENU_NOT_PRESENT" : "ORE_MENU_AMBIGUOUS",
      });
    await this.owned();
    if (this.closed) throw Error("OreUI 通道已关闭");
    this.socket = new this.Socket(
      `ws://127.0.0.1:${this.port}/devtools/page/${target[0].id}`,
    );
    this.socket.addEventListener("message", (e) => this.receive(e.data));
    this.socket.addEventListener("close", () =>
      this.fail(Error("OreUI 连接已断开")),
    );
    this.socket.addEventListener("error", () =>
      this.fail(Error("OreUI 连接错误")),
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(Error("OreUI 连接超时"));
      }, this.timeoutMs);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(Error("OreUI 连接失败"));
        },
        { once: true },
      );
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(Error("OreUI 连接已关闭"));
        },
        { once: true },
      );
    });
    this.check();
  }
  receive(data) {
    try {
      if (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES)
        throw Error("OreUI 回包过大或无效");
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          Error(
            "OreUI 拒绝请求：" +
              String(message.error.message || "未知错误").slice(0, 500),
          ),
        );
      else pending.resolve(message.result);
    } catch (e) {
      this.fail(e);
      this.close();
    }
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  async evaluate(expression) {
    if (typeof expression !== "string" || Buffer.byteLength(expression) > 64000)
      throw Error("OreUI 请求过大");
    await this.owned();
    if (this.closed || this.socket?.readyState !== 1)
      throw Error("OreUI 通道尚未连接");
    if (this.pending.size >= 4) throw Error("OreUI 请求过多");
    const id = ++this.seq;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("OreUI 操作超时，结果未知，不自动重放"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
    this.check();
    if (result?.exceptionDetails)
      throw Error(
        "OreUI 执行失败：" +
          String(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text,
          ).slice(0, 1000),
      );
    return result?.result?.value;
  }
  close() {
    this.closed = true;
    this.fail(Error("OreUI 通道已关闭"));
    this.socket?.close();
  }
}
module.exports = { OreCdp };
