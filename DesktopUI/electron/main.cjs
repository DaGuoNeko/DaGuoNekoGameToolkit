const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  protocol,
  net,
  session,
  clipboard,
  safeStorage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WorkspaceStore, Launcher } = require("./services.cjs");
const { discoverGames } = require("./domains/game/discovery.cjs");
const { inspectEngine, profilesForDiscovery } = require("./domains/client/engine-profiles.cjs");
const { formatLine } = require("./domains/game/history.cjs");
const { GameLogs } = require("./domains/game/game-logs.cjs");
const { DebugController } = require("./debug/controller.cjs");
const { InspectorWindow, inspectorMethods } = require("./inspector-window.cjs");
const { WorldLibrary } = require("./domains/worlds/worlds.cjs");
const { assertWorldMutation } = require("./domains/worlds/world-mutation.cjs");
const { WorldActions } = require("./domains/worlds/world-actions.cjs");
let worldActions;
const { ArchitectureImport } = require("./domains/worlds/architecture-import.cjs");
let architectureImport;
const { GameTitles } = require("./domains/game/game-titles.cjs");
let gameTitles;
const { Profiles } = require("./domains/profiles/profiles.cjs");
const { Sessions } = require("./sessions.cjs");
const { ReloadSources } = require("./domains/reload/reload-sources.cjs");
let reloadSources;
const { HostIsolation } = require("./host-isolation.cjs");
const { MenuName } = require("./domains/client/menu-name.cjs");
const { AutomationRouter } = require("./domains/automation/automation-router.cjs");
const {
  AutomationBridge,
  installAutomation,
} = require("./domains/automation/automation-bridge.cjs");
let automation;
const { ClientJoiner } = require("./domains/client/client-join.cjs");
let clientJoiner;
const { Rooms } = require("./network/rooms.cjs");
let rooms;
const { TracyProfiler, assertPortFree } = require("./domains/performance/tracy-profiler.cjs");
const { UpdateService } = require("./domains/update/update-service.cjs");
const { createUpdateFetch } = require("./domains/update/update-fetch.cjs");
let tracyProfiler;
let updateService;
const execFile = require("node:util").promisify(
  require("node:child_process").execFile,
);
app.setName("大果喵游戏工具箱");
app.setAppUserModelId("com.daguoneko.gametoolkit");
const dataRoot =
  process.env.DGN_GAME_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA, "DaGuoNeko_GameToolkit");
