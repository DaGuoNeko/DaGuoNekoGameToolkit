import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Intro,
  Field,
  Select,
  Modal,
  Empty,
  ErrorBox,
  Icon,
  FileDropZone,
} from "../../app/ui.jsx";
import "./worlds.css";
import { WorldDashboard } from "./world-actions.jsx";
import { QuickTestDialog } from "./quick-test.jsx";
import { LocalJoinDialog } from "./local-join.jsx";
import {
  AUTO_IMPORT_PROFILE,
  AUTO_IMPORT_LABEL,
} from "../../../shared/world-import-model.cjs";
const call = (method, args = {}) => window.toolkit.call(method, args);
const defaults = {
  game_mode: 1,
  world_type: 1,
  world_seed: null,
  enable_cheats: true,
  keep_inventory: true,
  do_weather_cycle: true,
  do_daylight_cycle: true,
};
const experiments = [
  ["data_driven_biomes", "自定义生物群系"],
  ["upcoming_creator_features", "创作者功能"],
  ["experimental_creator_cameras", "实验性摄像机"],
  ["gametest", "GameTest"],
  ["deferred_technical_preview", "延迟渲染技术预览"],
];
export function WorldHome({
  profiles,
  runtimeState,
  busy,
  onConfigure,
  onAddProfile,
  onProfiles,
  importDraft,
  onImportDraft,
  onStart,
  onQuickStart,
  onStartBlank,
  onStartJoined,
  onLogs,
  onStop,
}) {
  const activeHost = runtimeState.sessions?.findLast(
    (s) => s.running && s.worldId,
  );
  const [focusId, setFocusId] = useState(activeHost?.worldId || "");
  const [quickWorld, setQuickWorld] = useState(null);
  const [joinTarget, setJoinTarget] = useState(null);
  const [worlds, setWorlds] = useState([]),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [dialog, setDialog] = useState(null),
    [trash, setTrash] = useState(false),
    [query, setQuery] = useState("");
  const [name, setName] = useState(""),
    [profileId, setProfileId] = useState(""),
    [options, setOptions] = useState(defaults),
    [source, setSource] = useState(""),
    [importMode, setImportMode] = useState("linked"),
    [sourceDirectory, setSourceDirectory] = useState(true),
    [playerName, setPlayerName] = useState("");
  useEffect(() => {
    if (importDraft) {
      setFocusId("");
      setDialog({ kind: "import", targets: [] });
      setName(importDraft.name);
      setSource(importDraft.source);
      setImportMode(importDraft.importMode || "linked");
      setSourceDirectory(importDraft.sourceDirectory ?? true);
      setProfileId(importDraft.profileId);
      onImportDraft(null);
    }
  }, []);
  function randomName() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return (
      "Player" +
      Array.from(bytes, (n) => String.fromCharCode(97 + (n % 26))).join("")
    );
  }
  const ticket = useRef(0);
  const running = runtimeState.sessions?.some((s) => s.running);
  const refresh = async () => {
    const t = ++ticket.current;
    try {
      const v = await call("worlds.list");
      if (t === ticket.current) setWorlds(v.worlds);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    refresh();
    const offAutomation = window.toolkit.onAutomationData(() => refresh());
    return () => {
      offAutomation();
      ticket.current++;
    };
  }, [
    runtimeState.revision > 0
      ? runtimeState.sessions?.map((s) => s.id + ":" + s.running).join("|")
      : "",
  ]);
  function open(kind, w) {
    setDialog({
      kind,
      w,
      targets:
        kind === "purge"
          ? [w]
          : kind === "empty"
            ? worlds.filter((item) => item.deleted)
            : [],
    });
    setName(w?.name || (kind === "import" ? "导入的存档" : "新的存档"));
    setProfileId(
      kind === "import"
        ? AUTO_IMPORT_PROFILE
        : w?.profileId || profiles[0]?.id || "",
    );
    setOptions({ ...defaults, ...w?.options });
    setSource("");
    setImportMode("linked");
    setSourceDirectory(true);
    if (kind === "menu") setPlayerName(randomName());
    setError("");
  }
  const update = (key, value) =>
    setOptions((old) => ({ ...old, [key]: value }));
  function importFiles(files, show = true) {
    if (files.length !== 1) throw Error("请一次拖入一个存档文件夹或 ZIP");
    const file = files[0];
    if (!file.directory && !/\.(zip|mcworld)$/i.test(file.path))
      throw Error("只支持存档文件夹或 ZIP");
    if (busy || working || running)
      throw Error("请先保存并退出游戏，再导入存档");
    if (show) open("import");
    setSource(file.path);
    setSourceDirectory(file.directory);
    if (!file.directory) setImportMode("copy");
    else if (show || !sourceDirectory) setImportMode("linked");
    const previousName = source
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.(zip|mcworld)$/i, "");
    if (show || !name.trim() || name === "导入的存档" || name === previousName)
      setName(
        file.path
          .split(/[\\/]/)
          .filter(Boolean)
          .at(-1)
          .replace(file.directory ? /$^/ : /\.(zip|mcworld)$/i, "")
          .slice(0, 80),
      );
    setError("");
  }
  async function submit() {
    setWorking(true);
    setError("");
    try {
      const kind = dialog.kind,
        w = dialog.w;
      if (kind === "menu") {
        setDialog(null);
        onStartBlank(playerName);
        return;
      }
      if (kind === "create")
        await call("worlds.create", {
          projectId: profileId,
          name,
          seed: options.world_seed,
          worldType: options.world_type,
          gameMode: options.game_mode,
          options,
        });
      if (kind === "edit")
        await call("worlds.update", {
          worldId: w.id,
          profileId,
          name,
          options,
        });
      if (kind === "import") {
        await call("worlds.import", {
          profileId,
          name,
          source,
          mode: importMode,
        });
        setDialog(null);
      }
      if (kind === "delete")
        await call("worlds.recycle", { worldId: w.id, confirmed: true });
      if (kind === "restore") await call("worlds.restore", { worldId: w.id });
      if (kind === "purge" || kind === "empty")
        await call("worlds.purge", {
          worldIds: dialog.targets.map((item) => item.id),
          confirmed: true,
        });
      setDialog(null);
      await refresh();
    } catch (e) {
      setError(e.message);
      if (["import", "edit", "delete", "restore"].includes(dialog.kind)) await refresh();
      if (dialog.kind === "purge" || dialog.kind === "empty") {
        setDialog(null);
        await refresh();
      }
    } finally {
      await call("profiles.list").then(onProfiles).catch(e => setError(e.message));
      setWorking(false);
    }
  }
  const items = worlds.filter(
    (w) =>
      !!w.deleted === trash &&
      w.name.toLowerCase().includes(query.toLowerCase()),
  );
  const focused = worlds.find((w) => w.id === focusId && !w.deleted);
  const joinDialog = joinTarget && (
    <LocalJoinDialog
      initialHostId={joinTarget.hostSessionId}
      onClose={() => setJoinTarget(null)}
      onStart={async args => {
        await onStartJoined(args);
        setJoinTarget(null);
      }}
    />
  );
  const quickDialog = quickWorld && (
    <QuickTestDialog
      world={quickWorld}
      onClose={() => setQuickWorld(null)}
      onStart={async (args) => {
        await onQuickStart(args);
        setFocusId(quickWorld.id);
        setQuickWorld(null);
        await refresh();
      }}
    />
  );
  if (focused)
    return (
      <>
        <WorldDashboard
          key={focused.id}
          world={focused}
          profiles={profiles}
          runtimeState={runtimeState}
          busy={busy}
          onBack={() => setFocusId("")}
          onStart={onStart}
          onQuickTest={() => setQuickWorld(focused)}
          onJoinClient={hostSessionId => setJoinTarget({ hostSessionId })}
          onLogs={onLogs}
          onStop={onStop}
          onSwitchWorld={setFocusId}
          onSettings={() => {
            setFocusId("");
            open("edit", focused);
          }}
        />
        {quickDialog}
        {joinDialog}
      </>
    );
  return (
    <FileDropZone
      className="world-library world-home"
      onFiles={importFiles}
      report={(e) => setError(e.message)}
      disabled={busy || working || running}
      blockWhenModal
      hint="松开以导入存档文件夹或 ZIP"
    >
      <Intro
        title="存档"
        subtitle="每个存档选择自己的启动配置；联机客户端可单独打开游戏。"
      >
        <Button primary disabled={busy} onClick={() => setJoinTarget({ hostSessionId: "" })}>
          启动联机客户端
        </Button>
        <Button primary disabled={busy} onClick={() => open("menu")}>
          启动空白客户端
        </Button>
        <Button
          disabled={busy || !profiles.length}
          onClick={() => open("create")}
        >
          新建存档
        </Button>
        <Button disabled={busy || running} onClick={() => open("import")}>
          导入旧存档
        </Button>
        <Button
          onClick={() =>
            call("worlds.folder").catch((e) => setError(e.message))
          }
        >
          打开存档库
        </Button>
      </Intro>
      <p className="world-import-hint muted">
        将存档文件夹或 ZIP 拖到此页即可导入副本，原文件保留。导入前请退出游戏。
      </p>
      {!profiles.length && (
        <Empty
          title="可直接导入存档并自动匹配配置"
          action={
            <Button primary onClick={onConfigure}>
              新建启动配置
            </Button>
          }
        >
          导入时可自动创建使用存档自带模组的配置，也可以先添加自己的启动配置。
        </Empty>
      )}
      <div className="world-filters">
        <div role="tablist" aria-label="存档分类">
          <button
            role="tab"
            aria-selected={!trash}
            onClick={() => setTrash(false)}
          >
            存档
          </button>
          <button
            role="tab"
            aria-selected={trash}
            onClick={() => setTrash(true)}
          >
            回收站
          </button>
        </div>
        <div className="world-toolbar">
          <input
            aria-label="搜索存档"
            placeholder="搜索存档…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button onClick={refresh}>刷新</Button>
          {trash && (
            <Button
              danger
              disabled={busy || working || !worlds.some((w) => w.deleted)}
              onClick={() => open("empty")}
            >
              清空回收站
            </Button>
          )}
        </div>
      </div>
      <ErrorBox>{!dialog && error}</ErrorBox>
      <div className="world-grid">
        {items.map((w) => {
          const config = profiles.find((p) => p.id === w.profileId),
            active = runtimeState.sessions?.some(
              (s) => s.running && s.worldId === w.id,
            );
          return (
            <article
              className="world-card"
              key={w.id}
              aria-label={"存档 " + w.name}
            >
              <div className="world-cover">
                <Icon name="cube" size={38} />
                <span>
                  {active
                    ? "运行中"
                    : w.deleted
                      ? w.purging
                        ? "删除未完成"
                        : "回收站"
                      : w.copying
                        ? "复制未完成"
                        : w.error
                          ? "需检查"
                          : w.ready
                            ? "已生成"
                            : "首次启动时创建"}
                </span>
              </div>
              <div className="world-card-content">
                <h3>{w.name}</h3>
                <p>启动配置：{config?.name || "请重新选择配置"}</p>
                {!config && !w.deleted && (
                  <p className="muted">
                    原启动配置已不存在；可重新选择，或使用快速测试。
                  </p>
                )}
                {w.embeddedPacks && (
                  <p>
                    地图模组清单：{w.embeddedPacks.behavior.length} 个行为包 ·{" "}
                    {w.embeddedPacks.resource.length} 个资源包（自动加载）
                  </p>
                )}
                <p>
                  {["生存", "创造", "冒险"][w.options?.game_mode ?? w.gameMode]}{" "}
                  ·{" "}
                  {
                    ["有限世界", "无限世界", "超平坦"][
                      w.options?.world_type ?? w.worldType
                    ]
                  }
                </p>
                <small>
                  {w.modifiedAt
                    ? "更新 " + new Date(w.modifiedAt).toLocaleString()
                    : "尚未生成世界数据"}
                </small>
                {w.linkedPath && (
                  <p className="muted break-all">
                    直接使用原目录：{w.linkedPath}
                  </p>
                )}
                <ErrorBox>{w.error}</ErrorBox>
                <div className="world-card-actions">
                  {w.deleted ? (
                    <>
                      <Button
                        disabled={
                          busy || active || working || !!w.purging || !!w.error
                        }
                        onClick={() => open("restore", w)}
                      >
                        恢复存档
                      </Button>
                      <Button
                        danger
                        disabled={busy || active || working || !!w.error}
                        onClick={() => open("purge", w)}
                      >
                        {w.linkedPath
                          ? "移除登记"
                          : w.purging
                            ? "重试永久删除"
                            : "永久删除"}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        primary
                        title={
                          !config
                            ? "请先在存档设置中选择启动配置"
                            : active
                              ? "该存档正在运行"
                              : undefined
                        }
                        disabled={
                          busy ||
                          working ||
                          active ||
                          !config ||
                          !!w.error ||
                          w.copying
                        }
                        onClick={() => {
                          setFocusId(w.id);
                          onStart(w.profileId, w.id);
                        }}
                      >
                        启动此存档
                      </Button>
                      <Button
                        disabled={
                          busy || working || active || !!w.error || w.copying
                        }
                        onClick={() => setQuickWorld(w)}
                      >
                        快速测试
                      </Button>
                      <Button
                        disabled={busy || working || !!w.error || w.copying}
                        onClick={() => setFocusId(w.id)}
                      >
                        {active ? "打开控制台" : "功能配置"}
                      </Button>
                      <Button
                        disabled={busy || working}
                        onClick={() => open("edit", w)}
                      >
                        {config ? "存档设置" : "选择启动配置"}
                      </Button>
                      <Button
                        danger
                        disabled={busy || active || working || !!w.error}
                        title={active ? "请先保存并退出该存档" : undefined}
                        onClick={() => open("delete", w)}
                      >
                        {w.linkedPath ? "移除存档" : "删除存档"}
                      </Button>
                    </>
                  )}
                  <Button
                    onClick={() =>
                      call("worlds.folder", { worldId: w.id }).catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    打开目录
                  </Button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {!items.length && (
        <Empty title={trash ? "回收站为空" : "还没有存档"}>
          {trash
            ? "删除的存档可在这里恢复，也可永久删除以释放空间。"
            : "新建一个世界，或导入已有存档目录。"}
        </Empty>
      )}
      {dialog && (
        <Modal
          busy={working}
          onFiles={
            dialog.kind === "import"
              ? (files) => importFiles(files, false)
              : undefined
          }
          dropReport={(e) => setError(e.message)}
          dropHint="松开以选择存档文件夹或 ZIP"
          title={
            {
              menu: "启动空白客户端",
              create: "新建存档",
              edit: "存档设置",
              import: "导入旧存档",
              delete: dialog.w?.linkedPath ? "移除存档？" : "删除存档？",
              restore: "恢复存档？",
              purge: dialog.w?.linkedPath ? "移除存档登记？" : "永久删除存档？",
              empty: "清空回收站？",
            }[dialog.kind]
          }
          onClose={() => !working && setDialog(null)}
          footer={
            <>
              <Button disabled={working} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button
                primary
                danger={["purge", "empty"].includes(dialog.kind)}
                disabled={
                  working ||
                  (dialog.kind === "menu" && !playerName.trim()) ||
                  (["create", "edit", "import"].includes(dialog.kind) &&
                    !(
                      dialog.kind === "import" &&
                      profileId === AUTO_IMPORT_PROFILE
                    ) &&
                    !profiles.some((p) => p.id === profileId)) ||
                  (dialog.kind === "import" && !source)
                }
                onClick={submit}
              >
                {working
                  ? "处理中…"
                  : {
                      menu: "启动客户端",
                      create: "创建存档",
                      edit: "保存存档设置",
                      import: "开始导入",
                      delete: "移入回收站",
                      restore: "确认恢复",
                      purge: dialog.w?.linkedPath
                        ? "确认移除登记"
                        : "确认永久删除",
                      empty: "确认清空回收站",
                    }[dialog.kind]}
              </Button>
            </>
          }
        >
          <fieldset className="workspace-fieldset" disabled={working}>
            {["purge", "empty"].includes(dialog.kind) && (
              <>
                <p>
                  将永久删除以下 {dialog.targets.length}{" "}
                  个存档的卡片记录。复制导入及新建存档的数据会被永久删除；直接使用原目录的存档只移除登记，原目录及数据保留。此操作无法恢复卡片。
                </p>
                <ul className="purge-targets">
                  {dialog.targets.map((w) => (
                    <li key={w.id}>{w.name}</li>
                  ))}
                </ul>
                {dialog.kind === "empty" && (
                  <p className="muted">
                    包括被搜索条件隐藏的回收站存档。仅由这些存档使用、未经修改的自动匹配配置会一并移除登记；手动配置和模组文件保留。
                  </p>
                )}
              </>
            )}
            {["create", "edit", "import"].includes(dialog.kind) && (
              <Field label="使用启动配置">
                <Select
                  value={profileId}
                  options={[
                    ...(dialog.kind === "import"
                      ? [
                          {
                            value: AUTO_IMPORT_PROFILE,
                            label: AUTO_IMPORT_LABEL,
                          },
                        ]
                      : []),
                    ...profiles.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]}
                  onChange={setProfileId}
                />
                {dialog.kind === "import" && (
                  <>
                    <div className="world-toolbar">
                      <Button
                        icon="plus"
                        onClick={() => {
                          onAddProfile({
                            name,
                            source,
                            profileId,
                            importMode,
                            sourceDirectory,
                          });
                        }}
                      >
                        前去添加配置
                      </Button>
                    </div>
                    {profileId === AUTO_IMPORT_PROFILE && (
                      <small className="muted">
                        导入成功后自动创建并绑定一套独立配置，使用全局游戏程序和存档自带模组；之后可在启动配置页编辑。
                      </small>
                    )}
                  </>
                )}
              </Field>
            )}
            {dialog.kind === "menu" && (
              <>
                <Field label="玩家名字">
                  <div className="world-toolbar">
                    <input
                      autoFocus
                      value={playerName}
                      maxLength={32}
                      onChange={(e) => setPlayerName(e.target.value)}
                    />
                    <Button onClick={() => setPlayerName(randomName())}>
                      随机英文名
                    </Button>
                  </div>
                </Field>
                <p>
                  直接打开游戏菜单，不加载启动配置中的模组。自动选择游戏程序，优先使用正在运行的存档版本；进入游戏后可手动加入联机。
                </p>
              </>
            )}
            {["create", "edit", "import"].includes(dialog.kind) && (
              <Field label="存档名称">
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            )}
            {dialog.kind === "import" && (
              <>
                <Button
                  onClick={() =>
                    call("worlds.pick-import")
                      .then(
                        (value) =>
                          value &&
                          importFiles(
                            [{ path: value, directory: true }],
                            false,
                          ),
                      )
                      .catch((e) => setError(e.message))
                  }
                >
                  选择旧存档目录
                </Button>
                <Button
                  onClick={() =>
                    call("worlds.pick-import", { kind: "zip" })
                      .then(
                        (value) =>
                          value &&
                          importFiles(
                            [{ path: value, directory: false }],
                            false,
                          ),
                      )
                      .catch((e) => setError(e.message))
                  }
                >
                  选择存档 ZIP
                </Button>
                <p className="break-all">
                  {source || "拖入或选择包含 level.dat 的存档文件夹/ZIP"}
                </p>
                <Field label="存档使用方式">
                  <Select
                    value={importMode}
                    disabled={!sourceDirectory}
                    options={[
                      { value: "linked", label: "直接使用原目录（推荐）" },
                      { value: "copy", label: "复制导入（独立副本）" },
                    ]}
                    onChange={setImportMode}
                  />
                </Field>
                <p>
                  {importMode === "linked"
                    ? "游戏直接读写所选存档，进度保存到原目录；移除卡片不会删除原目录。首次启动会将自带模组整理到原目录内的 .toolbox-packs，之后请在该目录编辑。开启配置中的 Python 自动热更新后，保存脚本即可更新已加载代码，也可使用“热更新脚本”按钮。"
                    : "复制或解压到专属存档库，原文件保留。以后请修改副本中的模组，原目录的修改不会同步。ZIP 可包含外层文件夹；一次导入一份存档。"}
                </p>
                <p>
                  地图自带的行为包和资源包会按原加载清单自动启用，无需逐个添加。选择“自动匹配”即可使用这些模组；需要额外模组或其他参数时，可选择自己的配置。
                </p>
              </>
            )}
            {["create", "edit"].includes(dialog.kind) && (
              <>
                <div className="world-form">
                  <Field label="游戏模式">
                    <Select
                      value={options.game_mode}
                      options={["生存", "创造", "冒险"].map((label, value) => ({
                        label,
                        value,
                      }))}
                      onChange={(value) => update("game_mode", value)}
                    />
                  </Field>
                  <Field label="世界类型">
                    <Select
                      disabled={dialog.w?.ready}
                      value={options.world_type}
                      options={["有限世界", "无限世界", "超平坦"].map(
                        (label, value) => ({ label, value }),
                      )}
                      onChange={(value) => update("world_type", value)}
                    />
                  </Field>
                  <Field
                    label="世界种子"
                    hint="留空随机生成；世界生成后不可修改"
                  >
                    <input
                      disabled={dialog.w?.ready}
                      type="number"
                      value={options.world_seed ?? ""}
                      onChange={(e) =>
                        update(
                          "world_seed",
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                  </Field>
                </div>
                <div className="checks">
                  {[
                    ["enable_cheats", "允许作弊"],
                    ["keep_inventory", "死亡不掉落"],
                    ["do_weather_cycle", "天气变化"],
                    ["do_daylight_cycle", "昼夜循环"],
                  ].map(([key, label]) => (
                    <label className="check-row" key={key}>
                      <input
                        type="checkbox"
                        checked={!!options[key]}
                        onChange={(e) => update(key, e.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <details>
                  <summary>实验性世界选项</summary>
                  <div className="checks">
                    {experiments.map(([key, label]) => (
                      <label className="check-row" key={key}>
                        <input
                          type="checkbox"
                          checked={!!options.experiment_options?.[key]}
                          onChange={(e) =>
                            update("experiment_options", {
                              ...options.experiment_options,
                              [key]: e.target.checked,
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </details>
                <p className="muted">
                  世界选项仅用于这个存档，下次启动生效。名称用于卡片显示。
                </p>
              </>
            )}
            {dialog.kind === "delete" && (
              <p>
                {dialog.w.linkedPath
                  ? `将“${dialog.w.name}”的登记移入回收站，可恢复；原目录、游戏进度和模组文件保留。`
                  : `将“${dialog.w.name}”移入库内回收站，可恢复，模组文件保留。`}
                仅由此存档使用、未经修改的自动匹配配置随存档回收，恢复存档时一并恢复。
              </p>
            )}
            {dialog.kind === "restore" && (
              <p>恢复“{dialog.w.name}”及随它回收的自动匹配配置，不覆盖其他存档。</p>
            )}
            <ErrorBox>{error}</ErrorBox>
          </fieldset>
        </Modal>
      )}
      {quickDialog}
      {joinDialog}
    </FileDropZone>
  );
}
