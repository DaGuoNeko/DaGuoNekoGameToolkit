const net = require("node:net");
const { EventEmitter } = require("node:events");
// Independent implementation of the installed editor's framed JSON-RPC wire format.
class EditorRpc extends EventEmitter {
  constructor() {
    super();
    this.next = 1;
    this.pending = new Map();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }
  async listen(accept) {
    this.server = net.createServer(async (socket) => {
      socket.on("error", () => {});
      socket.pause();
      if (this.socket) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      try {
        if (!(await accept(socket))) throw Error("不是本次预览进程的连接");
      } catch (error) {
        socket.destroy();
        if (this.socket === socket) this.socket = null;
        this.emit("rejected", error.message);
        return;
      }
      socket.setNoDelay(true);
      socket.on("data", (data) => {
        try {
          this.receive(data);
        } catch (e) {
          this.emit("fault", e.message);
          socket.destroy();
        }
      });
      socket.on("close", () => {
        this.rejectAll(Error("编辑器引擎连接已断开"));
        this.emit("disconnected");
      });
      socket.resume();
      this.emit("connected");
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    return this.server.address().port;
  }
  receive(data) {
    if (this.buffer.length + data.length > 32 * 1024 * 1024)
      throw Error("引擎消息缓冲超限");
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE();
      if (length < 2 || length > 16 * 1024 * 1024)
        throw Error("引擎消息长度无效");
      if (this.buffer.length < length + 4) return;
      const message = JSON.parse(
        this.buffer.subarray(4, length + 4).toString("utf8"),
      );
      this.buffer = this.buffer.subarray(length + 4);
      if (!message || message.jsonrpc !== "2.0")
        throw Error("引擎消息格式无效");
      if (typeof message.method === "string") {
        if (message.method.length > 256) throw Error("引擎方法名无效");
        if (message.id !== undefined)
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "__HEARTBEAT__"
                ? Number(message.params?.[0] || 0) + 1
                : null,
          });
        this.emit("notification", message.method, message.params);
      } else {
        const task = this.pending.get(message.id);
        if (!task) continue;
        this.pending.delete(message.id);
        clearTimeout(task.timer);
        message.error
          ? task.reject(Error(message.error.message || "引擎请求失败"))
          : task.resolve(message.result);
      }
    }
  }
  send(value) {
    if (!this.socket || this.socket.destroyed) throw Error("引擎未连接");
    const body = Buffer.from(JSON.stringify(value)),
      head = Buffer.alloc(4);
    if (body.length > 16 * 1024 * 1024) throw Error("请求过大");
    head.writeInt32LE(body.length);
    this.socket.write(Buffer.concat([head, body]));
  }
  call(plugin, method, params = [], timeout = 20000) {
    if (this.pending.size >= 32)
      return Promise.reject(Error("引擎请求队列已满"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(method + " 请求超时；没有自动重试"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({
          jsonrpc: "2.0",
          id,
          method: "_" + plugin + "_" + method,
          params,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  rejectAll(error) {
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    this.pending.clear();
  }
  close() {
    this.rejectAll(Error("预览已停止"));
    this.socket?.destroy();
    this.server?.close();
    this.socket = null;
  }
}
module.exports = { EditorRpc };
