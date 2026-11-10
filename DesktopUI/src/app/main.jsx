import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Icon,
  Intro,
  Section,
  Field,
  Select,
  PathField,
  Modal,
  ErrorBox,
  Empty,
  LocalImage,
  FileDropZone,
} from "./ui.jsx";
import { WindowControls } from "./window-controls.jsx";
import { usePageNavigation } from "./page-navigation.jsx";
import { debugTargetFor, launchTargetFor } from "../../shared/runtime-state.cjs";
import { receiveRuntime, useRuntimeState } from "./runtime-view.jsx";
import { LogsPage } from "../features/logs/logs.jsx";
import { ConfigExtras, GameDiscovery } from "../features/settings/config-extras.jsx";
import { DebugPage } from "../features/debug/debugger.jsx";
import { DebugSessionProvider, useDebugSession } from "../features/debug/debug-session.jsx";
import { UiInspectorPage } from "../features/debug/debug-ui.jsx";
import { InspectorShell } from "../features/debug/inspector-shell.jsx";
import { WorldHome } from "../features/worlds/worlds.jsx";
import { WindowSizeSettings } from "../features/settings/window-size-settings.jsx";
import { ProfilesPage } from "../features/profiles/profiles-page.jsx";
import { ModWorkspacePage } from "../features/mods/mod-library.jsx";
import { modKey, withoutMod, removeModJson } from "../../shared/mod-removal.cjs";
import { ReloadSettings } from "../features/settings/reload-settings.jsx";
import { GameOptionsPage } from "../features/settings/game-options.jsx";
import { UiEditorPage } from "../features/editor/ui-editor.jsx";
import { AutomationSettings } from "../features/settings/automation-settings.jsx";
import { UpdatePanel } from "../features/settings/update-panel.jsx";
import { RoomsPage } from "../features/rooms/rooms.jsx";
import { SettingsWorkspace, SettingsGroup } from "../features/settings/settings-workspace.jsx";
import { ActivityPage } from "../features/activity/activity-page.jsx";
import { NeteaseConfigPage } from "../features/netease/netease-config.jsx";
import { QuickLaunchPage } from "../features/quick-launch/quick-launch.jsx";
import { workspaces, workspaceFor, WorkspaceTabs } from "./workspaces.jsx";
import { RuntimeConsole } from "../features/debug/runtime-console.jsx";
import { createActivityInvalidator, sameRecords } from "../../shared/resource-refresh.cjs";

import "./styles.css";
import "./launcher.css";
import "./visual-refresh.css";
const api = (method, args = {}) => window.toolkit.call(method, args);
const nav = [
  { id: "runtime", label: "会话控制台", icon: "gamepad" },
  { id: "launch", label: "存档", icon: "archive" },
  { id: "rooms", label: "联机房间", icon: "gamepad" },
  { id: "config", label: "启动配置", icon: "launch-profile" },
  { id: "mods", label: "模组与内容", icon: "cube" },
  { id: "logs", label: "运行日志", icon: "terminal" },
  { id: "activity", label: "任务与记录", icon: "activity" },
  { id: "netease-config", label: "网易全局配置", icon: "folder" },
  { id: "quick-launch", label: "快捷程序", icon: "tools" },
  { id: "debug", label: "游戏调试", icon: "bug" },
  { id: "ui-debug", label: "UI 调试器", icon: "inspect" },
  { id: "ui-editor", label: "UI 编辑器", icon: "layout-edit" },
  { id: "tracy", label: "Tracy 性能", icon: "activity" },
  { id: "game-options", label: "游戏设置", icon: "gamepad" },
  { id: "settings", label: "设置", icon: "gear" },
  { id: "about", label: "关于", icon: "info" },
];
const navGroups = ["资源", "运行", "工具箱"].map(label => ({ id: label, label, items: workspaces.filter(item => item.group === label) }));
const fields = [
  "included_mod_dirs",
  "game_executable_path",
  "user_name",
  "include_debug_mod",
  "auto_hot_reload_mods",
  "auto_hot_reload_ui",
  "auto_hot_reload_shaders",
  "auto_hot_reload_materials",
  "auto_hot_reload_particles",
  "log_protocol",
];
const patchFor = (config) =>
  Object.fromEntries(fields.map((key) => [key, config[key]]));
