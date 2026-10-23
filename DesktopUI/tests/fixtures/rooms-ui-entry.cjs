// UI fixture only. Product builds never import this file.
const path = require("node:path");
const { app, ipcMain, clipboard } = require("electron");
const root = process.env.DGN_UI_BUNDLE_DIR || path.resolve(__dirname, "../..");
app.setAppPath(root);
let state = { phase: "idle", members: [] };
let failedLeave = false;
let resumedPolls = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  handle(channel, async (event, method, args) => {
    if (channel !== "request" || !method.startsWith("rooms."))
      return handler(event, method, args);
    try {
      let result;
      switch (method) {
        case "rooms.draft":
        case "rooms.saveDraft":
          return handler(event, method, args);
        case "rooms.state":
          if (state.phase === "waiting_host" && ++resumedPolls >= 2)
            state = {
              ...state,
              phase: "joined",
              message: "已自动重新加入",
              scriptSync: { phase: "synced", message: "重连后脚本同步已恢复" },
            };
          result = state;
          break;
        case "rooms.settings":
          result = { endpoint: "frp.example.test:36559", localPort: 11010 };
          break;
        case "rooms.create":
          state = {
            phase: "hosting",
            fixed: !!args.roomCode,
            role: "host",
            name: "联机测试地图",
            networkReady: true,
            gameReady: true,
            members: [],
            message: "房间已创建",
            scriptSync: { phase: "ready", message: "已开启联机 Python 热更新" },
          };
          result = state;
          break;
        case "rooms.invite":
          state.members.push({
            id: "test-invite",
            expires: Date.now() + 3600000,
            phase: "joined",
            playerName: "SyncFriend",
            scriptSync: {
              phase: "synced",
              message: "已同步 1 个文件，热更新 1 个已加载模块",
            },
          });
          clipboard.writeText(state.fixed ? "DGNROOM2:UI-FIXTURE" : "DGNROOM1:UI-FIXTURE");
          result = { expires: Date.now() + 3600000, fixed:state.fixed };
          break;
        case "rooms.revoke":
          state.members[0].phase = "revoked";
          result = state;
          break;
        case "rooms.close":
          if (state.name === "清理重试房间" && !failedLeave) {
            failedLeave = true;
            throw Error("测试：客户端已退出，清理需要再次重试");
          }
          state = { phase: "idle", members: [] };
          result = state;
          break;
        case "rooms.retry":
          state = {
            ...state,
            phase: "waiting_host",
            canRetry: false,
            message: "等待房主恢复",
          };
          resumedPolls = 0;
          result = state;
          break;
        case "rooms.join":
          if (Object.keys(args).sort().join(",") !== "invitation,playerName")
            throw Error("Join UI sent unexpected profile/config fields");
          if (args.playerName === "ReconnectGuest") {
            state = {
              phase: "reconnect_blocked",
              role: "guest",
              name: "恢复测试房间",
              message: "客户端已保留",
              canRetry: true,
              members: [],
            };
            result = state;
            break;
          }
          if (args.playerName === "RetryGuest") {
            state = {
              phase: "needs_attention",
              role: "guest",
              name: "清理重试房间",
              message: "联机清理未完成；处理上述问题后可再次点击离开重试",
              members: [],
            };
            result = state;
            break;
          }
          throw Error("测试：游戏版本不一致");
        default:
          throw Error("Unknown fixture operation");
      }
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
require(
  path.join(
    root,
    process.env.DGN_UI_BUNDLE_DIR ? "app.asar/dist/main.cjs" : "dist/main.cjs",
  ),
);