app.setPath("userData", path.join(dataRoot, "Electron"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const store = new WorkspaceStore(dataRoot);
const { GameProcesses } = require("./domains/game/game-processes.cjs");
const gameProcesses = new GameProcesses({
  paths: async () => {
    await store.queue;
    const paths = [store.value.settings.GamePath];
    for (const project of store.value.projects) {
      const snapshot = await store.readProject(project.id);
      if (snapshot.config?.game_executable_path)
        paths.push(
          path.resolve(
            project.baseDirectory || project.root,
            snapshot.config.game_executable_path,
          ),
        );
    }
    for (const worker of launcher?.workers || [])
      if (worker.session?.running)
        paths.push(worker.sourceSnapshot.config.game_executable_path);
    return paths;
  },
});
const profiles = new Profiles(store);
const { UiDocuments } = require("./domains/editor/ui-editor.cjs");
const uiDocuments = new UiDocuments(dataRoot);
const { EditorEngine } = require("./domains/editor/editor-engine.cjs");
let editorEngine;
const { ModLibrary } = require("./domains/profiles/mod-library.cjs");
const modLibrary = new ModLibrary(store, profiles);
const { GameOptions } = require("./domains/game/game-options.cjs");
const gameOptions = new GameOptions(
  dataRoot,
  path.join(
    process.env.DGN_GAME_DATA_DIR
      ? path.join(dataRoot, "game-data")
      : process.env.APPDATA,
    "MinecraftPE_Netease",
    "minecraftpe",
    "options.txt",
  ),
  {
    isRunning: async () =>
      !!launcher?.hasRunning ||
      (!process.env.DGN_GAME_DATA_DIR && (await gameProcesses.any())),
  },
);
const approvedImages = new Set();
const approvedDirectories = new Set();
const approvedWorldArchives = new Set();
let win,
  launcher,
  debuggerService,
  inspectorWindow,
  worlds,
  closing = false,
  closeRequested = false,
  dirty = false;
const normalize = (file) => path.resolve(file).toLowerCase();
const filters = {
  executable: [{ name: "Windows 程序", extensions: ["exe"] }],
  background: [
    {
      name: "背景图片",
      extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"],
    },
  ],
  "chunker-jar": [
    { name: "Chunker CLI", extensions: ["jar"] },
  ],
};
function emitTheme() {
  for (const target of [win, inspectorWindow?.window])
    if (target && !target.isDestroyed()) {
      target.setBackgroundColor(
        nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff",
      );
      target.webContents.send("theme", {
        dark: nativeTheme.shouldUseDarkColors,
        settings: store.value.settings,
      });
    }
}
function settingsChanged() {
  nativeTheme.themeSource = { System: "system", Light: "light", Dark: "dark" }[
    store.value.settings.AppearanceMode
  ];
  if (store.value.settings.BgImagePath)
    approvedImages.add(normalize(store.value.settings.BgImagePath));
  emitTheme();
}
function sourceRoots(snapshot) {
  return [
    snapshot.project.baseDirectory || snapshot.project.root,
    ...snapshot.config.included_mod_dirs.map((item) =>
      path.resolve(
        snapshot.project.baseDirectory || snapshot.project.root,
        typeof item === "string" ? item : item.path,
      ),
    ),
  ];
}
async function locateSource(roots, file) {
  const realRoots = [];
  for (const root of roots) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const found = new Map();
  for (const candidate of path.isAbsolute(file)
    ? [file]
    : realRoots.map((root) => path.resolve(root, file))) {
    try {
      const real = await fs.realpath(candidate);
      if (
        realRoots.some((root) => {
          const r = path.relative(root, real);
          return (
            r &&
            r !== ".." &&
            !r.startsWith(".." + path.sep) &&
            !path.isAbsolute(r)
          );
        }) &&
        (await fs.stat(real)).isFile()
      )
        found.set(real.toLowerCase(), real);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (found.size !== 1)
    throw Error(
      found.size
        ? "多个模组中存在同名文件，请使用完整路径"
        : "源文件不在这套配置的模组目录中",
    );
  return [...found.values()][0];
}
async function dispatch(method, args, source = win) {
  switch (method) {
    case "rooms.state":
      return rooms.snapshot();
    case "rooms.settings":
      return rooms.settings();
    case "rooms.draft":
      return rooms.draft();
    case "rooms.saveDraft":
      return rooms.saveDraft(args);
    case "rooms.create":
      return rooms.create(args);
    case "rooms.join":
      return rooms.join(args);
    case "rooms.close":
      return rooms.close();
    case "rooms.retry":
      return rooms.retry();
    case "rooms.revoke":
      return rooms.revoke(args.id);
    case "rooms.invite": {
      const invite = await rooms.invite();
      clipboard.writeText(invite.text);
      return { expires: invite.expires, fixed: invite.fixed };
    }
    case "tracy.state":
      return tracyProfiler.snapshot();
    case "tracy.start":
      return tracyProfiler.start(
        { sessionId: args.sessionId, generation: args.generation },
        win,
      );
    case "tracy.bounds":
      tracyProfiler.bounds(args);
      return true;
    case "tracy.mode":
      return tracyProfiler.mode(args, win);
    case "tracy.close":
      return tracyProfiler.close(args);
    case "tracy.pick-exe": {
      const chosen = await dialog.showOpenDialog(win, {
        title: "选择官方 Tracy Profiler 0.11.1",
        properties: ["openFile"],
        filters: [{ name: "tracy-profiler.exe", extensions: ["exe"] }],
      });
      return chosen.canceled
        ? null
        : tracyProfiler.configure(chosen.filePaths[0]);
    }
    case "tracy.open-trace": {
      const chosen = await dialog.showOpenDialog(win, {
        title: "打开 Tracy 采样文件",
        properties: ["openFile"],
        filters: [{ name: "Tracy capture", extensions: ["tracy"] }],
      });
      return chosen.canceled
        ? null
        : tracyProfiler.start({ traceFile: chosen.filePaths[0] }, win);
    }
    case "ui-editor.preview.state":
      return { ...editorEngine.snapshot(), tree: editorEngine.tree || null };
    case "ui-editor.preview.properties":
      return editorEngine.properties(args);
    case "ui-editor.preview.start":
      return editorEngine.start(args, win);
    case "ui-editor.preview.stop":
      return editorEngine.stop();
    case "ui-editor.preview.sync":
      return editorEngine.sync(args);
    case "ui-editor.preview.select":
      return editorEngine.select(args);
    case "ui-editor.preview.bounds":
      editorEngine.bounds(args, win);
      return true;
    case "ui-editor.preview.game":
      return editorEngine.showGame(args.value);
    case "ui-editor.preview.pick-engine": {
      const chosen = await dialog.showOpenDialog(win, {
        title: "选择官方编辑器引擎",
        properties: ["openFile"],
        filters: [
          { name: "Minecraft.Windows.Editor.exe", extensions: ["exe"] },
        ],
      });
      return chosen.canceled
        ? null
        : editorEngine.configure(chosen.filePaths[0]);
    }
    case "ui-editor.open": {
      const selected = await dialog.showOpenDialog(win, {
        title: "打开 JsonUI 文件",
        properties: ["openFile"],
        filters: [{ name: "JsonUI", extensions: ["json", "jsonc"] }],
      });
      return selected.canceled ? null : uiDocuments.open(selected.filePaths[0]);
    }
    case "ui-editor.save":
      return uiDocuments.save(args);
    case "ui-editor.save-as": {
      const selected = await dialog.showSaveDialog(win, {
        title: "另存 UI 文件（新文件）",
        defaultPath: "new_screen.json",
        filters: [{ name: "JsonUI", extensions: ["json"] }],
      });
      if (selected.canceled) return null;
      const task = uiDocuments.queue.then(() =>
        uiDocuments.create(selected.filePath, args.raw),
      );
      uiDocuments.queue = task.catch(() => {});
      return task;
    }
    case "ui-editor.texture":
      return uiDocuments.texture(args.id, args.name);
    case "bootstrap":
      return {
        ...store.value,
        ...launcher.state(),
        version: app.getVersion(),
        dark: nativeTheme.shouldUseDarkColors,
        runtime: launcher.runtime,
        warning: store.warning,
        debug: debuggerService.snapshot(),
      };
    case "debug.state":
      return debuggerService.snapshot();
    case "debug.refresh":
      return debuggerService.refresh();
    case "debug.reload":
      return debuggerService.reload(args);
    case "debug.sources":
      return reloadSources.status(args);
    case "debug.restartLatest":
      return reloadSources.restart(args);
    case "debug.execute":
      return debuggerService.code(
        args.sessionId,
        args.generation,
        args.code,
        args.isClient,
      );
    case "debug.ui":
      return debuggerService.uiCommand({
        ...args,
        owner: String(source.webContents.id),
      });
    case "inspector.state":
      return inspectorWindow.state(source);
    case "inspector.open":
      return inspectorWindow.launch(source, args);
    case "inspector.cache":
      return inspectorWindow.save(source, args.entries);
    case "inspector.selected":
      return inspectorWindow.select(source, args.selected);
    case "inspector.close":
      return inspectorWindow.close(source);
    case "inspector.command":
      return inspectorWindow.command(source, args);
    case "inspector.command-result":
      return inspectorWindow.commandResult(source, args);
    case "debug.copy-path": {
      if (
        typeof args.path !== "string" ||
        args.path.length > 8192 ||
        /[\0\r\n]/.test(args.path)
      )
        throw Error("无效控件路径");
      clipboard.writeText(args.path);
      return true;
    }
    case "debug.functions.discover":
      return debuggerService.functions.discover(args.projectId);
    case "debug.functions.list":
      return debuggerService.functions.list(args.projectId);
    case "debug.functions.save":
      return debuggerService.functions.save(args.projectId, args.function);
    case "debug.functions.delete":
      return debuggerService.functions.save(args.projectId, undefined, args.id);
    case "debug.functions.invoke":
      return debuggerService.invoke(args);
    case "debug.profile.start":
      return debuggerService.startProfile(args);
    case "debug.profile.stop":
      await debuggerService.collect(args.id, args.collectGarbage === true);
      return debuggerService.snapshot();
    case "debug.profile.cancel":
      return debuggerService.cancel(args.id);
    case "debug.reports.folder": {
      await fs.mkdir(debuggerService.reportDirectory, { recursive: true });
      const error = await shell.openPath(debuggerService.reportDirectory);
      if (error) throw Error(error);
      return true;
    }
    case "debug.export": {
      const record = debuggerService.profiles.get(args.id);
      if (!record?.result) throw Error("没有可导出的报告");
      if (!["json", "trace"].includes(args.kind))
        throw Error("不支持的报告格式");
      const trace = args.kind === "trace";
      if (trace && !record.traceFile) throw Error("此报告没有 Tracy 数据文件");
      const result = await dialog.showSaveDialog(win, {
        title: "导出采样报告",
        defaultPath: record.kind + "-profile." + (trace ? "tracy" : "json"),
        filters: [
          {
            name: trace ? "Tracy" : "JSON",
            extensions: [trace ? "tracy" : "json"],
          },
        ],
      });
      if (result.canceled || !result.filePath) return false;
      if (
        normalize(result.filePath).startsWith(
          normalize(debuggerService.reportDirectory) + path.sep,
        )
      )
        throw Error("请导出到报告目录以外的位置");
      if (trace) await fs.copyFile(record.traceFile, result.filePath);
      else
        await fs.writeFile(
          result.filePath,
          JSON.stringify(record, null, 2),
          "utf8",
        );
      return true;
    }
    case "debug.source": {
      const snapshot = await store.readProject(args.projectId);
      if (
        !snapshot.config ||
        typeof args.file !== "string" ||
        args.file.startsWith("\\\\")
      )
        throw Error("源文件不可用");
      const file = await locateSource(sourceRoots(snapshot), args.file);
      shell.showItemInFolder(file);
      return true;
    }
    case "settings.update": {
      const result = await store.updateSettings(args);
      if (Object.hasOwn(args, "AutomationEnabled"))
        await automation.setEnabled(result.settings.AutomationEnabled);
      settingsChanged();
      return result.settings;
    }
    case "update.state":
      return updateService.snapshot();
    case "update.auth.state":
      return updateService.authState();
    case "update.auth.begin": {
      const state = await updateService.authorize();
      if (state.verificationUri) await shell.openExternal(state.verificationUri);
      return state;
    }
    case "update.auth.logout":
      await updateService.clearAuth();
      return updateService.snapshot();
    case "update.check":
      return updateService.check({ automatic: args.automatic === true });
    case "update.history":
      return updateService.loadMoreHistory();
    case "update.download":
      return updateService.download();
    case "update.install":
      return updateService.install();
    case "update.open-release": {
      const url = updateService.releaseUrl(args.tag);
      await shell.openExternal(url);
      return true;
    }
    case "automation.status":
      return automation.status();
    case "automation.copy-config": {
      const config = {
        mcpServers: {
          daguoneko_toolbox: {
            command: "node",
            args: [
              path.join(dataRoot, "mcp/server.cjs"),
              "--data-dir",
              dataRoot,
            ],
          },
        },
      };
      clipboard.writeText(JSON.stringify(config, null, 2));
      return true;
    }
    case "game-options.read":
      return gameOptions.snapshot();
    case "game-options.save":
      return gameOptions.save(args.revision, args.overrides);
    case "game-options.folder": {
      if (args.backups === true) {
        await fs.mkdir(gameOptions.backups, { recursive: true });
        const error = await shell.openPath(gameOptions.backups);
        if (error) throw Error(error);
      } else {
        await fs.access(gameOptions.optionsFile);
        shell.showItemInFolder(gameOptions.optionsFile);
      }
      return true;
    }
    case "projects.add": {
      if (args.root && !approvedDirectories.has(normalize(args.root)))
        throw Error("请先选择或拖入项目目录");
      const result = args.root
        ? { canceled: false, filePaths: [args.root] }
        : await dialog.showOpenDialog(win, {
            title: "选择模组或地图项目目录",
            properties: ["openDirectory"],
          });
      if (result.canceled || !result.filePaths.length)
        return { canceled: true };
      const next = await store.addProject(result.filePaths[0]);
      const project = next.projects.find(
        (p) => normalize(p.root) === normalize(result.filePaths[0]),
      );
      return { projects: next.projects, project };
    }
    case "projects.remove": {
      if (store.projectQueues.has(args.id))
        throw Error("正在保存项目，请稍后操作");
      if (
        launcher.starting ||
        (launcher.session?.running && launcher.session.projectId === args.id)
      )
        throw Error("请先结束此项目的运行会话");
      return (await store.removeProject(args.id)).projects;
    }
    case "projects.relocate": {
      if (store.projectQueues.has(args.id))
        throw Error("正在保存项目，请稍后操作");
      store.project(args.id);
      if (
        launcher.starting ||
        (launcher.session?.running && launcher.session.projectId === args.id)
      )
        throw Error("请先结束此项目的运行会话");
      const result = await dialog.showOpenDialog(win, {
        title: "重新定位项目目录",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths.length)
        return { canceled: true };
      return {
        projects: (await store.relocateProject(args.id, result.filePaths[0]))
          .projects,
      };
    }
    case "project.backup":
      return store.readBackup(args.id);
    case "games.discover": {
      const known = store.value.settings.GamePath
        ? [store.value.settings.GamePath]
        : [];
      for (const project of store.value.projects) {
        const snapshot = await store.readProject(project.id);
        if (snapshot.config?.game_executable_path)
          known.push(
            path.resolve(
              project.baseDirectory || project.root,
              snapshot.config.game_executable_path,
            ),
          );
      }
      const result = await discoverGames({ known });
      for (const game of result.games) {
        try {
          const engine = await inspectEngine(game.path);
          Object.assign(game, {
            engineVersion: engine.version,
            engineProfile: engine.profile,
          });
        } catch (error) {
          Object.assign(game, {
            engineVersion: null,
            engineProfile: null,
            engineError: error.message,
          });
        }
      }
      return result;
    }
    case "games.inspect": {
      if (typeof args.path !== "string" || !/\.exe$/i.test(args.path))
        throw Error("请选择游戏 EXE");
      return inspectEngine(args.path);
    }
    case "games.supported":
      return profilesForDiscovery();
    case "project.read":
      return profiles.read(args.id);
    case "project.save": {
      if (launcher.starting) throw Error("正在准备启动，请稍后保存配置");
      return profiles.save(args.id, args.revision, args.patch, args.raw);
    }
    case "profiles.create":
      return profiles.create(args.name, args.copyId);
    case "profiles.rename":
      return profiles.rename(args.id, args.name);
    case "profiles.remove":
      if (launcher.profileRunning(args.id) || launcher.starting)
        throw Error("该配置仍有游戏在运行，请先停止对应会话");
      return profiles.remove(args.id);
    case "profiles.list":
      return store.value.projects;
    case "mods.list":
      return modLibrary.list();
    case "mods.folder": {
      const directory = await modLibrary.folder(args);
      const error = await shell.openPath(directory);
      if (error) throw Error(error);
      return true;
    }
    case "mods.save":
      return modLibrary.save(args);
    case "mods.remove":
      return modLibrary.remove(args.id, args.revision);
    case "mods.import-profiles":
      return modLibrary.importProfiles(args.revision);
    case "mods.add-directories":
      return modLibrary.addDirectories(args.directories, args.revision);
    case "world-actions.read":
      return {
        ...(await worldActions.config(args.worldId)),
        runtime: worldActions.status(args.worldId),
      };
    case "world-actions.state":
      return worldActions.status(args.worldId);
    case "world-actions.save":
      return worldActions.save(args);
    case "world-actions.run":
      return worldActions.run(args);
    case "world-actions.cancel":
      return worldActions.cancel(args.sessionId);
    case "architecture.state":
      return architectureImport.state();
    case "architecture.prepare":
      if (!approvedDirectories.has(normalize(args.source)) &&
          !approvedWorldArchives.has(normalize(args.source)))
        throw Error("请先选择或拖入来源世界");
      if (args.kind === "java" && !approvedDirectories.has(normalize(args.chunkerJar)))
        throw Error("请先选择 Chunker CLI JAR");
      return architectureImport.call("prepare", args);
    case "architecture.start-source":
      return architectureImport.call("startSource", args);
    case "architecture.save-source":
      return architectureImport.call("sourceSave", args);
    case "architecture.source-done":
      return architectureImport.call("sourceDone", args);
    case "architecture.start-target":
      return architectureImport.call("startTarget", args);
    case "architecture.position":
      return architectureImport.call("position", args);
    case "architecture.preview":
      return architectureImport.call("preview", args);
    case "architecture.paste":
      return architectureImport.call("targetPaste", args);
    case "architecture.revoke":
      return architectureImport.call("revoke", args);
    case "architecture.stop":
      return architectureImport.stop(args);
    case "architecture.folder": {
      await architectureImport.require(args);
      const error = await shell.openPath(architectureImport.directory());
      if (error) throw Error(error);
      return true;
    }
    case "architecture.pick-chunker": {
      const result = await dialog.showOpenDialog(win, {
        title: "选择 Chunker CLI JAR",
        filters: filters["chunker-jar"],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths.length) return null;
      approvedDirectories.add(normalize(result.filePaths[0]));
      return result.filePaths[0];
    }
    case "worlds.update":
      if (launcher.starting) throw Error("正在准备启动，请稍后修改存档设置");
      return worlds.update(args.worldId, args);
    case "worlds.import": {
      if (
        typeof args.source !== "string" ||
        (!approvedDirectories.has(normalize(args.source)) &&
          !approvedWorldArchives.has(normalize(args.source)))
      )
        throw Error("请先选择或拖入存档文件夹/ZIP");
      return worlds.importWorld(
        args.profileId,
        args.name,
        args.source,
        args.mode,
      );
    }
    case "worlds.pick-import": {
      const archive = args.kind === "zip";
      const result = await dialog.showOpenDialog(win, {
        title: archive ? "选择基岩世界 ZIP / MCWORLD" : "选择要使用的存档目录",
        defaultPath: worlds.worldsRoot,
        properties: [archive ? "openFile" : "openDirectory"],
        ...(archive
          ? { filters: [{ name: "基岩世界", extensions: ["zip", "mcworld"] }] }
          : {}),
      });
      if (result.canceled) return null;
      (archive ? approvedWorldArchives : approvedDirectories).add(
        normalize(result.filePaths[0]),
      );
      return result.filePaths[0];
    }
    case "project.open-folder": {
      const error = await shell.openPath(store.project(args.id).root);
      if (error) throw Error(error);
      return true;
    }
    case "files.pick": {
      if (!filters[args.kind]) throw Error("不支持的文件类型");
      const result = await dialog.showOpenDialog(win, {
        title: "选择文件",
        filters: filters[args.kind],
        properties: ["openFile"],
      });
      if (result.canceled) return [];
      if (args.kind === "background")
        for (const file of result.filePaths)
          approvedImages.add(normalize(file));
      return result.filePaths;
    }
    case "files.directory": {
      const result = await dialog.showOpenDialog(win, {
        title: "选择目录",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths.length) return null;
      approvedDirectories.add(normalize(result.filePaths[0]));
      return result.filePaths[0];
    }
    case "image.read": {
      if (
        typeof args.path !== "string" ||
        !approvedImages.has(normalize(args.path))
      )
        throw Error("背景图片尚未选择");
      const types = {
        ".png": "png",
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".bmp": "bmp",
        ".webp": "webp",
        ".gif": "gif",
      };
      const type = types[path.extname(args.path).toLowerCase()];
      if (!type || (await fs.stat(args.path)).size > 20 * 1024 * 1024)
        throw Error("背景图片格式不支持或超过 20 MB");
      return (
        `data:image/${type};base64,` +
        (await fs.readFile(args.path)).toString("base64")
      );
    }
    case "launch.start":
      return launcher.start(args.profileId || args.id, args.worldId || null);
    case "launch.quick":
      return launcher.start(null, args.worldId, null, {
        quickTest: { modIds: args.modIds, revision: args.revision },
      });
    case "launch.blank":
      return launcher.startBlank(args.userName);
    case "launch.hosts":
      return clientJoiner.hosts();
    case "launch.joined":
      return { sessionId: await clientJoiner.launch(args.hostSessionId, args.playerName) };
    case "launch.select":
      return launcher.select(args.sessionId);
    case "launch.remove":
      return launcher.remove(args.sessionId);
    case "worlds.list":
      return worlds.list(args.projectId);
    case "worlds.create":
      return worlds.create(args.projectId, args);
    case "worlds.rename":
      return worlds.rename(args.projectId, args.worldId, args.name);
    case "worlds.select":
      return worlds.select(
        args.projectId,
        args.worldId,
        args.revision,
        args.confirmedResetDisabled === true,
      );
    case "worlds.copy":
      return worlds.copyCurrent(args.projectId, args.name, args.revision);
    case "worlds.recycle":
      return worlds.recycle(
        args.projectId,
        args.worldId,
        args.confirmed === true,
      );
    case "worlds.restore":
      return worlds.restore(args.projectId, args.worldId);
    case "worlds.purge":
      return worlds.purge(args.worldIds, args.confirmed);
    case "worlds.folder": {
      const dir = await worlds.run(() =>
        worlds.openPath(args.projectId, args.worldId),
      );
      const error = await shell.openPath(dir);
      if (error) throw Error(error);
      return true;
    }
    case "launch.stop":
      return launcher.stop(args.sessionId);
    case "launch.state":
      return launcher.state();
    case "logs.clear":
      launcher.historyArchive(args.channel);
      if (args.channel === "game") {
        launcher.gameLogs.clear(launcher.session?.id);
        return launcher.gameLogs.snapshot(launcher.session?.id, args.level);
      }
      return launcher.clearLogs();
    case "logs.gameState":
      return launcher.gameLogs.snapshot(args.sessionId, args.level);
    case "logs.gameFolder": {
      const directory =
        launcher.gameLogs.records.get(launcher.session?.id)?.directory ||
        launcher.gameLogs.directory;
      if (!(await fs.stat(directory)).isDirectory())
        throw Error("游戏原始日志目录尚未生成");
      const error = await shell.openPath(directory);
      if (error) throw Error(error);
      return true;
    }
    case "logs.history":
      return launcher.history.list(args.channel);
    case "logs.read":
      return launcher.history.read(args.id, args.channel);
    case "logs.query":
      return launcher.history.query(args.id, args.channel, {
        query: args.query,
        level: args.level,
        caseSensitive: args.caseSensitive,
        before: args.before,
      });
    case "logs.deletePreview":
      return launcher.previewHistoryDeletion(args.id, args.channel);
    case "logs.delete":
      return launcher.deleteHistory(args.ids, args.confirmed, args.channel);
    case "logs.folder": {
      const directory = launcher.historyArchive(args.channel).directory;
      await fs.mkdir(directory, { recursive: true });
      const error = await shell.openPath(directory);
      if (error) throw Error(error);
      return true;
    }
    case "logs.source": {
      const entries = args.historyId
        ? []
        : args.channel === "game"
          ? launcher.gameLogs.snapshot(launcher.session?.id, args.level).logs
          : launcher.logs;
      const entry = args.historyId
        ? await launcher.history.entry(
            args.historyId,
            args.channel,
            args.entryId,
          )
        : entries.find((line) => line.id === args.entryId);
      if (!entry) throw Error("该日志已经移出显示范围");
      const match =
        /File "([^"]+)", line (\d+)/.exec(entry.text) ||
        /([A-Za-z]:[\\/].+?\.(?:py|json))(?::(\d+))?/.exec(entry.text);
      if (!match || match[1].startsWith("\\\\"))
        throw Error("该日志没有可定位的本地源文件");
      const projectId = args.historyId
        ? (await launcher.history.list(args.channel)).find(
            (item) => item.id === args.historyId,
          )?.projectId
        : launcher.session?.projectId;
      const snapshot =
        !args.historyId && launcher.current?.sourceSnapshot
          ? launcher.current.sourceSnapshot
          : await store.readProject(projectId);
      if (!snapshot.config) throw Error(snapshot.error);
      const target = await locateSource(sourceRoots(snapshot), match[1]);
      shell.showItemInFolder(target);
      return { file: target, line: Number(match[2]) || null };
    }
    case "logs.export": {
      const result = await dialog.showSaveDialog(win, {
        title: "导出运行日志",
        defaultPath:
          args.channel === "game" ? "game-debug.log" : "game-session.log",
        filters: [{ name: "日志文件", extensions: ["log", "txt"] }],
      });
      if (result.canceled || !result.filePath) return false;
      const id = args.id || launcher.session?.id;
      if (id) await launcher.history.export(id, result.filePath, args.channel);
      else
        await fs.writeFile(
          result.filePath,
          launcher.logs.map(formatLine).join(""),
          "utf8",
        );
      return true;
    }
    case "web.open": {
      const urls = {
        upstream: "https://github.com/GitHub-Zero123/MCDevTool",
        extension: "https://github.com/Dofes/mcdev-tools",
        chunker: "https://github.com/HiveGamesOSS/Chunker/releases",
      };
      if (!Object.hasOwn(urls, args.kind)) throw Error("不支持的链接");
      await shell.openExternal(urls[args.kind]);
      return true;
    }
    case "window.state":
      return { maximized: source.isMaximized() };
    case "window.dirty": {
      if (typeof args.dirty !== "boolean") throw Error("无效编辑状态");
      if (source === inspectorWindow.window) inspectorWindow.dirty = args.dirty;
      else dirty = args.dirty;
      return true;
    }
    case "window.control": {
      if (args.action === "minimize") source.minimize();
      else if (args.action === "maximize")
        source.isMaximized() ? source.unmaximize() : source.maximize();
      else if (args.action === "close") source.close();
      else throw Error("不支持的窗口操作");
      return true;
    }
    case "window.confirm-close": {
      if (!["cancel", "exit"].includes(args.action))
        throw Error("不支持的退出操作");
      if (!closeRequested) return false;
      if (args.action === "exit") {
        if (launcher.starting) throw Error("正在准备启动，请稍后再退出");
        await architectureImport.dispose();
        await worldActions.dispose();
        await rooms.shutdown();
        await clientJoiner.shutdown();
        await tracyProfiler.dispose();
        await launcher.shutdown();
        await debuggerService.dispose();
        inspectorWindow.destroy();
        closing = true;
      }
      closeRequested = false;
      if (closing) setImmediate(() => win.close());
      return true;
    }
    default:
      throw Error("不支持的操作");
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      await store.load();
      await profiles.initialize();
      settingsChanged();
      const runtimeRoot = path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        "runtime",
      );
      debuggerService = new DebugController(store, runtimeRoot);
      tracyProfiler = new TracyProfiler(dataRoot, runtimeRoot, debuggerService);
      debuggerService.nativeViewerGuard = async (session, port) => {
        const view = tracyProfiler.snapshot();
        if (
          tracyProfiler.pendingGamePid === session.minecraftPid ||
          (view.pid && view.target?.gamePid === session.minecraftPid)
        )
          throw Error(
            "请先保存并关闭该游戏的官方 Tracy 窗口，再进行 Native 采样",
          );
        await assertPortFree(session.minecraftPid, port);
      };
      tracyProfiler.on("state", (value) => {
        if (win && !win.isDestroyed())
          win.webContents.send("tracy-state", value);
      });
      editorEngine = new EditorEngine(dataRoot, runtimeRoot, uiDocuments);
      editorEngine.on("state", (value) => {
        if (win && !win.isDestroyed())
          win.webContents.send("ui-editor-preview", { type: "state", value });
      });
      editorEngine.on("selection", (value) => {
        if (win && !win.isDestroyed())
          win.webContents.send("ui-editor-preview", {
            type: "selection",
            value,
          });
      });
      editorEngine.on("tree", (value) => {
        if (win && !win.isDestroyed())
          win.webContents.send("ui-editor-preview", { type: "tree", value });
      });
      worlds = new WorldLibrary(
        store,
        process.env.DGN_GAME_DATA_DIR
          ? path.join(
              dataRoot,
              "game-data",
              "MinecraftPE_Netease",
              "minecraftWorlds",
            )
          : path.join(
              process.env.APPDATA,
              "MinecraftPE_Netease",
              "minecraftWorlds",
            ),
        {
          createImportProfile: (name) =>
            profiles.create(name.slice(0, 68) + "（自动匹配）"),
          appDataOverride: process.env.DGN_GAME_DATA_DIR
            ? path.join(dataRoot, "game-data")
            : null,
          busy: () =>
            !!(
              launcher?.hasRunning ||
              launcher?.starting ||
              launcher?.stopping
            ),
          mutationGuard: (ids) =>
            assertWorldMutation(
              launcher,
              process.env.DGN_GAME_DATA_DIR
                ? { conflicts: async () => [] }
                : gameProcesses,
              ids,
            ),
          gameRunning: async () => {
            if (process.env.DGN_GAME_DATA_DIR) return false;
            return gameProcesses.any();
          },
        },
      );
      await worlds.migrateProfiles();
      launcher = new Sessions(
        store,
        path.join(
          app.isPackaged ? process.resourcesPath : app.getAppPath(),
          "runtime",
          "mcdk.exe",
        ),
        {
          bridge: debuggerService,
          worlds,
          profiles,
          gameOptions,
          modLibrary,
          isolation: new HostIsolation(runtimeRoot, worlds, gameOptions),
          menuName: new MenuName(runtimeRoot),
          detectPids: (file) => gameProcesses.pids(file),
        },
      );
      worldActions = new WorldActions(launcher, debuggerService, worlds);
      architectureImport = new ArchitectureImport({
        dataRoot,
        worlds,
        profiles,
        sessions: launcher,
        actions: worldActions,
        debug: debuggerService,
      });
      reloadSources = new ReloadSources(launcher, debuggerService);
      debuggerService.beforeReload = (context) => reloadSources.check(context);
      if (process.platform === "win32")
        gameTitles = new GameTitles(launcher, debuggerService, runtimeRoot);
      clientJoiner = new ClientJoiner(launcher, debuggerService, runtimeRoot);
      rooms = new Rooms(
        {
          sessions: launcher,
          debug: debuggerService,
          profiles,
          worlds,
          runtime: runtimeRoot,
          dataRoot,
        },
        { protection: safeStorage },
      );
      launcher.gameLogs = new GameLogs({
        directory: path.join(
          process.env.DGN_GAME_DATA_DIR
            ? path.join(dataRoot, "game-data")
            : process.env.APPDATA,
          "MinecraftPE_Netease",
          "logs",
        ),
        archiveDirectory: path.join(dataRoot, "logs", "game"),
        runtime: runtimeRoot,
        workers: () => launcher.workers,
        identity: (worker) => {
          const b = debuggerService
            .snapshot()
            .sessions.find(
              (s) =>
                s.connected &&
                s.registrationId === worker.session.bridgeRegistrationId &&
                s.mcdkPid === worker.session.pid,
            );
          return b?.minecraftPid
            ? { pid: b.minecraftPid, registration: b.registrationId }
            : null;
        },
      });
      automation = new AutomationBridge(
        dataRoot,
        new AutomationRouter({
          sessions: launcher,
          debug: debuggerService,
          worlds,
          store,
          joiner: clientJoiner,
        }),
      );
      await installAutomation(
        dataRoot,
        path.join(__dirname, "toolbox-mcp.cjs"),
        process.execPath,
        app.isPackaged ? [] : [app.getAppPath()],
      );
      await automation.setEnabled(store.value.settings.AutomationEnabled);
      const send = (name, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(name, data);
        const child = inspectorWindow?.window;
        if (name === "debug-state" && child && !child.isDestroyed())
          child.webContents.send(name, data);
      };
      let updateConfig;
      try {
        updateConfig = JSON.parse(
          await fs.readFile(path.join(runtimeRoot, "update-config.json"), "utf8"),
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      updateService = new UpdateService({
        currentVersion: app.getVersion(),
        dataRoot,
        runtimeRoot,
        appDirectory: path.dirname(process.execPath),
        executablePath: process.execPath,
        isPackaged: app.isPackaged,
        protection: safeStorage,
        config: updateConfig,
        // 使用 Electron 网络栈，沿用系统代理，避免浏览器能访问而更新请求直连失败。
        fetchImpl: createUpdateFetch(net),
        canInstall: async () => {
          if (launcher?.hasRunning || launcher?.starting || launcher?.stopping)
            return { ok: false, reason: "请先停止运行中的游戏会话" };
          if (rooms?.room) return { ok: false, reason: "请先关闭联机房间" };
          if (dirty || inspectorWindow?.dirty)
            return { ok: false, reason: "请先保存或关闭未保存的修改" };
          if (closing) return { ok: false, reason: "工具箱正在退出" };
          return { ok: true };
        },
        requestQuit: () => app.quit(),
      });
      updateService.on("state", (value) => send("update-state", value));
      debuggerService.on("state", (value) => {
        for (const game of value.sessions) launcher.recordExit(game);
        send("debug-state", value);
      });
      debuggerService.on(
        "embedded-reload",
        ({ registrationId, result, error }) => {
          const worker = launcher.workers.find(
            (w) =>
              w.session?.running &&
              w.session.bridgeRegistrationId === registrationId,
          );
          if (worker && (error || result?.updated))
            worker.log(
              error ? "stderr" : "system",
              error || `自带模组已自动热更新 ${result.updated} 个脚本模块`,
            );
        },
      );
      let pendingLogs = [],
        logTimer;
      launcher.on("state", (value) => {
        clearTimeout(logTimer);
        logTimer = null;
        pendingLogs = [];
        send("session-state", value);
      });
      launcher.on("log", (value) => {
        pendingLogs.push(value);
        if (pendingLogs.length > 2000)
          pendingLogs.splice(0, pendingLogs.length - 2000);
        if (!logTimer)
          logTimer = setTimeout(() => {
            send("session-logs", { ...launcher.state(), logs: pendingLogs });
            pendingLogs = [];
            logTimer = null;
          }, 100);
      });
      protocol.handle("app", (request) => {
        const url = new URL(request.url),
          file = url.pathname.slice(1) || "index.html";
        if (
          url.host !== "game-toolkit" ||
          !["index.html", "app.js", "app.css"].includes(file)
        )
          return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(path.join(__dirname, file)).toString());
      });
      session.defaultSession.setPermissionRequestHandler((_, __, callback) =>
        callback(false),
      );
      ipcMain.handle("request", async (event, method, args = {}) => {
        const source = BrowserWindow.fromWebContents(event.sender);
        if (
          !source ||
          (source !== win && source !== inspectorWindow?.window) ||
          event.senderFrame !== source.webContents.mainFrame ||
          !event.senderFrame.url.startsWith("app://game-toolkit/")
        )
          throw Error("非法调用来源");
        try {
          if (source !== win && !inspectorMethods.has(method))
            throw Error("独立调试窗口不支持此操作");
          return { ok: true, result: await dispatch(method, args, source) };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      });
      ipcMain.handle("dropped-files", async (event, files) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame ||
          !event.senderFrame.url.startsWith("app://game-toolkit/")
        )
          throw Error("非法调用来源");
        if (
          !Array.isArray(files) ||
          !files.length ||
          files.length > 200 ||
          files.some(
            (file) => typeof file !== "string" || !path.isAbsolute(file),
          )
        )
          throw Error("请拖入文件或目录，最多 200 项");
        const result = [];
        for (const file of files) {
          const stat = await fs.stat(file);
          if (stat.isDirectory()) approvedDirectories.add(normalize(file));
          else if (stat.isFile() && /\.(zip|mcworld)$/i.test(file))
            approvedWorldArchives.add(normalize(file));
          else if (stat.isFile() && /\.(png|jpe?g|webp|bmp|gif)$/i.test(file))
            approvedImages.add(normalize(file));
          else if (!stat.isFile()) throw Error("不支持此文件类型");
          result.push({ path: file, directory: stat.isDirectory() });
        }
        return result;
      });
      win = new BrowserWindow({
        title: "大果喵游戏工具箱",
        width: 1240,
        height: 820,
        minWidth: 900,
        minHeight: 650,
        show: false,
        frame: false,
        autoHideMenuBar: true,
        icon: path.join(__dirname, "icon.ico"),
        backgroundColor: nativeTheme.shouldUseDarkColors
          ? "#191919"
          : "#ffffff",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      inspectorWindow = new InspectorWindow(
        win,
        debuggerService,
        __dirname,
        () => (nativeTheme.shouldUseDarkColors ? "#191919" : "#ffffff"),
      );
      win.on("closed", () => inspectorWindow.destroy());
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      const windowState = () =>
        send("window-state", { maximized: win.isMaximized() });
      win.on("maximize", windowState);
      win.on("unmaximize", windowState);
      win.on("close", (event) => {
        if (
          closing ||
          (!launcher.hasRunning &&
            !launcher.starting &&
            !rooms.room &&
            !dirty &&
            !inspectorWindow.dirty) ||
          process.env.DGN_GAME_HEADLESS
        ) {
          tracyProfiler.prepareExit();
          return;
        }
        event.preventDefault();
        closeRequested = true;
        send("close-requested", {
          busy: launcher.hasRunning || launcher.starting || !!rooms.room,
          dirty: dirty || inspectorWindow.dirty,
        });
      });
      win.once("ready-to-show", () => {
        if (!process.env.DGN_GAME_HEADLESS) win.show();
      });
      nativeTheme.on("updated", emitTheme);
      await win.loadURL("app://game-toolkit/index.html");
    })
    .catch((error) => {
      dialog.showErrorBox("启动失败", error.message);
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (process.env.DGN_GAME_HEADLESS) inspectorWindow?.destroy();
  });
  app.on("will-quit", (event) => {
    if (!closing && launcher) {
      event.preventDefault();
      Promise.resolve(automation?.setEnabled(false))
        .then(() => architectureImport?.dispose())
        .then(() => worldActions?.dispose())
        .then(() => gameTitles?.dispose())
        .then(() => rooms?.shutdown())
        .then(() => clientJoiner.shutdown())
        .then(() => modLibrary.queue)
        .then(() => uiDocuments.queue)
        .then(() => editorEngine.stop())
        .then(() => tracyProfiler.dispose())
        .then(() => gameOptions.queue)
        .then(() => launcher.shutdown())
        .then(() => debuggerService.dispose())
        .then(() => {
          closing = true;
          // Do not re-enter Electron's quit sequence from its own microtask.
          setImmediate(() => app.quit());
        })
        .catch((error) =>
          dialog.showErrorBox(
            "无法结束游戏会话",
            error.message + "\n请保存游戏并手动退出后，再关闭工具箱。",
          ),
        );
    }
  });
}
