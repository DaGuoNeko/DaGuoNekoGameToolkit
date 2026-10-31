# AI 自动化接口

[使用指南](使用指南.md) · [架构说明](架构说明.md) · [开发指南](开发指南.md)

工具箱对外使用 MCP stdio；Node 批量脚本使用同一 MCP SDK。两者经过同一会话路由、参数校验和业务服务。内部回环 HTTP、Electron IPC 和 Host Bridge 不作为绕过校验的公共接口。设置页可复制连接配置。

## 工具目录

原有 15 个工具保持兼容，新增 18 个，共 33 个；以当前安装实例 `tools/list` 为准。更新源码后需要构建并重新启动对应工具箱实例，已有发行程序不会自动获得接口。

| 范围 | 新工具 | 约束 |
|---|---|---|
| 就绪 | `client_readiness`、`wait_client_ready` | 分别返回连接、世界、玩家、当前 UI、阻塞原因；渲染未验证时明确为 unknown |
| 断言 | `list_client_assertions`、`resolve_client_assertion` | 精确会话、代次、进程身份和断言 ID；只支持明确识别的 Ignore/忽略按钮 |
| 截图 | `capture_client_window` | 所属窗口客户区原始像素 PNG，包含尺寸、时间、窗口状态和图片摘要 |
| 配置 | `list_projects`、`read_project`、`create_project`、`update_project` | project 表示当前启动配置；修改白名单字段并保留 JSONC 与未知字段 |
| 全局设置 | `read_settings`、`update_settings` | revision 防止覆盖过期读数；当前 MCP 不允许关闭自身连接开关 |
| 游戏选项 | `read_game_options`、`update_game_options` | 修改下次启动覆盖模板；数值采用 options.txt 的字符串形式 |
| 存档 | `inspect_world_source`、`import_world`、`clone_world` | 检查来源、复制/原目录导入、复制已登记存档；沿用运行冲突、路径、ZIP 和备份保护 |
| 预检 | `validate_world_assets` | 启动前扫描 PNG 结构、空资源路径、JSON/JSONC 资源引用和缺失目标 |
| 固定拍摄 | `capture_scene` | 结构化参数、能力检查、区块等待、参数回读和截图前后核对；HUD 回读暂不支持 |

## 会话和结果语义

先 `toolbox_status` 获取 instanceId，再 `list_clients` 获取 sessionId/generation。创建配置、导入、克隆和固定拍摄需要独立 requestId；同一次调用重试必须复用相同 ID 和参数，不能因为超时换新 ID。工具箱重启后旧 instanceId 失效。其他写操作结果不明时先读取状态，不自动重放。

`game_ready` 是原有调试桥状态。`client_readiness.ready` 额外要求原生窗口观察成功、无断言、客户端返回有效玩家/位置/世界以及已确认的游戏 HUD 界面；未知 UI、加载界面或探针错误均不判为就绪。窗口最小化与渲染状态单独返回：可执行游戏逻辑不等于能够截图，更不等于所有地图资源或业务初始化已完成。

`validate_world_assets(worldId)` 可以在启动前独立执行；`launch_world` 也会自动执行相同预检。默认 `assetPreflight:"strict"` 遇到预检问题停止；使用者已经核验且明确要求尝试启动时，可传 `assetPreflight:"report", confirmed:true`，返回预检摘要后继续，保留存档锁、进程归属和路径保护。预检范围是存档内的包目录，不包含配置指向的外部模组；PNG 检查结构与 CRC，不进行完整像素解码。引用检查可能无法解析原版、跨包或动态别名。静态预检不能判断游戏警告是否致命；结果保留以便后续排查。

断言读取先运行独立 Windows 探针，避免模态断言期间向阻塞的游戏线程发 Python 请求。探针检查 PID、父 PID、EXE、进程创建时间和窗口归属。`client_readiness.interactionState="blocked_by_assertion"` 表示当前被警告弹窗阻塞；不会据弹窗文本直接断定致命。

外部先读取 `list_client_assertions` 或 `client_readiness`，再用其中 `canIgnore:true` 的最新 assertionId、generation、`action:"ignore"` 和 `confirmed:true` 调用 `resolve_client_assertion`。工具向精确弹窗发送其“忽略(I)”按钮对应的命令通知，不激活窗口、不向桌面发送 I、不发送关闭消息，一次只处理一个弹窗。disabled 的父弹窗需先处理其上的模态弹窗。

`toolbox_status.capabilities.automationControlVersion=2` 与 `assertionPolicy="explicit_single_ignore"` 标识此行为。源码构建后需要重新打开相应工具箱实例并重连 MCP；仍在运行的旧实例不会自动换成新的路由规则。

occurrenceCount 按会话、连接代次和进程身份统计；同一弹窗反复轮询、列表排序变化不增加次数。重复警告返回 needsAttention 提示，但使用者明确授权后仍可逐次尝试忽略。一次性 assertionId 在已发送或结果未知后不可重放；应读取 dispatched、resolved、剩余 assertions，并重新检查 readiness。新出现的同类警告需要新的观察与单次操作，工具不自动循环忽略、不永久屏蔽某类断言。忽略后无弹窗也不能直接认定资源修复或世界已就绪。

