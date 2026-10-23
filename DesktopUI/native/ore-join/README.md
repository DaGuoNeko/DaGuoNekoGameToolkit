# OreUI 自动联机桥

自有 Windows x64 进程内 DLL，复用已有的受控 `menu-name-helper.exe` 加载器。只用于本工具创建的自动联机客户端及其同进程重连，仍检查父 PID 和游戏 EXE。

- Node 在打开新游戏前校验已验证 EXE 的 SHA-256，目前支持开发版 3.10.0.420447、3.10.0.436581；版本登记统一来自 electron/supported-engines.json，构建网络助手时生成相同的校验集合。DLL 再从 Python 方法注册名、包装器指令和服务访问器动态解析地址，未编入游戏 RVA；结构不匹配时拒绝。
- 临时改变进程内 OreUIDebugging 布尔值，不调用持久化选项 setter。原值在 seal 或 180 秒看门狗到期时恢复。
- MinHook 仅在该游戏进程挂接 Winsock 函数。bind 只处理调用来源位于 HttpServer.WindowsDesktop.dll 的监听，将其重定向到本次分配的回环地址和端口。其他调用来源正常转发；accept/recv/closesocket 只限制此监听衍生的连接。
- seal 后拒绝该调试通道的新连接，已有连接的后续读取返回 EOF；让 HttpServer 自己释放 socket，不在外部强制关闭仍由引擎持有的 socket。钩子留在本进程直到游戏退出，避免已有回调被卸载后跳入失效代码。
- 重连可用 resume:<原端口> 开始新的最长 180 秒临时开放期，只接受原端口且要求当前已封闭；不接受任意更换端口或重复延长正在使用的开放期。单个看门狗线程按当前期限封闭，seal/恢复由锁串行保护；已接受连接记录所属开放期，旧连接在后续开放期仍返回 EOF。
- 断线确认可能消耗第一次 Enter；只有该进程的回环 HTTP 端点连续确认没有 OreUI 页面（原生 JSON null/空列表）至少 5 秒后，才再发送一次 Enter 打开主菜单的游戏页。网络错误不触发额外按键，加入调用仍每次只发送一次。
- 游戏、模组、MCDK 二进制不落盘修改；用户无需 Python、Ghidra 或编译器。动态地址解析不等于承诺所有游戏版本兼容，新增版本需独立验证并登记哈希。

构建：`scripts/build-ore-join.ps1 -Zig <Zig 0.13.0 的绝对路径>`。MinHook 1.3.4 的源码和许可证位于 `minhook/`，发行许可证在根目录 `licenses/OreJoin-MinHook-LICENSE.txt`。这些源码不进入 ASAR，仅分发 DLL 与许可证。
