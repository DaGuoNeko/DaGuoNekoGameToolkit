# Shared modules

这里的 CommonJS 模块同时被 renderer、Electron 主进程和测试使用。

- 只放与 Electron、DOM、`window` 和本机进程无关的纯逻辑。
- 保持现有 `module.exports`，不在这里访问用户数据、IPC 或运行时目录。
- 需要依赖具体运行环境的代码放回 `src/features/` 或 `electron/domains/`。