截图通过 Windows Graphics Capture 按已核验的游戏窗口句柄创建捕获项，读取 BGRA 原始像素后只裁掉边框；不通过视频缩放通道，也不使用桌面截图替代目标窗口。窗口被遮挡时仍可捕获，遮挡观察单独返回 yes/no/unknown。系统不支持捕获、窗口不存在、最小化、尺寸不符、进程/窗口在捕获期间变化及纯色帧均明确失败。需要 Windows 的 Graphics Capture 与 D3D11 支持；辅助组件由构建脚本使用系统 .NET/WinRT 元数据编译。

`frameTimestamp` 来自捕获帧的 SystemRelativeTime，`frameTimestampClock:"qpc_100ns"` 表示单调时钟的 100ns 单位，不能当作 UTC 时间；`capturedAt` 才是工具箱观察的 UTC 时间。捕获帧时间戳不证明游戏渲染在推进，因此仍返回 `freshness:"unknown"`。`sameAsPrevious` 仅比较图片字节：相同画面可能静止，也可能是旧帧；`requireChanged:true` 要求已有基准且本次图片发生变化，不能据此证明所有画面都实时渲染。

## 导入与副本

`inspect_world_source` 不创建登记和配置；ZIP 的完整 CRC 校验仍在实际导入阶段进行。`import_world` 的 source 使用绝对路径，支持文件夹、ZIP、MCWORLD；mode 默认 copy。省略 profileId 时自动创建干净配置，只在存档数据验证成功后创建。

copy 保留原目录并创建独立存档数据；linked 直接使用原目录，游戏进度会写回原存档。`clone_world` 复制停止的已登记存档。二者均不复制配置中指向外部目录的模组源码，独立运行环境也不等于源码副本。默认自动配置不额外继承外部模组，若需要复用请明确传 profileId。

设置和启动配置修改影响之后的启动，运行快照不变。界面接收数据变化通知，刷新列表并保留未保存草稿；旧草稿保存仍受 revision 保护。公开配置读取不返回完整 raw 或未知配置字段。

## 固定拍摄

`capture_scene` 只操作本工具创建的存档主机。settings 可包含 position（三维脚底坐标）、dimension、rotation（三维相机 Pitch/Yaw/Roll）、fov（30–110）、perspective（0/1/2）、timeOfDay（0–23999）、weather（clear/rain/thunder）和 chunkRadius（0–4，默认 1）。跨维度必须同时给出位置。当前尚无经验证的 HUD 状态回读，传入 hudHidden 会在任何游戏修改前返回 `HUD_READBACK_UNSUPPORTED`；不能以“没有变化”或请求值代替实际状态。原生能力不支持时明确拒绝，不模拟键鼠。

先读取实际参数和所需 API，再单次设置，等待玩家位置、维度、邻近区块和相机等回读匹配，截图后再次确认。时间和天气会关闭对应循环，设置会保留在测试游戏中；不是自动回滚事务。失败返回执行阶段、已确认操作、前值、最后回读值和 effectsMayRemain。不要重放整个拍摄流程来解决截图问题，先读取状态或单独截图。

当前不改写自定义维度的独立天气规则，下界/末地天气请求拒绝。业务模组持续控制相机、位置或 HUD 时可能导致回读不一致，接口会超时或失败，不能用 requested 值冒充实际参数。截图新鲜度的限制同样适用于固定拍摄。

## Node CLI 与批量测试

在 `DesktopUI/` 执行：

```powershell
node scripts/toolbox-call.cjs toolbox_status
node scripts/toolbox-call.cjs --list
node scripts/toolbox-call.cjs read_project --args-file request.json
node scripts/toolbox-call.cjs --jsonl --data-dir '<测试工具箱数据目录>'
```

JSONL 模式从 stdin 每行读取 `{ "name": "工具名", "arguments": {} }`，复用一条 MCP 连接并串行执行。退出码非零表示调用失败；不自动重试。配置和游戏操作仍由工具箱进程负责，脚本不能直接重写运行中的 settings.json 或存档数据库。内部鉴权凭据只由桥接器使用，不需要复制到脚本或命令行。

## 验证入口

服务与失败路径：`node --test tests/automation.test.cjs tests/automation-control.test.cjs`。真实 Windows 隐藏窗口夹具验证断言读取、忽略和错误父进程拒绝。`node tests/automation-ui.cjs` 覆盖真实构建 UI/preload/IPC/stdio 与配置、导入、克隆、设置互通。

显式设置 `DGN_LIVE_GAME_EXE` 后运行 `node tests/automation-live.cjs`：只新建测试配置、原始样本和存档副本，经过 MCP 导入、克隆、启动、就绪、截图和拍摄回读，再关闭自身会话。证据在 `DesktopUI/test-results/`。环境覆盖不是完整隔离；脚本要求已登记的独立主机游戏构建。此验证不代表所有引擎构建、GPU、多显示器或业务模组都已验收。
