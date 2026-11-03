# 项目开发规则

本文件随 Git 同步，供各设备的开发助手共用。只维护长期规则和文档入口，不追加任务记录、聊天原文、机器路径、账号信息或历史测试流水账。

## 开始工作

- 使用中文沟通，技术标识符保持原样。先明确目标和范围，再读取相关代码、调用方及测试；小范围修改，避免无关重构和新依赖。
- 先检查 Git 状态，保留用户已有改动。按用户授权执行，不自行重置、清理、提交、推送或发布。
- 应用源码位于 `DesktopUI/`，npm 命令在该目录执行；运行入口是构建后的 `dist/main.cjs`。不直接修改 dist、ASAR 或发行 EXE 作为源码修复。
- 当前源码与实际验证优先于历史记录。开发环境、游戏和工具路径按当前设备核对，不复制其他设备的绝对路径或身份数据。

## 按任务阅读

- 功能用法、限制和数据影响：[docs/使用指南.md](docs/使用指南.md)。
- 模块关系、启动流程、权限与数据位置：[docs/架构说明.md](docs/架构说明.md)。
- 环境、目录规则、构建、测试和出包：[docs/开发指南.md](docs/开发指南.md)。
- 重要变更摘要：[docs/开发记录.md](docs/开发记录.md)，不作为当前设备验收证明。
- UI 编辑器：[docs/UI_EDITOR_STATUS.md](docs/UI_EDITOR_STATUS.md)、[docs/EDITOR_ENGINE.md](docs/EDITOR_ENGINE.md)。
- 原生组件：对应 `DesktopUI/native/<组件>/README.md`；第三方来源：[licenses/NOTICE.md](licenses/NOTICE.md) 和 [vendor/SOURCES.md](DesktopUI/electron/debug/vendor/SOURCES.md)。

## Git 提交与版本

