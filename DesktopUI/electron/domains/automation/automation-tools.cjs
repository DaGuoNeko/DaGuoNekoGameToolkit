const Ajv = require("ajv");
const { settingsSchema, projectSchema } = require("./automation-config.cjs");
const text = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength });
const dimensionId = { type: "integer", minimum: 0, maximum: 2147483647 };
const target = {
  sessionId: text(),
  generation: { type: "integer", minimum: 0 },
};
const launch = { instanceId: text(), requestId: text(), playerName: text(64) };
const operation = {
  instanceId: text(),
  requestId: text(),
  confirmed: { const: true },
};
const terrainTask = { instanceId: text(), requestId: text(), taskId: text(), externalDataRoot: text(4096), confirmed: { const: true } };
const terrainRegion = {
  ...terrainTask,
  sourceDimension: dimensionId,
  x1: { type: "integer", minimum: -30000000, maximum: 30000000 },
  y1: { type: "integer", minimum: -4096, maximum: 4096 },
  z1: { type: "integer", minimum: -30000000, maximum: 30000000 },
  x2: { type: "integer", minimum: -30000000, maximum: 30000000 },
  y2: { type: "integer", minimum: -4096, maximum: 4096 },
  z2: { type: "integer", minimum: -30000000, maximum: 30000000 },
};
const terrainPlacement = {
  ...terrainTask,
  targetDimension: dimensionId,
  targetX: { type: "integer", minimum: -30000000, maximum: 30000000 },
  targetY: { type: "integer", minimum: -4096, maximum: 4096 },
  targetZ: { type: "integer", minimum: -30000000, maximum: 30000000 },
  offset: { type: "array", minItems: 3, maxItems: 3, items: { type: "integer", minimum: -30000000, maximum: 30000000 } },
  policy: { enum: ["overwrite", "keep"] },
  includeAir: { type: "boolean" },
};
const vector = {type:"array",minItems:3,maxItems:3,items:{type:"number",minimum:-30000000,maximum:30000000}};
const scene = {type:"object",additionalProperties:false,properties:{
  position:vector,dimension:dimensionId,
  rotation:{...vector,items:{type:"number",minimum:-360,maximum:360}},
  fov:{type:"number",minimum:30,maximum:110},perspective:{enum:[0,1,2]},
  timeOfDay:{type:"integer",minimum:0,maximum:23999},weather:{enum:["clear","rain","thunder"]},
  hudHidden:{type:"boolean"},chunkRadius:{type:"integer",minimum:0,maximum:4},
},dependencies:{dimension:["position"]}};
const localMultiplayer = {
  scope: "local_host_and_clients",
  steps: [
    "toolbox_status",
    "list_clients",
    "list_worlds",
    "launch_world",
    "wait_client_ready",
    "launch_joined_client",
    "list_clients",
  ],
  guidance:
    "本地多人测试默认使用存档房主 + 多开客户端。先复用明确匹配的运行房主，或 launch_world 启动目标 worldId，再用 wait_client_ready 核对世界与玩家；game_ready 只表示调试状态。随后 launch_joined_client 指定 hostSessionId 和不同玩家名。每个新增客户端使用独立 requestId，同一次请求重试复用原 ID。轮询 autoJoin.phase，只有 joined 才算入房成功。多个主机必须逐个核对 worldId/sessionId，禁止默认连接主游戏。",
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
  tool("scan_world_data", "离线只读扫描已登记存档的已保存对象与业务数据；不启动游戏，不写数据库。最长 120 秒，结果含覆盖和失败信息。使用 requestId 查询或取消；返回后用 read_world_data 分页查看。", { worldId: text(), requestId: text(80), scope: { enum: ["all", "gameplay", "world", "entities"] } }, ["worldId", "requestId"], true),
  tool("read_world_data", "分页查询已有扫描快照。默认只返回对象摘要；关系未找到不代表不存在。", { requestId: text(80), view: { enum: ["objects", "relations"] }, kind: text(32), query: { type: "string", maxLength: 256 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 }, includeData: { type: "boolean" } }, ["requestId"], true),
  tool("world_data_scan_state", "查询或取消指定只读扫描任务，取消不影响其他扫描或游戏会话。", { requestId: text(80), cancel: { type: "boolean" } }, ["requestId"], true),
  tool("compare_world_data", "按稳定身份比较两份已有只读扫描快照；partial 表示扫描不完整，不能断言对象已删除。", { left: text(80), right: text(80) }, ["left", "right"], true),
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
    { instanceId: text(), requestId: text(), worldId: text(),
      assetPreflight: {enum:["strict","report"],description:"默认 strict 阻止静态资源问题；report 仅记录预检结果后尝试启动，需要 confirmed=true，不代表资源已修复。"},
      confirmed: {type:"boolean"},
    },
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
  tool(
    "client_readiness",
    "读取指定客户端的分层就绪状态。不会点击、恢复或切换窗口；generation 可用于拒绝过期会话。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
    },
    ["sessionId"],
    true,
  ),
  tool(
    "wait_client_ready",
    "在有限期限内等待客户端进入可执行世界状态，返回最后一次完整观察；不会重启、重载或重放输入。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
      timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
      pollMs: { type: "integer", minimum: 100, maximum: 5000 },
    },
    ["sessionId"],
    true,
  ),
  tool(
    "list_client_assertions",
    "读取指定客户端当前所属的引擎断言弹窗。只检查进程、窗口和已有自动入房状态，不抢焦点。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
    },
    ["sessionId", "generation"],
    true,
  ),
  tool(
    "resolve_client_assertion",
    "按 list_client_assertions/client_readiness 最新返回的断言 ID，向所属弹窗发送一次忽略按钮通知（等同忽略助记键，不抢焦点）。用户明确授权 confirmed=true 后，同类再次出现也可逐次尝试；次数仅提示，不禁止继续。一次请求只处理一个弹窗，超时或结果未知先重新读取，已发送的同一次操作不重放；忽略不代表资源修复或世界就绪。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
      assertionId: text(256),
      action: { const: "ignore" },
      confirmed: { const: true },
    },
    ["sessionId", "generation", "assertionId", "action", "confirmed"],
  ),
  tool(
    "capture_client_window",
    "通过 Windows Graphics Capture 按所属窗口句柄捕获原始客户区 PNG，支持被遮挡的窗口，不切换焦点。返回会话、尺寸、捕获时间、QPC 帧时间戳、窗口状态和帧摘要。系统不支持、最小化、无窗口、尺寸不符或空白帧明确失败。freshness=unknown 表示未验证游戏渲染推进；requireChanged 仅要求相对基准图发生变化。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
      requireChanged: { type: "boolean" },
    },
    ["sessionId", "generation"],
    true,
  ),
  tool("list_projects", "列出启动配置及其项目目录。", {}, [], true),
  tool(
    "read_project",
    "读取指定启动配置的当前内容和 revision。",
    { projectId: text() },
    ["projectId"],
    true,
  ),
  tool(
    "update_project",
    "按 revision 局部更新启动配置白名单字段，保留 JSONC 与未知字段；不会改写运行快照。",
    {
      projectId: text(),
      revision: text(128),
      patch: projectSchema,
    },
    ["projectId", "revision", "patch"],
  ),
  tool("read_settings", "读取工具箱设置。", {}, [], true),
  tool(
    "update_settings",
    "按 read_settings 的 revision 更新公开设置白名单，不允许通过当前连接关闭 MCP。",
    { patch: settingsSchema, revision:text(128) },
    ["patch", "revision"],
  ),
  tool(
    "import_world",
    "从绝对路径导入存档。支持文件夹、ZIP、MCWORLD、linked 原目录和 copy 独立副本；必须确认，重复请求复用 instanceId/requestId。",
    {
      ...operation,
      profileId: text(),
      name: text(80),
      source: text(4096),
      mode: { enum: ["copy", "linked"] },
    },
    ["instanceId", "requestId", "name", "source", "confirmed"],
  ),
  tool("read_game_options", "读取游戏设置覆盖模板和当前 options.txt 摘要。", {}, [], true),
  tool(
    "update_game_options",
    "按 revision 更新游戏设置覆盖模板；运行中的游戏不会被直接改写。",
    {
      revision: { type: ["string", "null"] },
      overrides: { type: "object" },
    },
    ["revision", "overrides"],
  ),
  tool(
    "capture_scene",
    "固定指定存档主机的拍摄参数：位置、维度、相机角度、FOV、视角、时间和天气。先检测 API，再设置、等区块加载及回读匹配，截图前后复核。当前 HUD 无可靠回读，传 hudHidden 会在修改前明确拒绝。时间/天气会暂停对应周期，参数保留；失败可能部分生效，不自动恢复或重放。",
    {
      sessionId: text(),
      generation: { type: "integer", minimum: 0 },
      ...operation,
      settings: scene,
      timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
      requireChanged: { type: "boolean" },
    },
    ["sessionId", "generation", "instanceId", "requestId", "confirmed", "settings"],
  ),
  tool("create_project", "新建或复制启动配置；模组目录再用 update_project 设置。", {...operation,name:text(80),copyId:text()}, ["instanceId","requestId","confirmed","name"]),
  tool("inspect_world_source", "只读检查导入来源、包和元数据，不登记存档或创建配置。", {source:text(4096)}, ["source"], true),
  tool("validate_world_assets", "启动前扫描指定存档的 PNG 结构、JSON/JSONC 空资源路径和可解析资源引用；不会启动游戏或修改文件。", {worldId:text()}, ["worldId"], true),
  tool("inspect_world_packs", "只读浏览存档内置模组、清单启用状态及 UUID/版本/依赖静态诊断，不代表游戏实际加载成功。编辑和重绑在工具箱存档模组窗口确认。", {worldId:text()}, ["worldId"], true),
  tool("clone_world", "复制已登记且停止的存档为独立数据副本，自动创建干净配置；外部模组源码不会被复制。", {...operation,worldId:text(),name:text(80),profileId:text()}, ["instanceId","requestId","confirmed","worldId","name"]),
  tool("probe_dimension_runtime", "读取游戏当前或指定维度的实际运行边界。GetChunkMinPos/GetChunkMaxPos 绑定玩家所在维度，并返回候选 Y 的方块读取；指定 dimension 时会尝试传送并在结束时恢复原维度和位置。", {
    ...target, instanceId: text(), requestId: text(), confirmed: { const: true }, dimension: dimensionId,
    candidateY: { type: "array", maxItems: 32, items: { type: "integer", minimum: -4096, maximum: 4096 } },
  }, ["sessionId", "generation", "instanceId", "requestId", "confirmed"], true),
  tool("probe_build_height", "仅在 isolated 会话中测试候选 Y 是否可读写：保存原方块，写入测试方块并回读，最后恢复原状态。默认拒绝共享存档，返回 before/write/readback/restored。", {
    ...target, instanceId: text(), requestId: text(), confirmed: { const: true }, dimension: dimensionId,
    candidateY: { type: "array", minItems: 1, maxItems: 16, items: { type: "integer", minimum: -4096, maximum: 4096 } },
  }, ["sessionId", "generation", "instanceId", "requestId", "confirmed", "dimension", "candidateY"], false),
  tool("terrain_prepare", "建立架构导入任务并准备 Java/基岩来源副本；可用 externalDataRoot 将任务快照、运行目录和日志放到用户指定的独立临时目录。不会修改原来源。", {
    instanceId: text(), requestId: text(), confirmed: { const: true }, kind: { enum: ["java", "bedrock"] }, name: text(60), source: text(4096), targetWorldId: text(), chunkerJar: text(4096), externalDataRoot: text(4096),
  }, ["instanceId", "requestId", "confirmed", "kind", "name", "source", "targetWorldId"]),
  tool("terrain_capture_source", "在来源会话的实际 sourceDimension 读取指定区域，持久化快照和写入前数据，供后续预览和导入使用。", terrainRegion, ["instanceId", "requestId", "taskId", "confirmed", "sourceDimension", "x1", "y1", "z1", "x2", "y2", "z2"]),
  tool("terrain_preview", "在目标会话的实际 targetDimension 生成导入预览，支持目标坐标或 offset、覆盖/保留和是否导入空气；未确认前不写入目标。", terrainPlacement, ["instanceId", "requestId", "taskId", "confirmed", "targetDimension", "policy", "includeAir"]),
  tool("terrain_apply", "应用当前地形预览。写入前检查目标会话、维度和预览身份，结果不确定时保留批次记录且不自动重放。", {...terrainTask, previewId: text()}, ["instanceId", "requestId", "taskId", "confirmed", "previewId"]),
  tool("terrain_rollback", "撤销当前地形批次，按写入前快照逆序恢复；需要目标仍在导入时维度并明确确认。", terrainTask, ["instanceId", "requestId", "taskId", "confirmed"]),
  tool("terrain_status", "读取架构导入任务状态、阶段、进度、预览计数、备份位置和 externalDataRoot；不会启动游戏或修改存档。", { instanceId: text(), taskId: text(), externalDataRoot: text(4096) }, ["instanceId", "taskId"], true),
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
