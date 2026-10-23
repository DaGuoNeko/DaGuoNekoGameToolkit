const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const {
  tools,
  validate,
  result,
  localMultiplayer,
} = require("./automation-tools.cjs");
const rootArg = process.argv.indexOf("--data-dir");
const root =
  rootArg >= 0
    ? process.argv[rootArg + 1]
    : process.env.DGN_GAME_DATA_DIR ||
      path.join(process.env.LOCALAPPDATA, "DaGuoNeko_GameToolkit");
async function connection() {
  const raw = await fs.readFile(path.join(root, "mcp/connection.json"), "utf8");
  if (raw.length > 4096) throw Error("工具箱连接文件无效");
  const c = JSON.parse(raw);
  if (
    c.version !== 1 ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(c.token) ||
    typeof c.instanceId !== "string"
  )
    throw Error("工具箱连接文件无效");
  return c;
}
async function forward(name, args) {
  const c = await connection();
  if (name === "launch_joined_client" && !(c.apiVersion >= 3))
    throw Error(
      "当前运行的旧工具箱尚未接入原生 OreUI 联机，请保存游戏后切换到新版工具箱",
    );
  const response = await fetch(`http://127.0.0.1:${c.port}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + c.token,
    },
    body: JSON.stringify({ name, arguments: args, instanceId: c.instanceId }),
    redirect: "error",
    signal: AbortSignal.timeout(110000),
  });
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw Error("工具箱结果过大");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) throw Error(body.error || `工具箱 HTTP ${response.status}`);
  return body;
}
let opening;
async function openToolbox() {
  try {
    return await forward("toolbox_status", {});
  } catch {}
  if (!opening)
    opening = (async () => {
      const config = JSON.parse(
        await fs.readFile(path.join(root, "mcp/app.json"), "utf8"),
      );
      if (
        !path.isAbsolute(config.executable) ||
        !Array.isArray(config.args) ||
        config.args.some((x) => typeof x !== "string")
      )
        throw Error("请先手动打开新版工具箱一次，登记启动路径");
      await fs.access(config.executable);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      if (
        path.resolve(root).toLowerCase() !==
        path
          .resolve(process.env.LOCALAPPDATA, "DaGuoNeko_GameToolkit")
          .toLowerCase()
      )
        env.DGN_GAME_DATA_DIR = root;
      else delete env.DGN_GAME_DATA_DIR;
      const child = spawn(config.executable, config.args, {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        shell: false,
        env,
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          return await forward("toolbox_status", {});
        } catch {}
      }
      return result({
        online: false,
        message:
          "已请求打开工具箱；请检查窗口。若旧版本仍在运行或 AI MCP 已关闭，请在工具箱设置中开启后重试状态查询；不要重复启动游戏。",
      });
    })().finally(() => {
      opening = null;
    });
  return opening;
}
const server = new Server(
  { name: "daguoneko-toolbox", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "大果喵工具箱负责多客户端生命周期与定向路由，原 mcdk_game 保留。先 toolbox_status/list_clients 确认 instanceId、sessionId 与 generation。" +
      localMultiplayer.guidance +
      localMultiplayer.remoteRooms +
      "launch_client 保留主菜单，自动入房优先 launch_joined_client。代码/重载/输入超时结果未知，禁止自动重放；多客户端键鼠共享桌面焦点，输入操作串行。关闭前保存游戏。",
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    validate(name, args);
    if (name === "open_toolbox") return await openToolbox();
    if (name === "toolbox_status") {
      try {
        return await forward(name, args);
      } catch (error) {
        return result({
          online: false,
          message:
            "工具箱未连接，请先 open_toolbox，或在新版工具箱设置中开启 AI MCP。",
          detail: error.code || error.message,
        });
      }
    }
    return await forward(name, args);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            error.message +
            "；连接失败或超时不代表操作未执行。启动重试请复用 instanceId/requestId；其他写操作先检查状态，禁止自动重放。",
        },
      ],
    };
  }
});
server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
