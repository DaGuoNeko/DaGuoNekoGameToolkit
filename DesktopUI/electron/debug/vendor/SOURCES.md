# 调试协议与辅助模块来源

这些模块从 Dofes/mcdev-tools 的 MIT 源码中独立移植，不包含 VS Code API、Terminal、webview 或 IDE 调试会话实现。

- 固定提交：`a31d4a4514593c78745dded5cad19eab0d87fb4b`（0.1.32）。
- 源码：https://github.com/Dofes/mcdev-tools/tree/a31d4a4514593c78745dded5cad19eab0d87fb4b/src
- 许可证：项目根目录 `licenses/MCDevTools-LICENSE.txt`。
- `protocol.cjs`、`server.cjs`、`uiDebugger.cjs`、`pythonProfiler.cjs`、`pythonMemoryProfiler.cjs`、`nativeProfilerCapture.cjs`、`nativeProfilerPortDiscovery.cjs` 来自对应 `src/hostBridge/*.ts`。
- `functionParser.cjs` 来自 `src/debugFunctions/parser.ts`。
- `dynamicLibraryManager.cjs` 来自 `src/native/dynamicLibraryManager.ts`。
- 对应 `tests/debug-*.test.cjs` 中带来源标记的测试也从同一提交移植。

移植时使用 esbuild 去除 TypeScript 类型并转换为 CommonJS，修改相对模块引用；原始 TypeScript 可由固定提交取得。项目自身的控制器、IPC 和 React 调试页为独立实现。

本地适配：Native 库从应用自己的 `runtime/native` 读取；netstat 使用 System32 绝对路径及超时；临时采样清理前校验目录范围；会话刷新忽略旧状态序号；会话通知保留 Minecraft 的真实退出码。控制器为 Python 采样生成独立所有权命名空间，为内存跟踪添加超时释放，并负责会话切换、取消和应用退出清理。