function App() {
  const [worldImportDraft, setWorldImportDraft] = useState(null);
  const [modWorkspaceRequest, setModWorkspaceRequest] = useState(null);
  const [profileCreateRequest, setProfileCreateRequest] = useState(null);
  const [profileOpenRequest, setProfileOpenRequest] = useState(null);
  const [profileOrigin, setProfileOrigin] = useState(null);
  const [worldOpenRequest, setWorldOpenRequest] = useState(null);
  const [roomDraft, setRoomDraft] = useState({
    endpoint: "",
    localPort: "",
    worldId: "",
    playerName: "",
    invitation: "",
    roomCode: "",
    gamePath: "",
  });
  const [uiEditorDraft, setUiEditorDraft] = useState(null);
  const uiEditorDirty =
    !!uiEditorDraft &&
    (uiEditorDraft.raw !== uiEditorDraft.saved ||
      !!uiEditorDraft.propertyDraft);
  const [gameOptionsDraft, setGameOptionsDraft] = useState(null);
  const gameOptionsDirty =
    !!gameOptionsDraft &&
    JSON.stringify(gameOptionsDraft.values) !==
      JSON.stringify(gameOptionsDraft.saved);
  const { inspectorDirty, selectionLocked, selected: selectedSession, setSelected: selectDebugSession, session: debugSession, snapshot: debugSnapshot } = useDebugSession();
  const [debugDraft, setDebugDraft] = useState({
    code: "_result = 1 + 1",
    records: [],
  });
  const [settings, setSettings] = useState(null),
    [projects, setProjects] = useState([]),
    [snapshot, setSnapshot] = useState(null),
    [form, setForm] = useState(null),
    [raw, setRaw] = useState("");
  const [page, navigate] = usePageNavigation(
    "launch",
    workspaces.flatMap(workspace => workspace.pages.map(([id]) => id)),
  );
  const [lastPages, setLastPages] = useState({});
  const go = next => { setLastPages(old => ({ ...old, [workspaceFor(next).id]: next })); navigate(next); };
  const openWorld = (worldId, tab = "overview") => { setWorldOpenRequest({ worldId, tab, id: crypto.randomUUID() }); go("launch"); };
  const [advanced, setAdvanced] = useState(false),
    [runtime, setRuntime] = useState(""),
    [version, setVersion] = useState("");
  const runtimeState = useRuntimeState();
  const session = runtimeState.session;
  const [settingsWarning, setSettingsWarning] = useState("");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState(null);
  const [updateNotice, setUpdateNotice] = useState(null);
  const updateNoticeVersion = useRef("");
  const loadTicket = useRef(0);
  const profileDraft = useRef(null);
  profileDraft.current = { snapshot, form, raw };
  const confirming = useRef(false);
  const [savingIsolation, setSavingIsolation] = useState(false);
  const dirty =
    !!snapshot &&
    !snapshot.missing &&
    (!snapshot.exists ||
      (advanced
        ? raw !== snapshot.raw
        : JSON.stringify(patchFor(form)) !==
          JSON.stringify(patchFor(snapshot.config))));
  const active =
    !!runtimeState.sessions?.some((s) => s.running) ||
    runtimeState.starting ||
    runtimeState.stopping;
  const report = (err) => setError(err.message || String(err));
  function receive(value) {
    receiveRuntime(value);
  }
  const selectedBridge = debugTargetFor(runtimeState.session, debugSnapshot.sessions);
  useEffect(() => {
    if (runtimeState.session?.id) selectDebugSession(selectedBridge?.id || "launch:" + runtimeState.session.id);
  }, [runtimeState.session?.id, selectedBridge?.id, selectionLocked]);
  useEffect(() => {
    const bridge = debugSnapshot.sessions.find(s => s.id === selectedSession);
    const target = launchTargetFor(bridge, runtimeState.sessions || []);
    if (!target || target.id === runtimeState.session?.id) return;
    let live = true;
    api("launch.select", { sessionId: target.id }).then(value => { if (live) receive(value); }).catch(report);
    return () => { live = false; };
  }, [selectedSession]);
  function applySnapshot(value) {
    setSnapshot(value);
    setForm(value ? structuredClone(value.config) : null);
    setRaw(value?.raw || "");
  }
  async function loadProject(id) {
    const ticket = ++loadTicket.current;
    setBusy("正在读取配置…");
    try {
      const value = await api("project.read", { id });
      if (ticket === loadTicket.current) {
        applySnapshot(value);
        setAdvanced(!value.config && !value.missing);
        return true;
      }
    } catch (error) {
      if (ticket === loadTicket.current) report(error);
    } finally {
      if (ticket === loadTicket.current) setBusy("");
    }
  }
  useEffect(() => {
    const offTheme = window.toolkit.onTheme(({ dark, settings: latestSettings }) => {
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      if (latestSettings) setSettings(latestSettings);
    });
    const offAutomation = window.toolkit.onAutomationData(() => {
      api("profiles.list").then(async (list) => {
        setProjects(list);
        const current = profileDraft.current;
        if (!current.snapshot) return;
        const edited = current.raw !== current.snapshot.raw ||
          JSON.stringify(patchFor(current.form || {})) !== JSON.stringify(patchFor(current.snapshot.config || {}));
        if (edited) {
          setNotice("配置列表已更新；当前未保存草稿已保留，保存前请核对配置是否仍存在。");
          return;
        }
        if (!list.some(p => p.id === current.snapshot.project.id)) {
          ++loadTicket.current;
          applySnapshot(null);
          return;
        }
        const value = await api("project.read", {id:current.snapshot.project.id});
        const latest = profileDraft.current;
        if (latest.snapshot === current.snapshot && latest.raw === current.raw && latest.form === current.form) applySnapshot(value);
      }).catch(report);
    });
    const invalidatesResources = createActivityInvalidator();
    const offActivity = window.toolkit.onActivity((value) => {
      // 错误事件不刷新配置，避免刷新失败再次写日志形成循环。
      if (value.events?.[0]?.level === "error") return;
      if (invalidatesResources(value)) api("profiles.list").then(list => setProjects(current => sameRecords(current, list))).catch(report);
    });
    const offState = window.toolkit.onSession(receive);
    const offLog = window.toolkit.onLogs(receive);
    const offUpdate = window.toolkit.onUpdate((value) => {
      if (
        value.phase === "available" &&
        value.latestVersion &&
        updateNoticeVersion.current !== value.latestVersion
      ) {
        updateNoticeVersion.current = value.latestVersion;
        setUpdateNotice(value);
      }
    });
    api("bootstrap")
      .then((value) => {
        setSettings(value.settings);
        setProjects(value.projects);
        setRuntime(value.runtime);
        setVersion(value.version);
        setSettingsWarning(value.warning || "");
        receive(value);
        document.documentElement.dataset.theme = value.dark ? "dark" : "light";
        if (value.projects[0]) loadProject(value.projects[0].id);
        return value;
      })
      .then(() => api("update.check", { automatic: true }))
      .catch(report);
    const updateTimer = setInterval(() => {
      api("update.check", { automatic: true }).catch(() => {});
    }, 6 * 60 * 60 * 1000);
    const preventDrop = (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes("Files"))
        event.preventDefault();
    };
    window.addEventListener("dragover", preventDrop);
    window.addEventListener("drop", preventDrop);
    return () => {
      clearInterval(updateTimer);
      offTheme();
      offAutomation();
      offActivity();
      offState();
      offLog();
      offUpdate();
      window.removeEventListener("dragover", preventDrop);
      window.removeEventListener("drop", preventDrop);
      loadTicket.current++;
    };
  }, []);
  useEffect(() => {
    api("window.dirty", {
      dirty: dirty || inspectorDirty || gameOptionsDirty || uiEditorDirty,
    }).catch(report);
  }, [dirty, inspectorDirty, gameOptionsDirty, uiEditorDirty]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (page !== "config") return;
    let active = true;
    api("profiles.list")
      .then((list) => {
        if (active) setProjects(list);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [page]);
  async function saveSettings(patch) {
    const value = await api("settings.update", patch);
    setSettings(value);
  }
  async function removedMod(result) {
    const before = profileDraft.current;
    if (!before.snapshot?.config) return;
    const change = result.changes.find(
      (c) => c.id === before.snapshot.project.id,
    );
    try {
      if (change && change.beforeRevision !== before.snapshot.revision)
        throw Error("当前配置草稿基于旧版本，请重新载入后继续编辑");
      const updated = change
        ? await api("project.read", { id: change.id })
        : before.snapshot;
      if (profileDraft.current.snapshot !== before.snapshot) return;
      if (change && updated.revision !== change.revision)
        throw Error("配置又被外部修改，请重新载入后继续编辑");
      const current = profileDraft.current;
      const base = updated.project.baseDirectory || updated.project.root;
      const nextRaw = removeModJson(
        current.raw,
        (dir) => modKey(dir, base) === modKey(result.removedPath),
      );
      setForm({
        ...current.form,
        included_mod_dirs: withoutMod(
          current.form.included_mod_dirs,
          base,
          result.removedPath,
        ),
      });
      setRaw(nextRaw);
      setSnapshot(updated);
    } catch (error) {
      // Keep both the draft and its old revision on conflict; saving it must
      // never silently resurrect the removed mod or overwrite external edits.
      report(Error("模组已移除；未替换当前编辑草稿：" + error.message));
    }
  }
  function selectProject(id, onLoaded) {
    if (snapshot?.project.id === id) {
      onLoaded?.();
      return;
    }
    const action = async () => {
      if (await loadProject(id)) onLoaded?.();
    };
    if (dirty)
      setConfirm({
        title: "切换启动配置？",
        detail: "当前未保存的配置修改将被放弃，磁盘上的配置保留。",
        action,
      });
    else action();
  }
  async function saveConfig() {
    const value = await api("project.save", {
      id: snapshot.project.id,
      revision: snapshot.revision,
      ...(advanced
        ? { raw }
        : {
            patch: Object.fromEntries(
              Object.entries(patchFor(form)).filter(
                ([key, value]) =>
                  JSON.stringify(value) !==
                  JSON.stringify(snapshot.config[key]),
              ),
            ),
          }),
    });
    applySnapshot(value);
    return value;
  }
  async function save() {
    setBusy("正在保存配置…");
    try {
      await saveConfig();
      setNotice("启动配置已保存，原文件已备份");
    } catch (error) {
      report(error);
    } finally {
      setBusy("");
    }
  }
  async function startTarget(profileId, worldId = null) {
    const action = async () => {
      setBusy("正在启动游戏…");
      try {
        if (gameOptionsDirty) await saveGameOptionsDraft();
        if (snapshot?.project.id === profileId && dirty) await saveConfig();
        receive(await api("launch.start", { profileId, worldId }));
        go(worldId ? "launch" : "logs");
      } catch (error) {
        report(error);
      } finally {
        setBusy("");
      }
    };
    if ((snapshot?.project.id === profileId && dirty) || gameOptionsDirty)
      setConfirm({
        title: "保存配置并启动？",
        detail: "启动配置或游戏设置还有未保存修改，将保存后用于本次启动。",
        action,
      });
    else action();
  }
  async function startQuick(args) {
    setBusy("正在启动快速测试…");
    try {
      receive(await api("launch.quick", args));
      go("launch");
    } finally {
      setBusy("");
    }
  }
  async function saveGameOptionsDraft() {
    const value = await api("game-options.save", {
      revision: gameOptionsDraft.revision,
      overrides: gameOptionsDraft.values,
    });
    setGameOptionsDraft({
      revision: value.revision,
      values: value.overrides,
      saved: value.overrides,
    });
  }
  async function startBlank(userName) {
    if (gameOptionsDirty) {
      setConfirm({
        title: "保存游戏设置并启动？",
        detail: "游戏设置还有未保存修改，将保存后用于本次空白客户端启动。",
        action: async () => {
          await saveGameOptionsDraft();
          await launchBlank(userName);
        },
      });
      return;
    }
    await launchBlank(userName);
  }
  async function launchBlank(userName) {
    setBusy("正在启动空白客户端…");
    try {
      receive(await api("launch.blank", { userName }));
      go("logs");
    } catch (error) {
      report(error);
    } finally {
      setBusy("");
    }
  }
  async function launchJoined(args) {
    setBusy("正在启动联机客户端…");
    try {
      const result = await api("launch.joined", args);
      receive(await api("launch.select", { sessionId: result.sessionId }));
      go("logs");
    } finally {
      setBusy("");
    }
  }
  function stop(id) {
    const target =
      typeof id === "string"
        ? runtimeState.sessions.find((s) => s.id === id)
        : session;
    setConfirm({
      title: "停止当前会话？",
      detail:
        "这会结束本次启动的游戏及启动器，请先在游戏内保存进度。不会结束其他独立启动的游戏。",
      action: async () => {
        setBusy("正在停止…");
        try {
          receive(await api("launch.stop", { sessionId: target?.id }));
        } finally {
          setBusy("");
        }
      },
    });
  }
  const change = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  if (!settings)
    return (
      <div className="boot">
        <h1>大果喵游戏工具箱</h1>
        <p>正在准备…</p>
        <ErrorBox>{error}</ErrorBox>
      </div>
    );
  const title = nav.find((item) => item.id === page)?.label
    || workspaces.flatMap((item) => item.pages).find(([id]) => id === page)?.[1]
    || "页面";
  const workspace = workspaceFor(page);
  const runningSessions = runtimeState.sessions?.filter((item) => item.running).length || 0;
  const activityPending = runtimeState.starting || runtimeState.stopping;
  const activityLabel = runtimeState.starting ? "正在启动…"
    : runtimeState.stopping ? "正在停止…"
      : runningSessions ? `${runningSessions} 个会话运行中` : "就绪";
  return (
    <div
      className={`app ${settings.SidebarCollapsed ? "collapsed" : ""} ${settings.BgImagePath ? "has-background" : ""}`}
      style={{
        "--accent-hue": settings.ThemeHue,
        "--background-opacity": settings.BgImageOpacity,
        "--background-blur": `${settings.BgImageBlur}px`,
        "--background-scale": settings.BgImageScale,
      }}
    >
      {settings.BgImagePath && (
        <div className="window-background" aria-hidden="true">
          <LocalImage
            path={settings.BgImagePath}
            className="workspace-background"
          />
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-mark">
            <Icon name="cube" />
          </div>
          {!settings.SidebarCollapsed && (
            <span className="brand-name">大果喵游戏工具箱</span>
          )}
          <Button
            icon="panel"
            aria-label="切换侧栏"
            onClick={() =>
              saveSettings({
                SidebarCollapsed: !settings.SidebarCollapsed,
              }).catch(report)
            }
          />
        </div>
        <nav aria-label="主要导航">
          {navGroups.map((group) => (
            <div className={`nav-group nav-group-${group.id}`} key={group.id}>
              {!settings.SidebarCollapsed && (
                <span className="nav-group-label">{group.label}</span>
              )}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={workspace.id === item.id ? "page" : undefined}
                  className={`nav-item ${workspace.id === item.id ? "active" : ""}`}
                  onClick={() => go(lastPages[item.id] || item.id)}
                >
                  <Icon name={item.icon} />
                  {!settings.SidebarCollapsed && <span>{item.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {!settings.SidebarCollapsed && (
            <div className="session-note" data-state={activityPending ? "pending" : "ready"}>
              <span className="status-dot" aria-hidden="true" />
              <span>{activityLabel === "就绪" ? "工具箱已就绪" : activityLabel}</span>
            </div>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="app-bar">
          <div className="app-bar-title">
            <span className="eyebrow">大果喵游戏工具箱</span>
            <div className="breadcrumb">{title !== workspace.label && <span>{workspace.label} /</span>}<h1>{title}</h1></div>
          </div>
          <div className="app-bar-tools">
            <span className="app-bar-status" data-state={activityPending ? "pending" : "ready"} role="status">
              <span className="status-dot" aria-hidden="true" />
              <span>{activityLabel}</span>
            </span>
            <div className="app-bar-shortcuts" role="group" aria-label="全局快捷入口">
              <Button icon="gamepad" compact className="app-bar-shortcut" title="打开会话控制台" aria-current={page === "runtime" ? "page" : undefined} onClick={() => go("runtime")}>会话</Button>
              <Button icon="activity" compact className="app-bar-shortcut" title="查看任务与记录" aria-current={page === "activity" ? "page" : undefined} onClick={() => go("activity")}>任务与记录</Button>
            </div>
          </div>
        </header>
        {workspace.pages.length > 1 && <WorkspaceTabs tabs={workspace.pages} value={page} onChange={go} />}
        {workspace.id === "logs" && <div className="runtime-context">
          <Select aria-label="当前运行会话" value={runtimeState.session?.id || ""} disabled={selectionLocked}
            options={(runtimeState.sessions || []).map(s => ({ value: s.id, label: `${s.worldName || s.profileName || "菜单客户端"} · ${s.userName || "玩家"} · ${s.running ? "运行中" : "已结束"}` }))}
            placeholder="选择运行会话" onChange={id => api("launch.select", { sessionId: id }).then(receive).catch(report)} />
          <p>{debugSession ? `${debugSession.connected ? "调试已连接" : "调试未连接"} · 操作只作用于所选会话` : "所选会话不可用，请明确选择目标"}</p>
        </div>}
        <main
          key={page}
          className={
            page === "tracy"
              ? "tracy-main"
              : page === "ui-editor"
                ? "editor-main"
                : page === "ui-debug"
                  ? "inspector-main"
                  : page === "logs"
                    ? "logs-main"
                    : undefined
          }
        >
          <div className="page-container">
            {settingsWarning && (
              <div className="error-box">
                {settingsWarning}
                <Button onClick={() => setSettingsWarning("")}>知道了</Button>
              </div>
            )}
            {page === "launch" && (
              <WorldHome
                openRequest={worldOpenRequest}
                onOpenRequestHandled={() => setWorldOpenRequest(null)}
                onEditProfile={world => selectProject(world.profileId, () => {
                  setProfileOrigin({ worldId: world.id, profileId: world.profileId, name: world.name });
                  setProfileOpenRequest({ profileId: world.profileId, id: crypto.randomUUID() });
                  go("config");
                })}
                projectId={snapshot?.project.id}
                profiles={projects}
                runtimeState={runtimeState}
                busy={!!busy || runtimeState.starting}
                onConfigure={() => go("config")}
                onProfiles={setProjects}
                importDraft={worldImportDraft}
                onImportDraft={setWorldImportDraft}
                onAddProfile={(draft) => {
                  setWorldImportDraft(draft);
                  setProfileCreateRequest(crypto.randomUUID());
                  go("config");
                }}
                onStart={startTarget}
                onQuickStart={startQuick}
                onStartBlank={startBlank}
                onStartJoined={launchJoined}
                onLogs={async (sessionId) => {
                  try {
                    if (selectionLocked) throw Error("请等待当前属性写入完成后切换会话");
                    receive(await api("launch.select", { sessionId }));
                    go("logs");
                  } catch (e) {
                    report(e);
                  }
                }}
                onStop={stop}
                onRuntime={async id => { try { if (selectionLocked) throw Error("请等待当前属性写入完成后切换会话"); if (typeof id === "string") receive(await api("launch.select", { sessionId: id })); go("runtime"); } catch (e) { report(e); } }}
                onActivity={() => go("activity")}
                onBrowseContent={(request) => { setModWorkspaceRequest(request); go("mods"); }}
              />
            )}
            {page === "tracy" && <DebugPage key="performance" performance projectId={snapshot?.project.id} draft={debugDraft} setDraft={setDebugDraft} />}
            {page === "runtime" && <RuntimeConsole state={runtimeState} busy={!!busy} onBlank={startBlank} onJoined={launchJoined} onStop={stop} onOpenWorld={openWorld} onWorlds={() => go("launch")} />}
            {page === "rooms" && (
              <RoomsPage draft={roomDraft} onDraft={setRoomDraft} />
            )}
            {page === "config" && (
              <ProfilesPage
                openRequest={profileOpenRequest}
                onOpenRequestHandled={() => setProfileOpenRequest(null)}
                originWorldName={profileOrigin?.name}
                onReturnToWorld={profileOrigin && profileOrigin.profileId === snapshot?.project.id ? () => { openWorld(profileOrigin.worldId); setProfileOrigin(null); } : undefined}
                createRequest={profileCreateRequest}
                onCreateRequestHandled={() => setProfileCreateRequest(null)}
                onNewProfile={(profile) =>
                  setWorldImportDraft((draft) =>
                    draft ? { ...draft, profileId: profile.id } : null,
                  )
                }
                onReturnToImport={
                  worldImportDraft
                    ? () => {
                        setProfileCreateRequest(null);
                        go("launch");
                      }
                    : undefined
                }
                profiles={projects}
                snapshot={snapshot}
                form={form}
                raw={raw}
                setRaw={setRaw}
                advanced={advanced}
                setAdvanced={setAdvanced}
                dirty={dirty}
                busy={!!busy}
                onSelect={selectProject}
                onStart={startTarget}
                runtimeState={runtimeState}
                onCreated={applySnapshot}
                onManageMods={() => go("mods")}
                onGlobalSettings={() => go("settings")}
                globalGamePath={settings.GamePath}
                onProfiles={setProjects}
                change={change}
                save={save}
                report={report}
                onReload={() => {
                  if (dirty)
                    setConfirm({
                      title: "重新载入配置？",
                      detail: "未保存的修改将被放弃。",
                      action: () => loadProject(snapshot.project.id),
                    });
                  else loadProject(snapshot.project.id);
                }}
              />
            )}
            {page === "game-options" && (
              <GameOptionsPage
                draft={gameOptionsDraft}
                setDraft={setGameOptionsDraft}
              />
            )}
            {page === "logs" && (
              <LogsPage
                receive={receive}
                stop={stop}
                busy={!!busy}
                report={report}
              />
            )}
            {page === "activity" && <ActivityPage projects={projects} />}
            {page === "netease-config" && <NeteaseConfigPage />}
            {page === "quick-launch" && <QuickLaunchPage />}
            {page === "mods" && <ModWorkspacePage request={modWorkspaceRequest} onClearScope={() => setModWorkspaceRequest(null)} onBack={() => go("launch")} onEditor={() => go("ui-editor")} onRemoved={removedMod} />}
            {page === "debug" && (
              <DebugPage
                key="code"
                projectId={snapshot?.project.id}
                draft={debugDraft}
                setDraft={setDebugDraft}
              />
            )}
            {page === "ui-debug" && <UiInspectorPage />}
            {page === "ui-editor" && (
              <UiEditorPage draft={uiEditorDraft} setDraft={setUiEditorDraft} />
            )}
            {page === "settings" && (
              <>
                <Intro
                  title="设置"
                  subtitle="主题、背景和启动器设置独立保存，不影响模组工具箱。"
                />
                <SettingsWorkspace>
                <SettingsGroup id="game">
                <Section
                  title="默认游戏程序"
                  description="供空白客户端和未指定独立程序的启动配置使用；已有配置固定的版本不受影响。保存后从下一次启动生效。"
                >
                  <PathField
                    label="游戏程序"
                    kind="executable"
                    hint="可选择 Minecraft.Windows.exe；也可在下方选择 MCStudioDownload 自动查找版本。"
                    value={settings.GamePath}
                    onChange={(value) =>
                      saveSettings({ GamePath: value }).catch(report)
                    }
                  />
                  <GameDiscovery
                    value={settings.GamePath}
                    change={(value) =>
                      saveSettings({ GamePath: value }).catch(report)
                    }
                    report={report}
                  />
                  {settings.GamePath && (
                    <Button
                      onClick={() =>
                        saveSettings({ GamePath: "" }).catch(report)
                      }
                    >
                      清除默认程序
                    </Button>
                  )}
                  <p className="muted">
                    空白客户端和未指定独立程序的配置使用这里的程序；需要固定其他版本时，在启动配置中关闭“使用全局游戏程序”。
                  </p>
                </Section>
                <Section
                  title="存档主机"
                  description="独立主机可同时运行不同存档，需要内置 MCDK 和已验证隔离能力的游戏构建；当前支持 3.10.0.436581、3.10.0.448891，详见上方版本能力表。其他构建使用兼容单主机模式，修改只影响后续启动。"
                >
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={settings.IndependentWorlds !== false}
                      disabled={savingIsolation}
                      onChange={(e) => {
                        const previous = settings.IndependentWorlds !== false,
                          value = e.target.checked;
                        setSavingIsolation(true);
                        setSettings((current) => ({
                          ...current,
                          IndependentWorlds: value,
                        }));
                        saveSettings({ IndependentWorlds: value })
                          .catch((error) => {
                            setSettings((current) => ({
                              ...current,
                              IndependentWorlds: previous,
                            }));
                            report(error);
                          })
                          .finally(() => setSavingIsolation(false));
                      }}
                    />
                    启用独立主机
                  </label>
                  <p className="muted">
                    每个存档使用独立的游戏设置与模组运行目录；存档本身保留原位置。同一存档不可同时打开。若启动环境不支持隔离，可关闭此选项使用兼容模式。更改在下一次启动时生效。
                  </p>
                </Section>
                </SettingsGroup>
                <SettingsGroup id="window">
                <WindowSizeSettings
                  value={settings.GameWindowSize}
                  save={saveSettings}
                />
                </SettingsGroup>
                <SettingsGroup id="automation">
                <AutomationSettings
                  settings={settings}
                  save={saveSettings}
                  report={report}
                />
                </SettingsGroup>
                <SettingsGroup id="update">
                <UpdatePanel version={version} report={report} />
                </SettingsGroup>
                <SettingsGroup id="appearance">
                <Section title="外观">
                  <Field label="界面主题">
                    <Select
                      value={settings.AppearanceMode}
                      options={[
                        { value: "System", label: "跟随系统" },
                        { value: "Light", label: "浅色" },
                        { value: "Dark", label: "深色" },
                      ]}
                      onChange={(value) =>
                        saveSettings({ AppearanceMode: value }).catch(report)
                      }
                    />
                  </Field>
                  <PathField
                    label="背景图片"
                    kind="background"
                    value={settings.BgImagePath}
                    onChange={(value) =>
                      saveSettings({ BgImagePath: value }).catch(report)
                    }
                  />
                  {settings.BgImagePath && (
                    <Button
                      onClick={() =>
                        saveSettings({ BgImagePath: "" }).catch(report)
                      }
                    >
                      移除背景图片
                    </Button>
                  )}
                  {[
                    ["ThemeHue", "主题色相", 0, 360, 1, "°"],
                    ["BgImageOpacity", "背景显示强度", 0, 100, 100, "%"],
                    ["BgImageBlur", "背景模糊度", 0, 30, 1, "px"],
                    ["BgImageScale", "背景缩放", 100, 200, 100, "%"],
                  ].map(([key, label, min, max, ratio, unit]) => (
                    <Field key={key} label={label}>
                      <div className="background-opacity-control">
                        <input
                          type="range"
                          min={min}
                          max={max}
                          step="1"
                          value={Math.round(settings[key] * ratio)}
                          onChange={(e) =>
                            saveSettings({
                              [key]: Number(e.target.value) / ratio,
                            }).catch(report)
                          }
                        />
                        <output>
                          {Math.round(settings[key] * ratio)}
                          {unit}
                        </output>
                      </div>
                    </Field>
                  ))}
                </Section>
                </SettingsGroup>
                <SettingsGroup id="shortcuts">
                <ReloadSettings
                  options={settings.ReloadKeys}
                  save={saveSettings}
                  report={report}
                />
                </SettingsGroup>
                <SettingsGroup id="launcher">
                <Section title="启动器">
                  <p className="muted break-all">内置 MCDK v1.6.1：{runtime}</p>
                  <PathField
                    label="自定义 mcdk.exe（可选）"
                    kind="executable"
                    value={settings.LauncherPath}
                    onChange={(value) =>
                      saveSettings({ LauncherPath: value }).catch(report)
                    }
                  />
                  {settings.LauncherPath && (
                    <Button
                      onClick={() =>
                        saveSettings({ LauncherPath: "" }).catch(report)
                      }
                    >
                      使用内置启动器
                    </Button>
                  )}
                </Section>
                </SettingsGroup>
                </SettingsWorkspace>
              </>
            )}
            {page === "about" && (
              <>
                <Intro
                  title="关于游戏工具箱"
                  subtitle={`DaGuoNeko Game Toolkit · ${version}`}
                />
                <Section title="独立启动与配置">
                  <p>
                    为网易《我的世界》模组开发管理配置与存档、启动游戏并查看日志，无需打开
                    VS Code。
                  </p>
                  <p className="muted">
                    提供多套启动配置、存档绑定、多客户端、运行日志，以及代码执行、调试函数、UI
                    调试、Python 耗时与内存分析、Native 性能采样。IDE
                    断点与单步调试尚未提供。
                  </p>
                </Section>
                <Section title="制作与开源项目">
                  <p>作者：大果喵（DaGuoNeko）</p>
                  <p>
                    游戏启动核心：Zero123 / Kid Studio 的
                    MCDevTool（BSD-3-Clause）。功能与配置研究参考 Dofes 的 MC
                    Dev Tools（MIT）。
                  </p>
                  <div className="toolbar">
                    <Button
                      icon="external"
                      onClick={() =>
                        api("web.open", { kind: "upstream" }).catch(report)
                      }
                    >
                      MCDevTool 源码
                    </Button>
                    <Button
                      icon="external"
                      onClick={() =>
                        api("web.open", { kind: "extension" }).catch(report)
                      }
                    >
                      MC Dev Tools 源码
                    </Button>
                  </div>
                </Section>
              </>
            )}
          </div>
        </main>
        {busy && (
          <div className="progress-bar" role="status">
            <span className="spinner" />
            {busy}
          </div>
        )}
      </div>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {error && (
        <Modal
          title="操作提示"
          onClose={() => setError("")}
          footer={
            <Button primary onClick={() => setError("")}>
              知道了
            </Button>
          }
        >
          <ErrorBox>{error}</ErrorBox>
        </Modal>
      )}
      {updateNotice && (
        <Modal
          title="发现新版本"
          description={`当前 ${version} · 最新 ${updateNotice.latestVersion}`}
          onClose={() => setUpdateNotice(null)}
          footer={
            <>
              <Button onClick={() => setUpdateNotice(null)}>稍后处理</Button>
              <Button
                onClick={() =>
                  api("update.open-release").catch(report)
                }
              >
                查看更新条目
              </Button>
              <Button
                primary
                onClick={() => {
                  setUpdateNotice(null);
                  go("settings");
                }}
              >
                去设置下载
              </Button>
            </>
          }
        >
          <p>发现公开正式版本，可在设置页下载并安装。更新不会修改存档、模组或配置。</p>
          {updateNotice.notes && (
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>
              {updateNotice.notes}
            </pre>
          )}
        </Modal>
      )}
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => !busy && setConfirm(null)}
          busy={!!busy}
          footer={
            <>
              <Button disabled={!!busy} onClick={() => setConfirm(null)}>
                取消
              </Button>
              <Button
                primary
                disabled={!!busy}
                onClick={async () => {
                  if (confirming.current) return;
                  const action = confirm.action;
                  setConfirm(null);
                  confirming.current = true;
                  setBusy("正在处理…");
                  try {
                    await action();
                  } catch (error) {
                    report(error);
                  } finally {
                    confirming.current = false;
                    setBusy("");
                  }
                }}
              >
                确认
              </Button>
            </>
          }
        >
          <p>{confirm.detail}</p>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <DebugSessionProvider>
    {new URLSearchParams(location.search).get("inspector") === "1" ? (
      <InspectorShell />
    ) : (
      <>
        <App />
        <WindowControls />
      </>
    )}
  </DebugSessionProvider>,
);
