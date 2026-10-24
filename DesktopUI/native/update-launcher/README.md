# 更新启动器

`Program.cs` 编译为无窗口的 .NET Framework x64 程序。使用 `node scripts/build.mjs` 或 `powershell -File scripts/build-update.ps1` 构建到 `runtime/native/update-launcher.exe`，不需要管理员权限。

Windows 下不能直接将 PowerShell 以 Node 的 detached 模式启动（可能空退出），也不能让安装脚本属于即将退出的客户端进程组。客户端将此 GUI 启动器和 PowerShell 脚本复制到更新缓存，在 detached 模式启动 GUI 启动器；启动器负责启动并等待 PowerShell，将标准输出和错误写入专属日志。客户端收到脚本的准备回执后才退出。

启动器只管理本次更新脚本，不枚举、结束或接管游戏进程。ZIP 校验、同盘暂存、取消、备份和回滚均由 `electron/update-helper.ps1` 完成。源码和生成脚本随 Git 同步，生成 EXE 由构建白名单纳入发行包。