- 每次提交、amend 或合并提交前，读取近期提交的完整标题、正文及目标提交差异，保持历史格式和中文风格。标题默认使用 `release: <当前版本>`；同一版本内补充或合并沿用该版本标题，不自行改成新的功能标题。具体流程见[开发指南：Git 提交与版本](docs/开发指南.md#git-提交与版本)。
- 正文沿用“更新”“修复”（有修复时）和“验证与范围”结构，写清实际行为变化、验证结果、未验证项及限制，并与对应 Release Notes 保持一致。禁止只保留标题、丢弃正文或用一句“合并提交”代替变更说明。
- 合并指定提交时，在所有原提交信息基础上整理、去重、修正和补充；保留仍有效的变更说明，核对新增改动是否写入正文。旧测试数量、失败结论和产物哈希不能冒充合并后结果。按要求合为一个提交时，不另拆版本提交。
- 项目版本跟随 Git 版本记录和用户已确认的版本计划，默认不升版。每次提升版本前必须向用户说明目标版本并取得明确同意；本次已明确同意该目标版本的无需重复询问。“提交”“收口”“合并提交”不等于同意升版；不得自行按 patch/minor 递增或以某个标签存在为由跳到下一版。
- 提交后读取最终完整正文并核对差异、父提交、工作区、`package.json`、锁文件、README 和 Release Notes；合并应保留全部约定内容和提交数量。提交、升版、标签、推送和正式发布分别按授权执行；合并不自动移动已有标签，标题含 `release:` 也不代表已正式发布。

## 文件放置与编码

- 正式文档放 `docs/`，可重复测试及夹具放 `DesktopUI/tests/`，正式维护脚本放 `DesktopUI/scripts/`。
- 临时验收存档仅作为测试样本；其名称、路径、内容和专属报告不得进入项目文档，文档只记录通用功能与验证边界。
- 一次性脚本放 `.miao/scripts/`，临时笔记放 `.miao/notes/`；测试脚本、视觉截图、验收报告、测试存档副本和失败日志统一放 `.miao/work/<任务ID>/`，必须有 `manifest.json` 和三天后的 `expiresAt`。可复用的测试进入 `DesktopUI/tests/`，正式维护脚本进入 `DesktopUI/scripts/`。
- `.miao/work/`、`DesktopUI/dist/`、`DesktopUI/release/` 和依赖缓存只保存可归属的本地产物。每个开发窗口结束自己的任务前，必须完成必要验证并运行 `npm.cmd run package` 生成当前版本的最新本地 Release；该命令会先清理未运行的旧 Release，运行中的发行目录暂时保留，退出后由下一次出包收口。开发任务清理使用 `npm.cmd run clean:dev` 预览，再用 `npm.cmd run clean:dev:apply` 删除有清单且已过期的任务。
- 构建、发行和测试输出不得散落到项目根目录；不把交接原文或私人研究资料搬入正式文档。
- 忽略规则只遮蔽可重建依赖、构建输出和明确的本机缓存；`.env`、`.env.example`、`.mcdev.json`、共享 `.vscode/` 和项目本地环境文件默认可见，便于跨设备恢复，但不得写入真实密钥。不能用扩展名或 `.gitignore` 代替归属和生命周期。
- `Thumbs.db`、`.DS_Store`、`desktop.ini`、`ehthumbs.db` 是系统垃圾，发现后直接删除；孤儿任务目录没有 `manifest.json` 时只报告，不自动删除。
- 新增文本使用 UTF-8。修改前确认并保留原编码、BOM 和换行，优先 apply_patch，不整文件转码或顺手格式化。源文件和 JSONC 保留未知字段与注释；业务注释优先中文并遵循当前文件风格。
- PowerShell 处理中文前设置 UTF-8；已确认 UTF-8 的文件显式用 `Get-Content -Encoding UTF8` 读取：

```powershell
$null = chcp 65001
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
```

## 必须保留的边界

- 不打印、写入源码、测试、文档、日志或提交真实密码、Token、Cookie、私钥等；发现疑似泄露只报告位置并建议轮换，不复述内容。
- 不操作其他产品的配置，不把真实存档或业务模组当测试夹具。原目录模式会写回游戏进度；内置启动器的兼容文件和运行清单放在工具箱数据目录。旧 `.toolbox-packs` 含真实源码，仅按有备份和冲突检查的迁移流程恢复，不能当临时文件删除。
- 草稿、已保存配置、运行快照和真实存档分离；保留 revision、备份、来源变化检查及失败处理。
- 渲染器保持 sandbox/contextIsolation、禁用 Node.js；新增 UI 操作须同步主进程 handler 与 preload 白名单，不让测试绕过 IPC。
- 只管理可证明属于本工具的进程。保留 registrationId、PID/父 PID、EXE 路径/句柄校验、存档互斥、LevelDB LOCK、Job 和引擎哈希限制；不按进程名批量结束游戏。
- 独立主机隔离运行环境，不隔离共用源码；修改前确认 sourceRoots/sharedSources。不能为测试通过放宽产品超时或进程保护。
- MCP 按目标会话及实际 schema 调用。代码/重载等操作核对 sessionId/generation；结果不明时先读状态，不自动重放副作用。
- 本机多人测试先核对 toolbox_status/list_worlds/list_clients，必要时 launch_world，再 launch_joined_client 指定 hostSessionId、不同玩家名；新请求用独立 requestId，同次重试复用 ID。只有 autoJoin.phase=joined 才算入房成功。桌面输入串行。
- 本机测试不启用远程房间/隧道；自动化环境变量不等于完整实机隔离。DGN_GAME_DATA_DIR 还改变测试检查分支，详见开发指南。
- Windows 递归删除或移动前核对绝对目标路径及目录链接，只操作任务明确涉及的范围；不要覆盖正在运行的发行目录。

## 验证与交付

- 改动只跑必要检查：`npm.cmd run build`、`npm.cmd test`、对应 UI/原生/打包验证；服务测试默认并发度为 4，必要时串行复测并保留失败说明。
- 区分静态检查、服务测试、模拟 UI、最终 ASAR/EXE 与真实游戏验证；跳过的原生探针不算通过，不从旧记录复制通过数量。
- 修改功能入口同时核对界面、IPC/preload、服务、MCP（若适用）、测试和说明；只修改受本任务影响的部分。
- 当功能改动已接近完成并通过必要验证时，每个开发窗口都要先生成当前版本的本地最新 Release；再主动检查是否进入版本迭代边界，并向用户询问是否升 patch/minor 版本、编写 Release 说明、提交、打标签和正式发布。不得自行执行这些不可逆或对外操作。只有 GitHub Release 的版本标签、匹配版本的 ZIP 和 `.sha256` 资产完整发布后，客户端更新模块才会识别新版本；本地 Release 是窗口收口证据，不等于正式发布。
- 版本边界按上文“Git 提交与版本”核对提交记录、标签和用户已确认的版本计划。并行开发窗口不得自行把 `package.json`、README 或 `docs/releases/` 推进到下一个未确认版本；未打标签、未发布的版本只能保留为明确的本地工作版本，不能称为正式版本。
- 出包使用 `npm.cmd run package`，保留构建白名单、runtime、许可证及 ZIP 校验；原生源码变化先按对应脚本重编。
- 保留 esbuild 的 `mainFields: ["module", "main"]`；给普通 Node/helper 执行的入口不得依赖 Electron 的 ASAR 文件读取能力。
- 完成后说明改动、验证结果、未验证项和风险。产品说明写入正式文档，变更摘要写入开发记录，临时过程放忽略目录；不重新堆积到本文件。
