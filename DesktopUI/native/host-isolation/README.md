# 独立存档主机

自有 Windows x64 启动桥，保留原 MCDK v1.6.1 和游戏二进制。当前仅为 SHA-256 已登记的开发版 3.10.0.436581 启用；其他构建和自定义启动器保留兼容单主机方式。“设置 → 存档主机 → 启用独立主机”可关闭此功能，修改用于后续启动。

每个实际存档路径对应独立 Roaming、Local、LocalLow 环境，位于当前用户的 `DgnGameToolkitHosts` 目录。保持原版 Windows Python 模组加载器需要的目录层级，拒绝被重定向的运行根目录。运行环境中的受控 junction 指向原存档；复制存档和直接使用原目录的保存位置不变。自带包通过本次会话的 `runs/<session>/world-packs/` 注册，原地图源码目录保持原位置；原生桥只把包目录和包清单映射到运行目录，数据库与进度仍写回实际存档。新存档使用 MCDevTool 的公开默认 level.dat 模板初始化，再由原 MCDK 应用世界规则。

Electron utility process 持有存档互斥量、父进程句柄与 Job。创建 MCDK 时通过 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子加入带 KILL_ON_JOB_CLOSE 的 Job；在自有新进程的主线程入口前执行引导，加载隔离 DLL 后等待工具箱放行，随后进入原始入口。MCDK 仅对指定游戏 EXE 的 CreateProcessW 作相同处理。兼容其原 CREATE_SUSPENDED / ResumeThread 协议；不对既有游戏补装隔离。

独立模式重定向 AppData 对应的 Known Folder / CSIDL 查询，环境变量同步隔离且按 Windows 大小写语义去重。内置启动器另按当前世界原路径及已验证运行入口映射包目录、世界包清单和开发配置；仅已登记包 UUID 的 manifest.json 使用会话目录内的兼容描述。数据库、level.dat、其他世界及无关文件仍交给原函数；原子重命名目标也按相同边界处理。兼容单主机模式保留共享环境与全局进程冲突检查，自定义启动器不启用映射。引导内存和钩子随进程保留，避免执行中卸载。停止只关闭该主机的 Job；辅助进程或工具箱退出时清理其子进程。Local 命名互斥量防止同登录会话中的工具箱重复启动同一实际存档，另外检查 LevelDB LOCK 是否被游戏持有。

这提供运行目录与会话隔离，不复制源代码。多个配置引用同一目录或上下级目录时，UI 和 MCP 会报告共享源码；需要分别修改时使用独立目录/工作副本。MCP 的代码、日志、重载及停止继续指定 sessionId/generation，不使用默认 mcdk_game 代替目标会话。联机页仍沿用现有单个对外共享房间流程。

构建：`scripts/build-host-isolation.ps1 -Zig <Zig 0.13.0 的完整路径>`。源码复用 `native/ore-join/minhook` 中的 MinHook 1.3.4，许可证见 `licenses/OreJoin-MinHook-LICENSE.txt`；新的主线程引导与隔离实现为本项目代码。测试用原生 probe 仅输出到本目录 build，不进入发行包。`node --test tests/host-isolation.test.cjs` 覆盖原生目录重定向、进程组、重复启动锁、停止兼容和私有设置；真实游戏与发行验证记录保存在维护者本地，不随公开仓库分发。
