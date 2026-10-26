const Ajv = require("ajv");
const text = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength });
const target = {
  sessionId: text(),
  generation: { type: "integer", minimum: 0 },
};
const launch = { instanceId: text(), requestId: text(), playerName: text(64) };
const localMultiplayer = {
  scope: "local_host_and_clients",
  steps: [
    "toolbox_status",
    "list_clients",
    "list_worlds",
    "launch_world",
    "launch_joined_client",
    "list_clients",
  ],
  guidance:
    "本地多人测试默认使用存档房主 + 多开客户端。先复用明确匹配的运行房主，或 launch_world 启动目标 worldId 并等待 game_ready；再用 launch_joined_client 指定 hostSessionId 和不同玩家名。每个新增客户端使用独立 requestId，同一次请求重试复用原 ID。轮询 autoJoin.phase，只有 joined 才算入房成功。多个主机必须逐个核对 worldId/sessionId，禁止默认连接主游戏。",
  remoteRooms:
    "联机房间页面用于邀请异地朋友，通过 EasyTier/樱花建立远程网络。本地同机测试不创建分享房间、邀请码、隧道或虚拟网卡；只有用户明确要求远程联机时才使用此页。",
};
function tool(
  name,
  description,
  properties = {},
  required = [],
  readOnly = false,
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
  };
}
const tools = [
  tool(
    "toolbox_status",
    "工具箱运行状态与 instanceId，返回本地联机测试指引 localMultiplayer。本地测试默认使用房主 + 多开客户端，不使用远程联机房间页面。工具箱离线时也可调用。",
    {},
    [],
    true,
  ),
  tool("open_toolbox", "打开已安装的最新工具箱；不会启动游戏或关闭已有程序。"),
  tool(
    "list_clients",
    "列出本工具箱拥有的所有客户端及能力。后续操作必须指定 sessionId；generation 变化后先重新确认目标。",
    {},
    [],
    true,
  ),
  tool(
    "list_launch_profiles",
    "列出已保存的启动配置 ID 和名称。",
    {},
    [],
    true,
  ),
  tool("list_worlds", "列出存档及其绑定配置，只读，不修改存档。", {}, [], true),
  tool(
    "launch_client",
    "启动到主菜单，之后手动联机。本地自动多人测试优先使用 launch_joined_client；仅当需要停留菜单/手动加入时使用本工具。mode=blank 无模组；debug 仅调试模组；profile 使用 profileId 配置。调试能力需进入世界后就绪。先取 instanceId；同一次启动重试必须复用 requestId，不能因超时换新 ID。",
    {
      ...launch,
      mode: { enum: ["blank", "debug", "profile"] },
      profileId: text(),
    },
    ["instanceId", "requestId", "playerName", "mode"],
  ),
  tool(
    "launch_joined_client",
    "新开指定名字的客户端并自动加入 hostSessionId 指定的本机存档主房间，继承房主本次运行配置。返回后在后台加入，请用 list_clients 轮询 autoJoin；仅 joined 表示房主验证成功。waiting_assertion 表示断言弹窗待用户处理，关闭弹窗后在本次约120秒期限内继续；needs_attention 表示自动流程已结束但客户端保留，需手动处理，不要换 requestId 重开。仅具备 autoJoinAssertionPolicy=pause_preserve 的后端支持此行为，旧后端仍会停止断言客户端。其他 failed 会停止本次新客户端。通过官方 OreUI 数据与接口选房，不使用截图或 OCR；支持构建及隔离能力见 toolbox_status.capabilities.gameVersions，双方必须匹配房主启动时的同一 EXE 指纹。房主必须加载开发辅助模组；不会接管旧客户端。相同启动重试必须复用 instanceId/requestId。",
    { ...launch, hostSessionId: text() },
    ["instanceId", "requestId", "playerName", "hostSessionId"],
  ),
  tool(
    "launch_world",
    "用存档已绑定配置启动主机，本次运行开启调试模组与 MCP，不改配置模板。内置 MCDK 配合具备 isolatedHost 能力的构建支持多个不同存档同时运行；同一存档禁止重复启动。先检查 toolbox_status.capabilities.isolatedWorldHosts 与 gameVersions，再按返回的 sessionId/generation 分别控制；list_clients.storageMode 是本次实际隔离模式。sharedSources 提示共用源码；若需要独立修改源码，请使用不同目录或工作副本。重复启动请求复用 requestId。",
    { instanceId: text(), requestId: text(), worldId: text() },
    ["instanceId", "requestId", "worldId"],
  ),
  tool(
    "client_logs",
    "读取指定会话最近日志，不切换用户界面。afterId 可用于增量读取，环形缓存最多 2000 条。",
    {
      sessionId: text(),
      afterId: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["sessionId"],
    true,
  ),
  tool(
    "execute_client_code",
    "通过对应 Host Bridge 执行游戏 Python 2.7 代码。客户端代码只影响指定进程，服务端代码影响其连接的服务器。超时结果未知，禁止自动重放。",
    { ...target, code: text(262144), side: { enum: ["client", "server"] } },
    ["sessionId", "generation", "code", "side"],
  ),
  tool(
    "reload_client",
    "热更新脚本或重载指定客户端世界/资源。world/addons 需要 confirmed=true；返回接收不代表已重新进入世界。使用本次启动来源，已保存的模组路径/启用列表变化时会拒绝并说明当前与最新来源；请保存游戏后在工具箱按最新配置重启。不会重开 EXE，超时禁止重试。",
    {
      ...target,
      action: { enum: ["scripts", "world", "addons"] },
      confirmed: { type: "boolean" },
    },
    ["sessionId", "generation", "action"],
  ),
  tool(
    "close_client",
    "停止指定工具箱会话及其拥有的游戏进程；保存游戏后调用，必须 confirmed=true。不操作其他客户端。",
    { sessionId: text(), confirmed: { const: true } },
    ["sessionId", "confirmed"],
  ),
  tool(
    "remove_client",
    "从会话列表移除已结束客户端，保留历史日志和存档。运行中拒绝。",
    { sessionId: text() },
    ["sessionId"],
  ),
  tool(
    "list_client_mcdk_tools",
    "读取该客户端的 MCDK 原生工具及参数（截图、输入、UI、性能等取决于安装版本）。验证端口属于该会话，绝不回退主游戏。",
    target,
    ["sessionId", "generation"],
    true,
  ),
  tool(
    "call_client_mcdk_tool",
    "按该客户端实际工具 schema 调用 MCDK，保留图片结果。先 list_client_mcdk_tools；服务端操作仍作用于房主。超时结果未知，禁止自动重放。",
    {
      ...target,
      name: text(),
      arguments: { type: "object" },
      confirmed: { type: "boolean" },
    },
    ["sessionId", "generation", "name", "arguments"],
  ),
];
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(
  tools.map((t) => [t.name, ajv.compile(t.inputSchema)]),
);
function validate(name, args) {
  const check = validators.get(name);
  if (!check || !check(args))
    throw Error(
      "MCP 工具参数无效：" +
        name +
        " " +
        (check ? ajv.errorsText(check.errors) : "未知工具"),
    );
}
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
module.exports = { tools, validate, result, localMultiplayer };
