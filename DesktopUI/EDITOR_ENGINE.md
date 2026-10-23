# 官方编辑器引擎预览

本功能复用本机 MCStudio 安装里的 `MCX64Editor/Game/Minecraft.Windows.Editor.exe`。它与普通 Minecraft.Windows.exe 不同；游戏引擎和资源文件不随工具箱复制或分发。首次启动优先发现正在运行的 MC_Editor 安装目录及常见安装位置，也可点击“选择编辑器引擎”。路径独立保存在工具箱数据目录的 `ui-editor-engine.json`。

## 使用

1. 在 UI 编辑器打开一个 JSON 文件；新建文件需先另存。
2. 点击“启动内嵌游戏”。工具箱创建自己的引擎进程及临时预览世界，将 UI 和同目录依赖、资源包贴图/字体/全局变量复制到预览世界。
3. 控件树可显示引擎展开后的继承节点；“引擎解析属性”显示最近一次引擎回包。继承生成的节点只读，不把运行时展开结构写回文件。
4. 修改草稿后点击“更新游戏预览”。保存源文件仍使用“保存”；这两个操作分开。可切换到本地画布编辑组件原定义。
5. 停止后只关闭本次预览进程，将其临时世界归档到数据目录 `ui-editor-preview/<UUID>/world`，保留日志和副本供诊断。停止不会执行按进程名结束所有编辑器的操作。

当前不加载业务行为包。因此依赖模组 Python 代码的动态绑定/数据源不等同于完整业务游戏运行；既有动画/继承/布局由所选编辑器引擎解释，尚未逐类验证。可视化动画时间轴、完整预制组件编辑、全量属性面板仍未完成。

## 实现与范围

- `editor-rpc.cjs` 独立实现长度前缀 JSON-RPC，loopback 随机端口；接入时通过本机 TCP 连接的 OwningProcess 核对新建引擎 PID。单包上限 16 MiB，缓冲上限 32 MiB，待回复请求上限 32；超时不自动重放。
- `editor-engine.cjs` 管理启动、UI 副本、加载确认、停止和世界归档。进入预览就绪状态依据 UI 解析成功回包，不把 RPC 请求被接受或启动器退出码当成全部游戏功能正常的证明。
- `editor-window.cjs` 使用已有 Koffi 调用 Windows 窗口 API，先校验游戏窗口 PID 和工具箱窗口 PID。当前交付的是带 owner 的无边框附着窗口，覆盖中央预览区域；随移动、缩放、最小化、切页和弹窗显示调整。不是截图轮询，也不是同进程游戏引擎。
- 本机直接 SetParent 子窗口方案被 Chromium 内容覆盖，未交付该失败方案。附着模式已经通过真实画面验证。实现参考 Windows 的 [SetWindowPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos) 及 [窗口 owner](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#owned-windows) 规则；跨进程 DPI 与窗口层级需单独处理，参见 [SetParent 注意事项](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)。
- 编辑器引擎会使用真实 Roaming 下的 `MinecraftPE_Netease_Editor/minecraftWorlds`，APPDATA 环境覆盖不能视作隔离保证。只接受本次 NewMap 返回的单层目录标识，核对真实路径、levelname.txt 的随机专属名称后，才能登记和归档；不移动其他世界，不改写共享的全局 add-on 索引。
- UI 原文仍由既有 JSONC 文件服务保存。游戏进程只收到副本路径。复制资源拒绝链接及特殊文件，最多 15000 项、256 MiB；属性回包缓存限制总量，完整引擎树受节点数/深度限制。
- 官方 Python 外壳反编译结果保留在 `.miao/official-ui-research/engine`，不打包进产品。游戏 C++ 引擎的完整源码没有获得，不能称为完整源码重建。

## 未交付的实验路径

安装包中的 UI 接口声明与实际运行有差异：GetSolvedDef、TakePictureForUI 等探针出现 Method not found；RefreshProperty 请求接受后，副本回读未确认变化，三参数变体返回 Invalid params。因此没有开放即时属性写入 API，没有把本地草稿反馈当成游戏修改成功。当前使用明确的“更新游戏预览”流程。

`InformInGame` 通知未在本次适配中确认，曾试验等待该通知并超时；这不能替代实际画面/控件回读验证，也不能用 UI 解析成功推断业务脚本、联机或完整编辑器功能均已正常。

## 验证记录

- 普通字段、JSONC 保真、冲突保存、C++ 布局及原工具箱服务回归仍保留；新增 RPC 分帧/超限/超时/外来连接拒绝，以及预览副本、世界归属与继承节点只读测试。
- 实际引擎已显示修改后的 `REAL PREVIEW UPDATED`，并从引擎回读同样的文字；Windows owner、PID、150% DPI 下预览区域位置已检查。关键可视证据 `.miao/editor-integration-1791524238357/toolbox.png`，该图不是静态 Canvas。
- 大果喵前置 `DAGUOMIAO_API_MOD_screen.json` 实际加载，引擎返回 `main@common.base_screen` 及 106 个节点；源码 SHA-256 保持一致。证据 `.miao/editor-project-1791524482320/evidence.json`。最初前端未匹配带 @ 的根键，已补充该映射。
- 试验进程均按自身记录停止；第一个独立探针产生的世界也已核对名称并归档。没有通过断言弹窗忽略/重试来完成测试。

未声称已经完成与官方全部功能相同的编辑器，也没有同项目完整 FPS/交互延迟的官方前后对比。当前交付仍是开发版。
