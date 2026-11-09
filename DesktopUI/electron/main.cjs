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
const { MapPreviewJobs } = require("./domains/worlds/map-preview-jobs.cjs");
let mapPreviewJobs;
let worldDataJobs;
const worldDataResults = new Map();
const { WorldDataStore } = require("./domains/worlds/world-data-store.cjs");
let worldDataStore;
const { WorldDataEdits } = require("./domains/worlds/world-data-edit.cjs");
const { reserveIsolation } = require("./isolation-spawn.cjs");
let worldDataEdits, worldDataWriteBusy = false, worldDataDirty = false;
const worldDataDrafts = new Set();
const { GameTitles } = require("./domains/game/game-titles.cjs");
let gameTitles;
const { Profiles } = require("./domains/profiles/profiles.cjs");
const { Sessions } = require("./sessions.cjs");
const { ReloadSources } = require("./domains/reload/reload-sources.cjs");
let reloadSources;
const { HostIsolation } = require("./host-isolation.cjs");
const { MenuName } = require("./domains/client/menu-name.cjs");
const { AutomationRouter } = require("./domains/automation/automation-router.cjs");
const { captureWindow } = require("./domains/automation/automation-observation.cjs");
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
const { ActivityCenter } = require("./activity-center.cjs");
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
const activityCenter = new ActivityCenter(dataRoot);
const reportBackgroundError = ({ method = "background", message }) => {
  activityCenter.event({ method, level: "error", source: "background", message: String(message || "后台操作失败").slice(0, 2000) });
};
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
const { ContentIndex } = require("./domains/profiles/content-index.cjs");
const contentIndex = new ContentIndex(modLibrary);
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
const { FileSelections } = require("./file-selection.cjs");
const fileSelections = new FileSelections();
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
async function settingsChanged() {
  nativeTheme.themeSource = { System: "system", Light: "light", Dark: "dark" }[
    store.value.settings.AppearanceMode
  ];
  await fileSelections.setSavedImage(store.value.settings.BgImagePath);
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
        activity: activityCenter.snapshot(),
      };
    case "activity.snapshot":
      return activityCenter.snapshot(args);
    case "activity.clear":
      return activityCenter.clear();
    case "activity.export": {
      const result = await dialog.showSaveDialog(win, {
        title: "导出项目日志",
        defaultPath: "project-activity.log",
        filters: [{ name: "日志文件", extensions: ["log", "txt"] }],
      });
      if (result.canceled || !result.filePath) return false;
      return activityCenter.export(result.filePath, args);
    }
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
      if(args.BgImagePath && args.BgImagePath!==store.value.settings.BgImagePath) await fileSelections.require(args.BgImagePath,"image");
      const result = await store.updateSettings(args);
      if (Object.hasOwn(args, "AutomationEnabled"))
        await automation.setEnabled(result.settings.AutomationEnabled);
      await settingsChanged();
      return result.settings;
    }
    case "update.state":
      return updateService.snapshot();
    case "update.check":
      return updateService.check();
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
      if (args.root) await fileSelections.require(args.root,"directory");
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
      const roots = Array.isArray(args.roots) ? args.roots : undefined;
      if (roots)
        for (const root of roots) await fileSelections.require(root, "directory");
      const known = roots?.length
        ? []
        : store.value.settings.GamePath
          ? [store.value.settings.GamePath]
          : [];
      if (!roots?.length)
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
      const result = await discoverGames({
        known,
        ...(roots?.length ? { roots } : {}),
      });
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
    case "content.scan": {
      if (!args.worldId) return contentIndex.scan();
      const record = worlds.find(await worlds.read(), null, args.worldId);
      const info = await worlds.inspect(record);
      if (info.deleted || !info.ready || !info.present) throw Error("存档尚未生成或已移除");
      return contentIndex.scan({ root: info.path, packId: args.packId, sourceId: record.id, sourceName: record.name });
    }
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
    case "architecture.prepare": {
      if (args.sourceWorldId) {
        const world = worlds.find(await worlds.read(), null, args.sourceWorldId);
        const info = await worlds.inspect(world);
        if (info.deleted || !info.ready || !info.present) throw Error("来源存档不可用，请重新选择");
        args = { ...args, source: info.path, kind: "bedrock" };
      } else await fileSelections.require(args.source,["directory","archive"]);
      if(args.kind==="java") await fileSelections.require(args.chunkerJar,"chunker");
      return architectureImport.call("prepare", args);
    }
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
      await fileSelections.allow(result.filePaths[0],"chunker");
      return result.filePaths[0];
    }
    case "worlds.update":
      if (launcher.starting) throw Error("正在准备启动，请稍后修改存档设置");
      return worlds.update(args.worldId, args);
    case "worlds.import": {
      await fileSelections.require(args.source,["directory","archive"]);
      if (args.background === true)
        return activityCenter.background("worlds.import", ({ update }) => worlds.importWorld(
          args.profileId, args.name, args.source, args.mode, undefined, { parallel: true, onProgress: update },
        ), { projectId: args.profileId, source: "ui", message: "等待导入任务开始" });
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
      await fileSelections.allow(result.filePaths[0],archive?"archive":"directory");
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
          await fileSelections.allow(file,"image");
      return result.filePaths;
    }
    case "files.directory": {
      const result = await dialog.showOpenDialog(win, {
        title: "选择目录",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths.length) return null;
      await fileSelections.allow(result.filePaths[0],"directory");
      return result.filePaths[0];
    }
    case "image.read": {
      if(typeof args.path!=="string") throw Error("背景图片尚未选择");
      const types = {
        ".png": "png",
        ".jpg": "jpeg",
        ".jpeg": "jpeg",
        ".bmp": "bmp",
        ".webp": "webp",
        ".gif": "gif",
      };
      const type = types[path.extname(args.path).toLowerCase()];
      if (!type)
        throw Error("背景图片格式不支持或超过 20 MB");
      return (
        `data:image/${type};base64,` +
        (await fileSelections.readImage(args.path)).toString("base64")
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
      return worlds.list(args.projectId, args.includePackChecks === true);
    case "worlds.sync-pack-versions":
      return worlds.syncPackVersions(args.worldId, args.confirmed === true, args.revision);
    case "worlds.inspect-pack-health":
      return worlds.inspectPackHealth(args.worldId);
    case "worlds.rebind-pack-uuids":
      return worlds.rebindPackUuids(
        args.worldId,
        args.packId,
        args.confirmed === true,
        args.revision,
      );
    case "worlds.edit-pack":
      return worlds.editPack(
        args.worldId,
        args.packId,
        args.values,
        args.confirmed === true,
        args.revision,
      );
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
      if (args.background === true)
        return activityCenter.background("worlds.recycle", ({ update }) => worlds.recycle(
          args.projectId, args.worldId, args.confirmed === true, { parallel: true },
        ), { projectId: args.projectId, message: "等待删除任务开始" });
      return worlds.recycle(
        args.projectId,
        args.worldId,
        args.confirmed === true,
      );
    case "worlds.restore":
      if (args.background === true)
        return activityCenter.background("worlds.restore", ({ update }) => worlds.restore(
          args.projectId, args.worldId, { parallel: true },
        ), { projectId: args.projectId, message: "等待恢复任务开始" });
      return worlds.restore(args.projectId, args.worldId);
    case "worlds.purge":
      if (args.background === true)
        return activityCenter.background("worlds.purge", () => worlds.purgeParallel(args.worldIds, args.confirmed), { message: "等待永久删除任务开始" });
      return worlds.purge(args.worldIds, args.confirmed);
    case "worlds.folder": {
      const dir = await worlds.run(() =>
        worlds.openPath(args.projectId, args.worldId),
      );
      const error = await shell.openPath(dir);
      if (error) throw Error(error);
      return true;
    }
    case "map-preview.pick": {
      if (!["folder", "archive"].includes(args.kind)) throw Error("请选择文件夹或 ZIP / MCWORLD");
      const archive = args.kind === "archive";
      // Windows 原生对话框同时传入两种模式时只允许选目录。
      const result = await dialog.showOpenDialog(win, {
        title: "选择要预览的 Minecraft 存档",
        defaultPath: worlds.worldsRoot,
        properties: [archive ? "openFile" : "openDirectory"],
        ...(archive ? { filters: [{ name: "Minecraft 世界", extensions: ["zip", "mcworld"] }] } : {}),
      });
      if (result.canceled || !result.filePaths.length) return null;
      const selected = result.filePaths[0], stat = await fs.stat(selected);
      if (archive ? !stat.isFile() || !/\.(zip|mcworld)$/i.test(selected) : !stat.isDirectory()) throw Error("请选择存档文件夹或 ZIP / MCWORLD");
      await fileSelections.allow(selected,stat.isDirectory()?"directory":"archive");
      return selected;
    }
    case "world-data.scan": {
      if (worldDataWriteBusy) throw Error("正在保存存档，请等待写入完成后再扫描");
      if (worldDataResults.has(args.requestId)) throw Error("扫描请求标识已使用，请生成新 requestId；已有结果可继续查询");
      const task = activityCenter.start("world-data.scan", { title: "读取存档数据", projectId: args.profileId || null, source: "ui" });
      const timer = setInterval(() => {
        const progress = worldDataJobs.state(args.requestId);
        if (progress) activityCenter.update(task.id, { completed: progress.completed, total: progress.total, message: progress.stage });
      }, 300);
      try {
        let cached;
        const result = await worldDataJobs.render(args.requestId, { scope: args.scope || "all" }, async () => {
          let location = args.source;
          if (args.worldId) {
            const record = worlds.find(await worlds.read(), null, args.worldId), info = await worlds.inspect(record);
            if (info.deleted || !info.ready || !info.present) throw Error("存档尚未生成或已移除");
            location = info.path;
          }
          if (typeof location !== "string" || !path.isAbsolute(location)) throw Error("请选择存档来源");
          const identity = args.worldId ? undefined : await fileSelections.require(location, ["directory", "archive"]);
          if (args.summaryOnly && worldDataResults.has(args.reuseRequestId)) {
            cached = await worldDataStore.request("summary", { requestId: args.reuseRequestId }).catch(() => null);
          }
          return { source: location, identity, reuseFingerprint: cached?.source === location && cached.scope === (args.scope || "all") ? cached.fingerprint : undefined };
        });
        if (result.reused && cached) {
          activityCenter.finish(task.id, "success");
          return { ...cached, requestId: args.reuseRequestId };
        }
        await worldDataStore.request("put", { requestId: args.requestId, snapshot: result });
        worldDataResults.set(args.requestId, { source: result.source, worldId: args.worldId, editable: result.editable, versionPolicy: result.versionPolicy });
        while (worldDataResults.size > 4) worldDataResults.delete(worldDataResults.keys().next().value);
        activityCenter.finish(task.id, "success");
        if (!result.complete) activityCenter.event({ method: "world-data.scan", level: "warning", source: "ui", message: `世界数据仅获得部分结果：${result.statistics.failed} 处失败${result.truncated ? "，已达到读取上限" : ""}` });
        return { ...(args.summaryOnly ? require("../shared/world-data-model.cjs").summarizeSnapshot(result) : result), requestId: args.requestId };
      } catch (error) {
        const cancelled = /取消/.test(error.message);
        activityCenter.finish(task.id, cancelled ? "cancelled" : "failed", error.message);
        if (cancelled) error.activityLogged = true;
        throw error;
      } finally { clearInterval(timer); }
    }
    case "world-data.state": return worldDataJobs.state(args.requestId);
    case "world-data.dirty": {
      if (typeof args.dirty !== "boolean" || typeof args.key !== "string" || args.key.length > 16384) throw Error("编辑状态无效");
      if (args.dirty) worldDataDrafts.add(args.key); else worldDataDrafts.delete(args.key);
      worldDataDirty = worldDataDrafts.size > 0; return true;
    }
    case "world-data.edit.read":
    case "world-data.edit.prepare":
    case "world-data.policy.prepare":
    case "world-data.edit.apply":
    case "world-data.edit.restore": {
      const snapshot = worldDataResults.get(args.requestId);
      if (!snapshot?.editable) throw Error("来源只读或快照已过期，请重新扫描可编辑的存档目录");
      if (snapshot.worldId) {
        const info = await worlds.inspect(worlds.find(await worlds.read(), null, snapshot.worldId));
        if (!info.ready || info.deleted || info.path !== snapshot.source) throw Error("存档来源已变化");
      } else await fileSelections.require(snapshot.source, "directory");
      if (method === "world-data.edit.read" || method === "world-data.edit.prepare") {
        const target = await worldDataStore.request("edit-target", args);
        return method === "world-data.edit.read" ? worldDataEdits.read(target, args.field || "") : worldDataEdits.prepare(target, args.changes);
      }
      if (method === "world-data.policy.prepare") return worldDataEdits.preparePolicy(snapshot.source, args.value, snapshot.versionPolicy);
      if (worldDataWriteBusy || worldDataJobs.active || mapPreviewJobs.active) throw Error("请等待当前扫描、地图读取或写入完成");
      if (method === "world-data.edit.apply" && worldDataEdits.plans.get(args.token)?.target.source !== snapshot.source) throw Error("编辑预览与当前存档不匹配");
      worldDataWriteBusy = true;
      const task = activityCenter.start(method, { title: method.endsWith("restore") ? "恢复存档字段" : "备份并保存存档字段", source: "ui" });
      try {
        const result = await worlds.run(() => worlds.withWorldLock(snapshot.worldId || snapshot.source, () => method.endsWith("restore") ? worldDataEdits.restore(snapshot.source, args.backupId, args.confirmed) : worldDataEdits.apply(args.token, args.confirmed)));
        activityCenter.finish(task.id, "success"); return result;
      } catch (error) { activityCenter.finish(task.id, "failed", error.message); throw error; }
      finally {
        await worldDataStore.request("invalidate-source", { source: snapshot.source }).catch(() => {});
        for (const [id, value] of worldDataResults) if (value.source === snapshot.source) worldDataResults.delete(id);
        worldDataWriteBusy = false;
        if (win && !win.isDestroyed()) win.webContents.send("automation-data-changed", { method: "worlds.data" });
      }
    }
    case "world-data.query": {
      const result = worldDataResults.get(args.requestId);
      if (!result) throw Error("数据快照已过期，请重新扫描");
      return worldDataStore.request("query", args);
    }
    case "world-data.cancel": return worldDataJobs.cancel(args.requestId);
    case "world-data.compare": {
      const left = worldDataResults.get(args.left), right = worldDataResults.get(args.right);
      if (!left || !right) throw Error("比较快照已过期，请重新扫描来源");
      return worldDataStore.request("compare", args);
    }
    case "world-data.export": {
      const result = worldDataResults.get(args.requestId);
      if (!result) throw Error("数据快照已过期，请重新扫描");
      const other = args.compareWith && worldDataResults.get(args.compareWith);
      if (args.compareWith && (!other || args.format !== "json")) throw Error("比较快照不可用或导出格式无效");
      const text = await worldDataStore.request("export", args);
      const selected = await dialog.showSaveDialog(win, { title: "导出只读存档数据", defaultPath: "world-data." + args.format, filters: [{ name: args.format.toUpperCase(), extensions: [args.format] }] });
      if (selected.canceled || !selected.filePath) return false;
      const destination = path.resolve(selected.filePath), parent = await fs.realpath(path.dirname(destination));
      if (parent.toLowerCase() !== path.dirname(destination).toLowerCase()) throw Error("导出目录不能是链接");
      for (const snapshot of worldDataResults.values()) {
        const sourcePath = path.resolve(snapshot.source).toLowerCase();
        if (destination.toLowerCase() === sourcePath || destination.toLowerCase().startsWith(sourcePath + path.sep)) throw Error("请导出到来源存档之外的位置");
      }
      const existing = await fs.lstat(destination).catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw Error("导出目标必须是普通文件");
      await fs.writeFile(destination, text, "utf8");
      return true;
    }
    case "map-preview.render": {
      const browserWindow = source;
      return mapPreviewJobs.render(args.requestId,{format:args.format||"auto",dimension:args.dimension||"overworld",bounds:args.bounds,chunks:args.chunks,relief:args.relief??true},async()=>{
        let mapSource=args.source;
        if(args.worldId) {
          const record=worlds.find(await worlds.read(),null,args.worldId),info=await worlds.inspect(record);
          if(info.deleted||!info.ready||!info.present)throw Error("存档尚未生成或已移除");
          mapSource=info.path;
        }
        if(typeof mapSource!=="string"||!path.isAbsolute(mapSource))throw Error("请选择地图来源");
        const identity=args.worldId?undefined:await fileSelections.require(mapSource,["directory","archive"]);
        return {source: mapSource,identity};
      },batch=>{ if (!browserWindow.isDestroyed()) browserWindow.webContents.send("map-preview-data",{requestId:args.requestId,...batch}); });
    }
    case "map-preview.state": return mapPreviewJobs.state(args.requestId);
    case "map-preview.cancel": return mapPreviewJobs.cancel(args.requestId);
    case "map-preview.copy": {
      if (typeof args.text !== "string" || args.text.length > 200 || /[\0\r\n]/.test(args.text)) throw Error("地图坐标文本无效");
      await clipboard.writeText(args.text);
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
      await activityCenter.load();
      await profiles.initialize();
      await settingsChanged();
      const runtimeRoot = path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        "runtime",
      );
      mapPreviewJobs=new MapPreviewJobs(dataRoot,path.join(runtimeRoot,"automation/map-preview-worker.cjs"), { onError: reportBackgroundError, cachePreview: true });
      worldDataJobs=new MapPreviewJobs(dataRoot,path.join(runtimeRoot,"automation/world-data-worker.cjs"), { onError: reportBackgroundError, label: "世界数据", method: "world-data.scan" });
      worldDataStore=new WorldDataStore(path.join(runtimeRoot,"automation/world-data-compute-worker.cjs"), { onError: reportBackgroundError });
      worldDataEdits = new WorldDataEdits(dataRoot, runtimeRoot, {
        guard: async source => {
          const ids = (await worlds.read()).worlds.filter(world => !world.deletedAt && path.resolve(world.linkedPath || worlds.location(world.id)).toLowerCase() === path.resolve(source).toLowerCase()).map(world => world.id);
          await worlds.mutable(ids);
        },
        reserve: source => reserveIsolation(runtimeRoot, "Local\\DgnHost-" + require("node:crypto").createHash("sha256").update(path.resolve(source).toLowerCase()).digest("hex"), path.join(source, "db/LOCK")),
      });
      debuggerService = new DebugController(store, runtimeRoot, { onError: reportBackgroundError });
      tracyProfiler = new TracyProfiler(dataRoot, runtimeRoot, debuggerService, { onError: reportBackgroundError });
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
      editorEngine = new EditorEngine(dataRoot, runtimeRoot, uiDocuments, { onError: reportBackgroundError });
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
          createImportProfile: (name, worldId) =>
            profiles.createAutomatic(name.slice(0, 68) + "（自动匹配）", worldId),
          profiles,
          profileInUse: async (id) => !!(dirty || launcher?.starting || launcher?.profileRunning(id) || await gameProcesses.any()),
          onProfilesChanged: () => {
            if (win && !win.isDestroyed()) win.webContents.send("automation-data-changed", {method:"worlds.profiles"});
          },
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
          onError: reportBackgroundError,
          profiles,
          gameOptions,
          modLibrary,
          isolation: new HostIsolation(runtimeRoot, worlds, gameOptions),
          menuName: new MenuName(runtimeRoot),
          detectPids: (file) => gameProcesses.pids(file),
        },
      );
      worldActions = new WorldActions(launcher, debuggerService, worlds, { onError: reportBackgroundError });
      architectureImport = new ArchitectureImport({
        dataRoot,
        worlds,
        profiles,
        sessions: launcher,
        actions: worldActions,
        debug: debuggerService,
        protectedRoots: [
          app.getAppPath(),
          process.resourcesPath,
          worlds.worldsRoot,
        ],
        onError: reportBackgroundError,
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
        {
          protection: safeStorage,
          onError: ({ method, message }) =>
            activityCenter.event({
              method,
              level: "error",
              source: "rooms",
              message: "联机失败：" + message,
            }),
        },
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
        onError: reportBackgroundError,
      });
      automation = new AutomationBridge(
        dataRoot,
        new AutomationRouter({
          sessions: launcher,
          debug: debuggerService,
          worlds,
          store,
          joiner: clientJoiner,
          profiles,
          gameOptions,
          runtime: runtimeRoot,
          captureWindow: (snapshot, worker, bridge) => captureWindow(runtimeRoot, worker, bridge, snapshot),
           architecture: architectureImport,
          worldData: async (operation, args) => {
            if (operation === "scan") {
              const snapshot = await dispatch("world-data.scan", args);
              const { objects, relations, ...summary } = snapshot;
              return { ...summary, objectCount: objects.length, relationCount: relations.length };
            }
            return dispatch("world-data." + operation, args);
          },
           onError: reportBackgroundError,
          onDataChanged: (value) => {
            if (win && !win.isDestroyed()) win.webContents.send("automation-data-changed", value);
          },
          onSettingsChanged: async (next, patch) => {
            await settingsChanged();
          },
        }),
        { onError: reportBackgroundError },
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
          if (dirty || worldDataDirty || worldDataWriteBusy || inspectorWindow?.dirty)
            return { ok: false, reason: "请先保存或关闭未保存的修改" };
          if (closing) return { ok: false, reason: "工具箱正在退出" };
          return { ok: true };
        },
        requestQuit: () => app.quit(),
      });
      await updateService.loadInstallation();
      updateService.on("state", (value) => send("update-state", value));
      activityCenter.on("state", (value) => send("activity-state", value));
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
          const tracked = ActivityCenter.tracks(method), projectId = args.projectId || args.profileId || null;
          const automatic = method === "update.check" && args.automatic === true;
          if (tracked && !automatic && args.background !== true) activityCenter.event({ method, projectId, source: "ui", message: "开始：" + method });
          const result = await dispatch(method, args, source);
          const pending = result?.operationId || result?.busy ||
            ((method === "rooms.create" || method === "rooms.join") &&
              ["preparing", "network_starting", "game_starting", "connecting", "finding_room", "joining"].includes(result?.phase));
          if (tracked && !pending && args.background !== true) {
            let failure = "";
            if (method === "update.history" && result?.historyHasMore !== false) failure = result?.historyError;
            else if (method === "update.check" && result?.phase !== "no-release" && (result?.error || result?.historyError))
              failure = [...new Set([result?.error, result?.historyError].filter(Boolean))].join("\n");
            else if (method === "update.download" || method === "update.install")
              failure = result?.error;
            if (!automatic || failure)
              activityCenter.event({
                method,
                projectId,
                source: automatic ? "system" : "ui",
                ...(failure ? { level: "error", message: "失败：" + method + "：" + failure } : { message: "完成：" + method }),
              });
          }
          return { ok: true, result };
        } catch (error) {
          if (!error?.activityLogged)
            activityCenter.event({ method, projectId: args.projectId || args.profileId || null, level: "error", source: method === "update.check" && args.automatic === true ? "system" : "ui", message: "失败：" + method + "：" + (error.message || String(error)) });
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
          const stat = await fs.lstat(file);
          if (stat.isDirectory()) await fileSelections.allow(file,"directory");
          else if (stat.isFile() && /\.(zip|mcworld)$/i.test(file))
            await fileSelections.allow(file,"archive");
          else if (stat.isFile() && /\.(png|jpe?g|webp|bmp|gif)$/i.test(file))
            await fileSelections.allow(file,"image");
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
        if (worldDataWriteBusy) { event.preventDefault(); return; }
        if (
          closing ||
          (!launcher.hasRunning &&
            !launcher.starting &&
            !rooms.room &&
            !dirty && !worldDataDirty && !worldDataWriteBusy &&
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
          dirty: dirty || worldDataDirty || worldDataWriteBusy || inspectorWindow.dirty,
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
  app.on("before-quit", (event) => {
    if (worldDataWriteBusy) { event.preventDefault(); return; }
    if (process.env.DGN_GAME_HEADLESS) inspectorWindow?.destroy();
  });
  app.on("will-quit", (event) => {
    if (!closing && launcher) {
      event.preventDefault();
      const cleanup = async () => {
        const failures = [];
        const steps = [
          ["mcp.shutdown", () => automation?.setEnabled(false), false],
          ["map-preview.shutdown", () => mapPreviewJobs?.dispose(), false],
          ["world-data.shutdown", () => worldDataJobs?.dispose(), false],
          ["world-data.write.shutdown", () => worldDataEdits?.queue, false],
          ["world-data.compute.shutdown", () => worldDataStore?.dispose(), false],
          ["file-selection.shutdown", () => fileSelections.dispose(), false],
          ["architecture.shutdown", () => architectureImport?.dispose(), false],
          ["world-actions.shutdown", () => worldActions?.dispose(), false],
          ["game-titles.shutdown", () => gameTitles?.dispose(), false],
          ["rooms.shutdown", () => rooms?.shutdown(), true],
          ["client.shutdown", () => clientJoiner?.shutdown(), true],
          ["mod-library.shutdown", () => modLibrary.queue, false],
          ["ui-documents.shutdown", () => uiDocuments.queue, false],
          ["ui-editor.shutdown", () => editorEngine?.stop(), false],
          ["tracy.shutdown", () => tracyProfiler?.dispose(), false],
          ["game-options.shutdown", () => gameOptions.queue, false],
          ["launcher.shutdown", () => launcher.shutdown(), true],
          ["debug.shutdown", () => debuggerService?.dispose(), false],
          ["activity.flush", () => activityCenter.flush(), false],
        ];
        for (const [method, operation, critical] of steps) {
          try { await operation(); }
          catch (error) {
            reportBackgroundError({ method, message: error.message });
            if (critical) failures.push(method + "：" + error.message);
          }
        }
        return failures;
      };
      cleanup().then((failures) => {
          if (failures.length) {
            dialog.showErrorBox("无法结束游戏会话", failures.join("\n") + "\n请先确认游戏和联机进程已退出，再重试关闭工具箱。");
            return;
          }
          closing = true;
          // Do not re-enter Electron's quit sequence from its own microtask.
          setImmediate(() => app.quit());
        });
    }
  });
}
