const net = require("node:net");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const Ajv = require("ajv");
const loopbacks = new Set(["localhost", "127.0.0.1", "::1"]);
function endpoint(config) {
  if (!config?.enabled)
    throw Error(
      "此客户端未开启 MCDK MCP，请新建调试客户端或使用 MCP 已开启的配置",
    );
  const host = config.server_ip || "localhost",
    port = config.server_port ?? 19133;
  if (
    !loopbacks.has(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("MCDK MCP 必须使用有效的本机回环地址和端口");
  return { host, port };
}
async function probe(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      const chosen = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(chosen)));
    });
  });
}
async function allocateMcp(config, used = []) {
  if (!config?.enabled) return config;
  const { host, port } = endpoint(config);
  if (!used.includes(port)) {
    try {
      await probe("127.0.0.1", port);
      await probe("::1", port);
      return { ...config, server_ip: host, server_port: port };
    } catch (e) {
      if (!["EADDRINUSE", "EACCES"].includes(e.code)) throw e;
    }
  }
  for (let i = 0; i < 16; i++) {
    const chosen = await probe("127.0.0.1", 0);
    if (!used.includes(chosen))
      return { ...config, server_ip: "127.0.0.1", server_port: chosen };
  }
  throw Error("无法分配客户端 MCP 端口");
}
function parseListeners(stdout) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const cols = line.trim().split(/\s+/),
      match = /^(.*):(\d+)$/.exec(cols[1] || "");
    if (cols[0] !== "TCP" || !match || !["LISTENING", "侦听"].includes(cols[3]))
      return [];
    return [
      {
        host: match[1].replace(/^\[|\]$/g, ""),
        port: Number(match[2]),
        pid: Number(cols[4]),
      },
    ];
  });
}
async function listeners() {
  const { stdout } = await execFile(
    path.join(process.env.SystemRoot, "System32/netstat.exe"),
    ["-ano"],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseListeners(stdout);
}
// Resolve by owning launcher PID, never by a default port alone.
async function ownedEndpoint(config, pid, discover = listeners) {
  const { host, port } = endpoint(config);
  const hosts = host === "localhost" ? ["::1", "127.0.0.1"] : [host];
  const rows = await discover();
  const found = hosts.find((h) =>
    rows.some((r) => r.port === port && r.pid === pid && r.host === h),
  );
  if (!found || !Number.isInteger(pid) || pid <= 0)
    throw Error("该客户端的 MCDK 端口尚未就绪或不属于此会话；未转发请求");
  return `http://${found.includes(":") ? "[" + found + "]" : found}:${port}/mcp`;
}
async function withMcdk(worker, check, action, discover = listeners) {
  check();
  const config = worker.sourceSnapshot.config.mcp_server_config;
  const url = await ownedEndpoint(config, worker.session.pid, discover);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      check();
      if (
        String(input) !== url ||
        (await ownedEndpoint(config, worker.session.pid, discover)) !== url
      )
        throw Error("MCDK 目标已变化");
      return fetch(input, {
        ...init,
        redirect: "error",
        signal: init?.signal || AbortSignal.timeout(60000),
      });
    },
  });
  const client = new Client({ name: "daguoneko-toolbox", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 15000 });
    const all = [],
      seen = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 15000,
      });
      all.push(...page.tools);
      cursor = page.nextCursor;
      if (all.length > 512 || (cursor && seen.has(cursor)))
        throw Error("MCDK 工具目录超出限制");
      seen.add(cursor);
    } while (cursor);
    check();
    if (!action) return { tools: all };
    const tool = all.find((t) => t.name === action.name);
    if (!tool) throw Error("该客户端没有此 MCDK 工具");
    const ajv = new Ajv({ strict: false });
    if (!ajv.validate(tool.inputSchema, action.arguments))
      throw Error("MCDK 参数无效：" + ajv.errorsText());
    const response = await client.callTool(
      { name: action.name, arguments: action.arguments },
      undefined,
      { timeout: 60000 },
    );
    check();
    return response;
  } finally {
    await client.close().catch(() => {});
  }
}
module.exports = { allocateMcp, ownedEndpoint, parseListeners, withMcdk };
