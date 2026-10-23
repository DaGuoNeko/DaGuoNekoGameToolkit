const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite } = require("./services.cjs");
class AutomationBridge {
  constructor(root, router) {
    this.root = root;
    this.router = router;
    this.file = path.join(root, "mcp/connection.json");
    this.pending = new Set();
    this.queue = Promise.resolve();
  }
  status() {
    return {
      enabled: !!this.server?.listening,
      instanceId: this.router.instanceId,
      port: this.port || null,
      serverFile: path.join(this.root, "mcp/server.cjs"),
      dataDirectory: this.root,
      clients: this.router.clients(),
    };
  }
  setEnabled(enabled) {
    const operation = this.queue.then(() =>
      enabled ? this.start() : this.stop(),
    );
    this.queue = operation.catch(() => {});
    return operation;
  }
  async start() {
    if (this.server?.listening) return this.status();
    this.token = crypto.randomBytes(32).toString("hex");
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      const fail = (status, error) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error }));
        req.resume();
      };
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`)
        return fail(403, "Forbidden");
      const bearer = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from("Bearer " + this.token);
      if (
        bearer.length !== expected.length ||
        !crypto.timingSafeEqual(bearer, expected)
      )
        return fail(401, "Unauthorized");
      if (
        req.method !== "POST" ||
        req.url !== "/call" ||
        req.headers["content-type"] !== "application/json"
      )
        return fail(404, "Not found");
      if (this.pending.size >= 16)
        return fail(429, "请求过多，请等待已有操作结束");
      const operation = (async () => {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            fail(413, "Request too large");
            return;
          }
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (data.instanceId !== this.router.instanceId)
          throw Error("工具箱连接已变化，请刷新状态");
        const value = await this.router.call(data.name, data.arguments || {});
        const body = JSON.stringify(value);
        if (Buffer.byteLength(body) > 24 * 1024 * 1024)
          throw Error("结果超过 24 MiB，请缩小请求范围");
        res.end(body);
      })().catch((error) => {
        if (!res.writableEnded && !res.destroyed) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      this.pending.add(operation);
      operation.finally(() => this.pending.delete(operation));
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;
    server.maxConnections = 32;
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.port = server.address().port;
    try {
      await atomicWrite(
        this.file,
        JSON.stringify({
          version: 1,
          apiVersion: 3,
          instanceId: this.router.instanceId,
          port: this.port,
          token: this.token,
          pid: process.pid,
        }),
      );
    } catch (error) {
      await this.stop();
      throw error;
    }
    return this.status();
  }
  async stop() {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.allSettled([...this.pending]);
      server.closeAllConnections();
      await closed;
    }
    try {
      const current = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (current.instanceId === this.router.instanceId)
        await fs.unlink(this.file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.status();
  }
}
async function installAutomation(root, bundle, executable, args = []) {
  const target = path.join(root, "mcp/server.cjs");
  await atomicWrite(target, await fs.readFile(bundle, "utf8"));
  await atomicWrite(
    path.join(root, "mcp/app.json"),
    JSON.stringify({ executable, args }),
  );
  return target;
}
module.exports = { AutomationBridge, installAutomation };
