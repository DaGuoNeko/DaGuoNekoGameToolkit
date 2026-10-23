# Electron domains

主进程业务按功能域组织；`main.cjs`、`services.cjs`、`preload.cjs` 和隔离基础设施留在 `electron/` 根目录，作为装配与平台边界。

- `worlds/`：存档、包和世界变更
- `profiles/`：启动配置和全局模组库
- `game/`：游戏发现、进程、选项、日志和历史
- `reload/`：快速测试、来源检查和重启
- `editor/`：UI 文档和官方编辑器桥
- `automation/`：MCP、自动化路由和 stdio 入口
- `client/`：本机客机、OreUI 和菜单识别
- `performance/`：Tracy 窗口和采样
