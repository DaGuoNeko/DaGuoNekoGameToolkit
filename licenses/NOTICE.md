# 第三方来源与许可证

- 界面骨架：DaGuoNeko/DaGuoNekoModToolkit，复制时提交 `1d6cd81962803e16a47d579109405338d69e2c86`。此处为用户要求建立的独立派生项目。
- MCDK 二进制：GitHub-Zero123/MCDevTool 官方 v1.6.1，源代码提交 `cefdfb5ce220e0cc3e9df6d80b2ff87be8b98802`，未修改二进制。
- 独立主机初始化复用该提交 `src/level.cpp` 的公开默认 level.dat 模板（BSD-3-Clause），用于新建世界，不包含用户存档。许可证见 `MCDevTool-LICENSE.txt`。
- 独立主机启动桥为本项目自行实现，复用 MinHook 1.3.4；许可证与 OreUI 桥共用 `OreJoin-MinHook-LICENSE.txt`。只作用于本次创建的进程，不修改磁盘上的游戏或 MCDK 二进制。
- 源码获取：https://github.com/GitHub-Zero123/MCDevTool/tree/v1.6.1
- 源码压缩包：https://github.com/GitHub-Zero123/MCDevTool/archive/refs/tags/v1.6.1.zip
- 启动与配置流程研究参考 Dofes/mcdev-tools，提交 `a31d4a4514593c78745dded5cad19eab0d87fb4b`。未整体移植其 VS Code 调试器。
- MCDK 及已知依赖的许可证随本目录分发。NBT、BinaryStream 的 MPL-2.0 源码可在上述 MCDK 源码仓库对应 `libs/nbt` 及 `libs/nbt/libs/binarystream` 目录取得。本项目未修改这些库。
- React、React DOM、jsonc-parser：对应版权及许可证文件附于本目录。
- 地图预览使用 `@jsprismarine/leveldb` 0.16.0（MIT）和 `prismarine-nbt` 2.8.0（MIT）；前者随 npm 包提供许可证，后者的上游包未携带许可证文件，项目保留 `prismarine-nbt-MIT.txt`。
- ZIP 存档导入使用 yauzl 3.4.0 与 pend 1.2.0（MIT），许可证见 `yauzl-MIT.txt`、`pend-MIT.txt`。
- Electron 运行时的许可证与 Chromium 第三方说明保留在发布目录中。
- 本机多主机的 NetherNet 局域网发现报文参考 df-mc/go-nethernet 的 `discovery`（提交 `215e46422b5831d6ddc6146003617dc3f1ff7c26`，MIT），协议封装使用 Node 内置密码库重新实现；未引入 Go 运行时。许可证见 `NetherNet-MIT.txt`，来源：https://github.com/df-mc/go-nethernet。
- 多客户端 MCP 使用官方 `@modelcontextprotocol/sdk` 1.32.1 与 Ajv 8.20.0。所有生产 JavaScript 依赖的固定版本、版权与完整许可证文本汇总于 `JavaScript-dependencies-NOTICES.txt`；生成脚本为 `DesktopUI/scripts/mcp-licenses.mjs`。未替换原 MCDK 二进制或原 Codex MCP 配置项。
- 调试模块从 Dofes/mcdev-tools 0.1.32 的上述固定提交独立移植，模块对应关系与适配说明见源码 `DesktopUI/electron/debug/vendor/SOURCES.md`。MIT 许可证保留于本目录。
- `runtime/native/koffi.node` 与 `mcdev-tracy-bridge.dll` 独立复制自本机已安装的官方 MC Dev Tools 0.1.32 扩展分发目录；软件运行无需该扩展。Tracy 桥接 API 为 1，Tracy 协议为 0.11.1。Koffi、Tracy、Capstone 的许可证随本目录分发。
- Koffi 二进制 SHA-256：`c56266742f01bb5e4a35cc159abfba3383964824e6c8face9dcb7d2f0d21006b`。
- Tracy 桥接库 SHA-256：`84717e840ddc194954cbac259de683946c2feea349756a855aae1a76b17474cb`。
- 菜单玩家名助手 `menu-name-helper.exe` 与 `menu-name.dll` 为本项目自行实现，源码位于 `DesktopUI/native/menu-name/`，用 Zig 0.13.0 的 C 工具链构建。运行时只依赖 Windows 的 KERNEL32/SHELL32；没有链接 MinHook 或复制游戏实现。只替换本次启动进程中本地访客的显示名称接口，游戏 EXE 和 MCDK 二进制均未改写。
- 菜单名称 DLL SHA-256：`049a117587830b2d7b88591cffe1c5851fc83fca9e4ad0ab994bb5b603f5c65f`。
- 菜单名称助手 SHA-256：`1195fbf82e0714e1549d4d9a9776375a5f8470710c1215e25d24ee21a36d405f`。

项目名称仅用于标明来源，不表示上游作者为本软件背书。
