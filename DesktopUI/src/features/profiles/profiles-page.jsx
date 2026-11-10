import React, { useEffect, useState } from "react";
import {
  Button,
  Intro,
  Field,
  Empty,
  Icon,
  PathField,
  Section,
  Modal,
  ErrorBox,
} from "../../app/ui.jsx";
import { GameDiscovery, ConfigExtras } from "../settings/config-extras.jsx";
import "./profiles.css";
import { ModSelector } from "../mods/mod-library.jsx";
import { useWorkspaceState } from "../../app/workspaces.jsx";
export function ProfilesPage({
  profiles,
  snapshot,
  form,
  raw,
  setRaw,
  advanced,
  setAdvanced,
  dirty,
  busy,
  onSelect,
  onCreated,
  onProfiles,
  change,
  save,
  report,
  onReload,
  onStart,
  runtimeState,
  onManageMods,
  onGlobalSettings,
  globalGamePath = "",
  createRequest,
  onCreateRequestHandled,
  onNewProfile,
  onReturnToImport,
  openRequest,
  onOpenRequestHandled,
  originWorldName,
  onReturnToWorld,
}) {
  const [dialog, setDialog] = useState(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [editing, setEditing] = useState(false),
    [target, setTarget] = useState(null),
    [query, setQuery] = useWorkspaceState("profile-query", ""),
    [summaries, setSummaries] = useState({});
  const [customGame, setCustomGame] = useState(!!form?.game_executable_path);
  useEffect(() => {
    if (openRequest?.profileId !== snapshot?.project.id || !openRequest) return;
    setEditing(true);
    onOpenRequestHandled?.();
  }, [openRequest?.id, snapshot?.project.id]);
  useEffect(() => {
    if (createRequest && !dirty && !busy && !working) {
      edit("new");
      onCreateRequestHandled();
    }
  }, [createRequest, dirty, busy, working]);
  useEffect(() => {
    setCustomGame(!!form?.game_executable_path?.trim());
  }, [snapshot]);
  const call = (method, args) => window.toolkit.call(method, args);
  useEffect(() => {
    let active = true;
    Promise.all(
      profiles.map(async (p) => {
        try {
          return [p.id, await call("project.read", { id: p.id })];
        } catch (e) {
          return [p.id, { error: e.message }];
        }
      }),
    ).then((values) => {
      if (active) setSummaries(Object.fromEntries(values));
    });
    return () => {
      active = false;
    };
  }, [profiles, snapshot]);
  function edit(kind, profile = snapshot?.project) {
    setTarget(profile);
    setName(
      kind === "new"
        ? "新的启动配置"
        : kind === "copy"
          ? profile.name + " 副本"
          : profile.name,
    );
    setError("");
    setDialog(kind);
  }
  async function submit() {
    setWorking(true);
    setError("");
    const action = dialog,
      selected = target;
    setDialog(null);
    try {
      if (action === "new" || action === "copy") {
        const value = await call("profiles.create", {
          name,
          copyId: action === "copy" ? selected.id : undefined,
        });
        onProfiles(await call("profiles.list"));
        onCreated(value);
        if (action === "new") onNewProfile?.(value.project);
        setAdvanced(false);
        setEditing(true);
      } else if (action === "rename") {
        onProfiles(await call("profiles.rename", { id: selected.id, name }));
        if (snapshot?.project.id === selected.id)
          onCreated(await call("project.read", { id: selected.id }));
      } else {
        const list = await call("profiles.remove", { id: selected.id });
        onProfiles(list);
        if (snapshot?.project.id === selected.id) onCreated(null);
        setEditing(false);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <Intro
        heading={!!(editing && snapshot)}
        title={editing && snapshot ? snapshot.project.name : "启动配置"}
        subtitle={
          editing
            ? "修改用于下一次启动；世界参数在存档设置中管理。"
            : "每张卡片是一套独立配置，可直接编辑、复制或启动联机客户端。"
        }
      >
        {onReturnToWorld && <Button disabled={busy || working} title={"返回 " + originWorldName} onClick={onReturnToWorld}>返回来源存档</Button>}
        {onReturnToImport && (
          <Button disabled={busy || working} onClick={onReturnToImport}>
            返回导入存档
          </Button>
        )}
        {editing ? (
          <Button disabled={busy || working} onClick={() => setEditing(false)}>
            返回配置卡片
          </Button>
        ) : (
          <Button
            disabled={busy || dirty || working}
            onClick={() => edit("new")}
          >
            新建配置
          </Button>
        )}
      </Intro>
      <ErrorBox>{!dialog && error}</ErrorBox>
      {onReturnToWorld && <p className="muted">来自存档“{originWorldName}”。此启动配置可能被其他存档共用；保存影响后续启动，返回不会自动保存或丢弃草稿。</p>}
      {working && <p className="muted" role="status">正在处理启动配置…</p>}
      {createRequest && dirty && (
        <p className="world-hint">
          请先保存当前配置的未保存修改，再继续新建配置；导入的地图路径和名称已保留。
        </p>
      )}
      {!editing && (
        <div className="profile-library">
          <div className="profiles-toolbar">
            <input
              aria-label="搜索启动配置"
              placeholder="搜索启动配置…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted">共 {profiles.length} 套配置</span>
          </div>
          {dirty && (
            <p className="world-hint">
              “{snapshot.project.name}
              ”有未保存修改，点击编辑可继续。保存后可新建、复制或删除配置。
            </p>
          )}
          <div className="profile-grid">
            {profiles
              .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((p) => {
                const summary =
                  snapshot?.project.id === p.id ? snapshot : summaries[p.id];
                const config = summary?.config;
                const mods = config?.included_mod_dirs || [];
                const enabled = mods.filter(
                  (m) => typeof m === "string" || m.enabled !== false,
                ).length;
                const running =
                  runtimeState.sessions?.filter(
                    (s) => s.running && s.projectId === p.id,
                  ).length || 0;
                const draft = dirty && snapshot?.project.id === p.id;
                return (
                  <article
                    key={p.id}
                    className="profile-card"
                    data-state={draft ? "warning" : running ? "running" : "ready"}
                    aria-label={"启动配置 " + p.name}
                  >
                    <div className="profile-cover">
                      <Icon name="settings" size={28} />
                      <span>
                        {draft
                          ? "有未保存修改"
                          : running
                            ? `${running} 个游戏运行中`
                            : "启动配置"}
                      </span>
                    </div>
                    <div className="profile-content">
                      <h2>{p.name}</h2>
                      {config ? (
                        <dl>
                          <div>
                            <dt>玩家</dt>
                            <dd>{config.user_name || "未设置"}</dd>
                          </div>
                          <div>
                            <dt>游戏</dt>
                            <dd
                              title={
                                config.game_executable_path || globalGamePath
                              }
                            >
                              {(config.game_executable_path || globalGamePath)
                                ? `${config.game_executable_path ? "独立" : "全局"} · ${(config.game_executable_path || globalGamePath).split(/[\\/]/).slice(-2).join(" / ")}`
                                : "尚未设置游戏程序"}
                            </dd>
                          </div>
                          <div>
                            <dt>模组</dt>
                            <dd>
                              启用 {enabled} / {mods.length} 个目录
                            </dd>
                          </div>
                        </dl>
                      ) : (
                        <p className="muted">
                          {summary
                            ? "配置需要修复，点击编辑查看"
                            : "正在读取配置…"}
                        </p>
                      )}
                      <ErrorBox>{summary?.error}</ErrorBox>
                      <div className="profile-actions">
                        <Button
                          primary
                          disabled={busy || working}
                          onClick={() => onSelect(p.id, () => setEditing(true))}
                        >
                          编辑配置
                        </Button>
                        <Button
                          disabled={
                            busy ||
                            working ||
                            runtimeState.starting ||
                            !config ||
                            !(config.game_executable_path || globalGamePath)
                          }
                          onClick={() => onStart(p.id)}
                        >
                          启动客户端
                        </Button>
                        <Button
                          icon="copy" compact
                          disabled={busy || working || dirty || !config}
                          onClick={() => edit("copy", p)}
                        >
                          复制配置
                        </Button>
                        <Button
                          icon="edit" compact
                          disabled={busy || working || dirty}
                          onClick={() => edit("rename", p)}
                        >
                          重命名
                        </Button>
                        <Button
                          icon="trash" compact
                          danger
                          disabled={
                            busy ||
                            working ||
                            dirty ||
                            !!running ||
                            runtimeState.starting
                          }
                          onClick={() => edit("remove", p)}
                        >
                          删除配置
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })}
          </div>
          {!profiles.length && (
            <Empty title="还没有启动配置">
              新建一套配置，设置游戏程序和需要加载的模组。
            </Empty>
          )}
          {!!profiles.length &&
            !profiles.some((p) =>
              p.name.toLowerCase().includes(query.toLowerCase()),
            ) && <Empty title="没有匹配的启动配置">试试其他名称。</Empty>}
        </div>
      )}
      {editing && snapshot && (
        <>
          <ErrorBox>{snapshot.error}</ErrorBox>
          <div className="toolbar">
            <Button
              primary
              disabled={
                busy ||
                !dirty ||
                (!advanced && customGame && !form?.game_executable_path)
              }
              onClick={save}
            >
              保存配置
            </Button>
            <Button
              disabled={busy || !form || dirty}
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? "基本配置" : "完整配置 JSON"}
            </Button>
            <Button disabled={busy} onClick={onReload}>
              重新载入
            </Button>
            <span className="muted">
              {dirty ? "有未保存修改" : "已保存"} · 修改用于下一次启动
            </span>
          </div>
          <fieldset className="workspace-fieldset" disabled={busy}>
            {advanced || !form ? (
              <Field
                label="完整启动配置 JSON"
                hint="保留未知字段和注释；世界参数请在存档设置中编辑。旧 debug_options 按键保留在文件中，启动时统一使用全局设置。"
              >
                <textarea
                  className="config-source"
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  spellCheck={false}
                />
              </Field>
            ) : (
              <>
                <ModSelector
                  form={form}
                  change={change}
                  snapshot={snapshot}
                  onManage={onManageMods}
                  busy={busy}
                />
                <Section title="游戏与玩家">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={!customGame}
                      onChange={(e) => {
                        setCustomGame(!e.target.checked);
                        change(
                          "game_executable_path",
                          e.target.checked ? "" : globalGamePath,
                        );
                      }}
                    />
                    使用全局游戏程序
                  </label>
                  {!customGame ? (
                    <>
                      <p className="muted break-all">
                        {globalGamePath ||
                          "尚未设置全局游戏程序，请先到设置中选择。"}
                      </p>
                      <Button onClick={onGlobalSettings}>
                        打开全局游戏设置
                      </Button>
                    </>
                  ) : (
                    <>
                      <PathField
                        label="游戏程序"
                        kind="executable"
                        value={form.game_executable_path}
                        onChange={(value) =>
                          change("game_executable_path", value)
                        }
                      />
                      <GameDiscovery
                        value={form.game_executable_path}
                        change={(value) =>
                          change("game_executable_path", value)
                        }
                        report={report}
                      />
                    </>
                  )}
                  <Field label="玩家名称">
                    <input
                      value={form.user_name}
                      onChange={(e) => change("user_name", e.target.value)}
                    />
                  </Field>
                </Section>
                <Section title="调试与热更新">
                  <p className="muted">
                    开发辅助模组由工具箱自动加载，用于存档功能、代码执行和调试，无需手动开启。
                    以下自动热更新开关也适用于存档自带模组；关闭自动更新后仍可使用“热更新脚本”按钮。
                  </p>
                  <div className="checks">
                    {[
                      ["auto_hot_reload_mods", "自动热更新 Python 模组"],
                      ["auto_hot_reload_ui", "自动热更新 JSON UI"],
                    ].map(([key, label]) => (
                      <label className="check-row" key={key}>
                        <input
                          type="checkbox"
                          checked={form[key]}
                          onChange={(e) => change(key, e.target.checked)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </Section>
                <ConfigExtras form={form} change={change} profileOnly />
                <Section
                  title="热更新快捷键"
                  description="快捷键统一在工具箱全局设置中管理，所有启动配置共用。"
                >
                  <Button onClick={onGlobalSettings}>打开全局热更新设置</Button>
                </Section>
              </>
            )}
          </fieldset>
        </>
      )}
      {dialog && (
        <Modal
          title={
            {
              new: "新建启动配置",
              copy: "复制启动配置",
              rename: "重命名配置",
              remove: "删除启动配置？",
            }[dialog]
          }
          onClose={() => !working && setDialog(null)}
          footer={
            <>
              <Button disabled={working} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button
                primary
                disabled={working || (dialog !== "remove" && !name.trim())}
                onClick={submit}
              >
                {working ? "处理中…" : "确认"}
              </Button>
            </>
          }
        >
          {dialog === "remove" ? (
            <p>
              从配置列表删除“{target.name}
              ”。存档和模组文件保留，绑定它的存档需重新选择配置。配置文件也会保留在工具箱数据目录。
            </p>
          ) : (
            <Field label="配置名称">
              <input
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
          <ErrorBox>{error}</ErrorBox>
        </Modal>
      )}
    </>
  );
}
