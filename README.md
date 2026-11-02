# 大果喵游戏工具箱

**DaGuoNeko Game Toolkit · 0.1.11**

面向网易《我的世界》模组开发的 Windows x64 桌面工具。提供存档与启动配置管理、多客户端测试、运行日志、脚本热更新、UI 调试、性能分析、AI 多会话控制和授权成员版本更新，无需打开 VS Code。

## 使用入口

完整解压发行 ZIP，运行 `DaGuoNeko-Game-Toolkit.exe`，先在“设置 → 全局游戏程序”选择本机网易开发版游戏，再导入存档或创建测试世界。分发时保留完整程序目录，不能只复制 EXE。

游戏本体、业务模组和用户存档不随包提供。“直接使用原目录”会读写原存档；内置启动器把兼容文件和运行清单放到工具箱数据目录，自带包源码保留原位置。旧 `.toolbox-packs` 会备份清单后恢复原包目录；自定义启动器仍沿用原兼容模式。需要保留原件及进度时选择“复制导入”。

## 技术架构

| 层 | 技术与职责 |
|---|---|
| 桌面界面 | Electron 44.5.1、React 19.3.0、JavaScript/JSX 和 CSS |
| 本机服务 | Node.js、受限 preload/IPC、配置与存档服务、Sessions 多会话管理 |
| 游戏连接 | 内置官方 MCDK v1.6.1、Host Bridge、MCP SDK |
| 原生辅助 | Windows C/汇编桥、C# 网络助手、C++/WebAssembly 布局内核 |
| 构建与验证 | esbuild、Electron Packager、Node test runner、Playwright |

界面和 AI 通过各自入口调用同一组本机服务，再由 MCDK 启动和调试游戏。用户数据与源码分开保存；当前架构没有独立云端业务后端。模块关系和数据边界见[架构说明](docs/架构说明.md)。

## 文档

- [使用指南](docs/使用指南.md)：存档、配置、日志、调试、联机和 MCP。
- [AI 自动化接口](docs/AI自动化.md)：MCP 工具、断言处理、资源预检、配置/存档控制和固定拍摄。
- [开发指南](docs/开发指南.md)：环境、目录用途、临时文件、测试与出包。
- [架构说明](docs/架构说明.md)：模块分工、启动流程、数据与权限边界。
- [开发记录](docs/开发记录.md)：产品变更摘要及验证范围。
- [UI 编辑器功能对照](docs/UI_EDITOR_STATUS.md)、[官方编辑器引擎预览](docs/EDITOR_ENGINE.md)：专项功能和限制。
- [AGENTS.md](AGENTS.md)：各开发设备共用的工作规则。

源码开发从 `DesktopUI/package.json` 和锁文件开始。所有 npm 命令在 `DesktopUI/` 执行；`npm.cmd ci` 安装依赖，`npm.cmd run build` 构建，`npm.cmd run package` 生成 `DesktopUI/release/` 下的运行目录、ZIP 和校验文件。开发启动前先阅读开发指南的数据隔离说明。

## 来源、版权与使用声明

界面骨架来自 [DaGuoNeko/DaGuoNekoModToolkit](https://github.com/DaGuoNeko/DaGuoNekoModToolkit) 3.0.0；本项目独立维护，不使用其资源打包后端。启动与调试实现参考或移植自 [Dofes/mcdev-tools](https://github.com/Dofes/mcdev-tools) 的相关模块；游戏启动核心使用 [GitHub-Zero123/MCDevTool](https://github.com/GitHub-Zero123/MCDevTool) 官方二进制。

第三方组件的版权、许可证、固定来源和修改说明保存在 [licenses/NOTICE.md](licenses/NOTICE.md)、[licenses/](licenses/) 及[调试模块来源说明](DesktopUI/electron/debug/vendor/SOURCES.md)，发行包保留相应文本。第三方许可证分别适用于对应组件，本页不另行指定本项目原创代码的授权条款。

本项目不是网易、Mojang/Microsoft 或上述第三方作者的官方产品，名称仅用于说明兼容对象与来源，不代表其背书。游戏及编辑器须由使用者自行通过相应渠道准备。

独立多主机、原生自动入房等能力受已核验游戏构建限制；远程联机仍处于实验验证阶段，UI 编辑器尚未完整对齐官方编辑器。测试或开发记录中的通过结论仅覆盖注明的环境和场景。
