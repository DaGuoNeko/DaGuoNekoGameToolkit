# 菜单客户端玩家名

仅适配 Windows x64 网易开发客户端的本地访客（`Social::User_generic`）。通过本工具的 Host Bridge 获取新游戏 PID，助手再次检查父 PID、进程创建时间和完整程序路径，随后在该进程加载本项目 DLL。外部或已存在的其他游戏不会作为目标。

DLL 使用已加载映像中的 RTTI、名称相关调用和函数形状定位接口，不使用固定地址。解析及扫描有大小和数量边界，读取使用 ReadProcessMemory。只替换访客的显示名称 getter；返回字符串由游戏自己的字符串复制函数构造，保留游戏的分配/释放规则。名称保存在各进程自己的 DLL 数据区。不会写入游戏 EXE、MCDK、options.txt、账号 ID 或认证信息。

注意名称 getter 与相邻的可选登录标识 getter 不同。后者必须保留；只让主菜单显示正确并不能证明联机玩家名正确。适配结构不匹配时返回错误，主程序停止刚启动的客户端，而不回退成随机名字。

构建使用 Zig 0.13.0 的 C 编译器：

```powershell
./scripts/build-menu-name.ps1 -Zig C:/path/to/zig.exe
```

这是 freestanding C 实现；DLL 仅导入 KERNEL32，助手导入 KERNEL32/SHELL32，不链接额外 C/C++ CRT 或 MinHook。构建中间文件留在此目录的 build 下，只有两个最终二进制复制到 runtime/native；native 源码目录不参与产品打包。

已实测开发版 3.10.0.420447：不同进程分别以 a/b 停在主菜单，手动加入同一局域网测试世界后，服务端玩家列表分别读回 a/b。其他引擎版本需要独立验证，不能用模拟启动器测试替代真实姓名验证。

2026-10-16：开发版 3.10.0.436581 双客户端验证通过，Build436Host/Build436Guest 的名字及不同玩家 ID 在房主服务端正确读回；既有动态解析代码无需改变。
