import React, { useEffect, useState } from "react";
import { sharedSources } from "../../../shared/source-sharing.cjs";
import { ReloadActions } from "../debug/debugger.jsx";
import { BIOMES, SHAPES, biomeSummary } from "../../../shared/biome-model.cjs";
import {
  Button,
  Intro,
  Field,
  Select,
  Modal,
  Empty,
  ErrorBox,
  Icon,
} from "../../app/ui.jsx";
const call = (method, args = {}) => window.toolkit.call(method, args);
const types = {
  command: "游戏指令",
  item: "给予物品",
  script: "Python 脚本",
  biome: "设置群系",
};
const presets = [
  { name: "切换白天", command: "/time set day", icon: "activity" },
  { name: "晴朗天气", command: "/weather clear", icon: "refresh" },
  { name: "创造模式", command: "/gamemode creative @s", icon: "cube" },
  { name: "生存模式", command: "/gamemode survival @s", icon: "gamepad" },
];
const fresh = (type = "command") => ({
  id: crypto.randomUUID(),
  name: "",
  type,
  enabled: true,
  auto: false,
  command: "",
  item: "minecraft:diamond",
  count: 1,
  aux: 0,
  code: "",
  target: "server",
  biome: "minecraft:plains",
  shape: "chunk",
  radius: 8,
  length: 16,
  width: 16,
  heightMode: "column",
  minY: -64,
  maxY: 319,
});
function ActionEditor({ value, quick, saving, onSave, onClose, error }) {
  const [draft, setDraft] = useState({ ...fresh(value.type), ...value });
  const [customBiome, setCustomBiome] = useState(
    !!value.biome && !BIOMES.some((b) => b.value === value.biome),
  );
  const change = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Modal
      title={quick ? "即时" + types[draft.type] : "编辑存档功能"}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            primary
            disabled={saving}
            onClick={() =>
              onSave({ ...draft, name: quick ? types[draft.type] : draft.name })
            }
          >
            {saving ? "处理中…" : quick ? "立即执行" : "保存功能"}
          </Button>
        </>
      }
    >
      <fieldset className="workspace-fieldset" disabled={saving}>
        {!quick && (
          <Field label="按钮名称">
            <input
              autoFocus
              value={draft.name}
              maxLength={80}
              onChange={(e) => change("name", e.target.value)}
            />
          </Field>
        )}
        {!quick && (
          <Field label="功能类型">
            <Select
              value={draft.type}
              options={Object.entries(types).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={(v) => change("type", v)}
            />
          </Field>
        )}
        {draft.type === "command" && (
          <Field label="游戏指令">
            <textarea
              autoFocus={quick}
              rows={3}
              value={draft.command}
              maxLength={4096}
              placeholder="/give @s minecraft:diamond 1"
              onChange={(e) => change("command", e.target.value)}
            />
            <small className="muted">
              每个功能一条指令，以房主玩家身份执行；@s 指房主，@a
              会影响所有玩家。输出可在游戏聊天中查看。
            </small>
          </Field>
        )}
        {draft.type === "item" && (
          <>
            <Field label="物品标识符">
              <input
                value={draft.item}
                onChange={(e) => change("item", e.target.value)}
                placeholder="minecraft:diamond 或 模组命名空间:物品名"
              />
            </Field>
            <div className="world-form">
              <Field label="数量">
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={draft.count}
                  onChange={(e) => change("count", Number(e.target.value))}
                />
              </Field>
              <Field label="附加值">
                <input
                  type="number"
                  min={0}
                  max={32767}
                  value={draft.aux}
                  onChange={(e) => change("aux", Number(e.target.value))}
                />
              </Field>
            </div>
            <p className="muted">
              物品发给此存档的房主玩家，支持已加载模组的物品标识符。
            </p>
          </>
        )}
        {draft.type === "script" && (
          <>
            <Field label="脚本执行端">
              <Select
                value={draft.target}
                options={[
                  { value: "server", label: "服务端" },
                  { value: "client", label: "房主客户端" },
                ]}
                onChange={(v) => change("target", v)}
              />
            </Field>
            <Field label="Python 2.7 代码">
              <textarea
                className="action-code"
                rows={10}
                value={draft.code}
                maxLength={16384}
                spellCheck={false}
                onChange={(e) => change("code", e.target.value)}
                placeholder="import mod.server.extraServerApi as api"
              />
            </Field>
            <p className="muted">
              使用游戏 ModSDK，可在 _result
              中返回执行结果。代码可改变存档，请检查后保存。
            </p>
          </>
        )}
        {draft.type === "biome" && (
          <>
            <Field label="目标群系">
              <Select
                value={customBiome ? "custom" : draft.biome}
                options={[
                  ...BIOMES,
                  { value: "custom", label: "其他 / 自定义群系标识符" },
                ]}
                onChange={(v) => {
                  setCustomBiome(v === "custom");
                  if (v !== "custom") change("biome", v);
                }}
              />
            </Field>
            {customBiome && (
              <Field label="群系标识符">
                <input
                  value={draft.biome}
                  maxLength={160}
                  placeholder="minecraft:plains 或 模组命名空间:群系名"
                  onChange={(e) => change("biome", e.target.value)}
                />
              </Field>
            )}
            <Field label="横向范围">
              <Select
                value={draft.shape}
                options={Object.entries(SHAPES).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(v) => change("shape", v)}
              />
            </Field>
            {draft.shape === "circle" && (
              <Field label="半径 R（方块）">
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={draft.radius}
                  onChange={(e) => change("radius", Number(e.target.value))}
                />
              </Field>
            )}
            {draft.shape === "rectangle" && (
              <div className="world-form">
                <Field label="长度 X（方块）">
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={draft.length}
                    onChange={(e) => change("length", Number(e.target.value))}
                  />
                </Field>
                <Field label="宽度 Z（方块）">
                  <input
                    type="number"
                    min={1}
                    max={64}
                    value={draft.width}
                    onChange={(e) => change("width", Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
            <Field label="高度范围">
              <Select
                value={draft.heightMode}
                options={[
                  { value: "column", label: "整列高度" },
                  { value: "range", label: "指定最低 / 最高 Y" },
                ]}
                onChange={(v) => change("heightMode", v)}
              />
            </Field>
            {draft.heightMode === "range" && (
              <div className="world-form">
                <Field label="最低 Y">
                  <input
                    type="number"
                    min={-64}
                    max={319}
                    value={draft.minY}
                    onChange={(e) => change("minY", Number(e.target.value))}
                  />
                </Field>
                <Field label="最高 Y">
                  <input
                    type="number"
                    min={-64}
                    max={319}
                    value={draft.maxY}
                    onChange={(e) => change("maxY", Number(e.target.value))}
                  />
                </Field>
              </div>
            )}
            <p className="muted">
              维度自动取执行时房主所在维度，支持自定义维度
              ID。圆形、矩形以脚下方块为中心；矩形沿世界 X / Z
              轴，偶数边长向负方向多一格。当前区块为脚下所在的 16×16 区块。
            </p>
            <p className="muted">
              整列高度从当前维度实时读取；指定 Y
              为绝对高度。只修改已加载范围的群系，不重新生成地形。旧 2D
              群系会影响整列，原生 3D
              群系的表面高度规则可能影响上方群系；颜色可能需重新进入区域后刷新。
            </p>
            <p className="muted">
              直接调用游戏原生群系接口，工具箱不另存或自动恢复群系。当前开发版只改群系可能在重进后还原，请保存退出后核对实际结果。
            </p>
          </>
        )}
        {!quick && (
          <div className="action-options">
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => change("enabled", e.target.checked)}
              />
              启用此功能
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.auto}
                onChange={(e) => change("auto", e.target.checked)}
              />
              每次启动存档，玩家就绪后自动执行一次
            </label>
          </div>
        )}
        {!quick && (
          <p className="muted">
            自动功能按卡片顺序执行；失败时停止后续操作。运行期间修改将在下次启动生效，重载和重连不会重复执行。
          </p>
        )}
        <ErrorBox>{error}</ErrorBox>
      </fieldset>
    </Modal>
  );
}
export function WorldDashboard({
  world,
  profiles,
  runtimeState,
  onBack,
  onStart,
  onQuickTest,
  onPacks,
  onMapPreview,
  onJoinClient,
  onSettings,
  onLogs,
  onStop,
  onSwitchWorld,
  onEditProfile,
  busy,
  mode = "all",
  sessionId,
}) {
  const [config, setConfig] = useState(null),
    [runtime, setRuntime] = useState({ history: [] }),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [editing, setEditing] = useState(null),
    [dialogError, setDialogError] = useState(""),
    [remove, setRemove] = useState(null);
  const session = runtimeState.sessions?.findLast(
    (s) => s.worldId === world.id && (!sessionId || s.id === sessionId),
  );
  const profile = profiles.find((p) => p.id === world.profileId);
  useEffect(() => {
    let active = true,
      timer;
    setRuntime({ history: [] });
    call("world-actions.read", { worldId: world.id })
      .then((v) => {
        if (active) {
          setConfig(v);
          setRuntime(v.runtime);
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => {
        if (active) timer = setTimeout(poll, 900);
      });
    const poll = async () => {
      try {
        const v = await call("world-actions.state", { worldId: world.id });
        if (active) setRuntime(v);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(poll, 900);
      }
    };
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [world.id, session?.id, session?.running]);
  const ready =
    !!session?.running && runtime.sessionId === session.id && runtime.ready;
  const blocked =
    !session?.running ||
    runtime.sessionId !== session.id ||
    !ready ||
    runtime.busy ||
    working ||
    ["waiting", "running"].includes(runtime.phase);
  async function persist(actions) {
    const v = await call("world-actions.save", {
      worldId: world.id,
      revision: config.revision,
      actions,
    });
    setConfig(v);
  }
  async function saveAction(action) {
    setWorking(true);
    setDialogError("");
    try {
      if (editing.quick) {
        await run({ quick: action });
      } else {
        const exists = config.actions.some((a) => a.id === action.id);
        await persist(
          exists
            ? config.actions.map((a) => (a.id === action.id ? action : a))
            : [...config.actions, action],
        );
      }
      setEditing(null);
    } catch (e) {
      setDialogError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function run(args) {
    const result = await call("world-actions.run", {
      worldId: world.id,
      sessionId: runtime.sessionId,
      target: runtime.target,
      ...args,
    });
    setRuntime(await call("world-actions.state", { worldId: world.id }));
    return result;
  }
  async function perform(fn) {
    setWorking(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  const open = (value, quick = false) => {
    setDialogError("");
    setEditing({ value, quick });
  };
  const move = (index, direction) =>
    perform(async () => {
      const list = [...config.actions];
      [list[index], list[index + direction]] = [
        list[index + direction],
        list[index],
      ];
      await persist(list);
    });
  return (
    <div className="world-dashboard">
      {mode === "settings" && <div><h2>自定义与启动操作</h2><p className="muted">保存影响下次启动；即时执行请进入会话控制台。</p></div>}
      {(mode === "all" || mode === "overview") && <>
      {mode === "all" &&
      <Intro
        heading
        title={mode === "overview" ? "存档概览" : mode === "settings" ? "自定义与启动操作" : "存档控制台"}
        subtitle="管理当前存档，执行即时操作，设置自己的常用功能。"
      >
        <Button icon="arrow" onClick={onBack}>
          返回存档列表
        </Button>
      </Intro>
      }
      {runtimeState.sessions?.some(
        (s) => s.running && s.worldId !== world.id && s.worldId,
      ) && (
        <div className="world-host-switcher" aria-label="运行中的存档主机">
          {runtimeState.sessions
            .filter((s) => s.running && s.worldId)
            .map((s) => (
              <Button
                key={s.id}
                primary={s.worldId === world.id}
                aria-pressed={s.worldId === world.id}
                title={`${s.worldName || s.profileName} · ${s.userName || "房主"} · 启动器 PID ${s.pid}`}
                onClick={() => onSwitchWorld?.(s.worldId)}
              >
                {s.worldName || s.profileName}
              </Button>
            ))}
        </div>
      )}
      <section className="world-summary" aria-label="存档信息">
        <div className="world-summary-icon">
          <Icon name="archive" size={36} />
        </div>
        <div className="world-summary-copy">
          <span className="muted">存档信息</span>
          <h2>{mode === "overview" ? "运行概况" : world.name}</h2>
          <p>
            {session?.running
              ? session.profileName
              : profile?.name || "未绑定启动配置"}{" "}
            ·{" "}
            {
              ["生存", "创造", "冒险"][
                world.options?.game_mode ?? world.gameMode
              ]
            }{" "}
            ·{" "}
            {
              ["有限世界", "无限世界", "超平坦"][
                world.options?.world_type ?? world.worldType
              ]
            }
          </p>
          {mode === "overview" && profile && onEditProfile && <Button icon="launch-profile" title={"编辑绑定配置：" + profile.name} onClick={onEditProfile} disabled={busy}>编辑绑定启动配置</Button>}
          <small className="muted">
            {session?.running
              ? `${session.storageMode === "isolated" ? "独立主机" : "兼容主机"} · 房主 ${session.userName || "—"} · 启动器 PID ${session.pid}`
              : "可在启动前设置自动操作和自定义按钮"}
          </small>
          {session?.running && session.storageMode !== "isolated" && session.isolationReason && (
            <p className="muted">单主机运行：{session.isolationReason}</p>
          )}
        </div>
        <div className="world-summary-controls">
          <span className={`action-status ${ready ? "ready" : ""}`}>
            {session?.running
              ? ready
                ? "调试已就绪"
                : "等待进入存档"
              : "未运行"}
          </span>
          <div className="world-toolbar">
            {session?.running ? (
              <>
                <Button onClick={() => onLogs(session.id)}>查看日志</Button>
                <Button
                  danger
                  disabled={busy}
                  onClick={() => onStop(session.id)}
                >
                  停止会话
                </Button>
              </>
            ) : (
              mode === "overview" ? null : <Button
                primary
                title={!profile ? "请先选择启动配置" : undefined}
                disabled={
                  busy ||
                  !profile ||
                  runtimeState.sessions?.some(
                    (s) => s.running && s.worldId === world.id,
                  )
                }
                onClick={() => onStart(world.profileId, world.id)}
              >
                启动此存档
              </Button>
            )}
            <Button disabled={busy} onClick={onSettings}>
              {profile ? "存档设置" : "选择启动配置"}
            </Button>
            {session?.running && (
              <Button disabled={busy || !ready} onClick={() => onJoinClient(session.id)}>
                加入此存档测试
              </Button>
            )}
            <Button disabled={busy} icon="image" onClick={onMapPreview}>
              地图预览
            </Button>
            <Button disabled={busy || !!session?.running} onClick={onQuickTest}>
              快速测试
            </Button>
            <Button onClick={onPacks}>存档模组</Button>
            <Button
              onClick={() =>
                perform(() => call("worlds.folder", { worldId: world.id }))
              }
            >
              打开目录
            </Button>
          </div>
        </div>
      </section>
      </>}
      {!profile && !session?.running && (
        <p className="world-hint">
          原启动配置已不存在，请点击“选择启动配置”重新绑定后启动。
        </p>
      )}
      <ErrorBox>{error}</ErrorBox>
      {working && <p className="muted" role="status">正在处理存档功能…</p>}
      {session && mode !== "settings" && mode !== "overview" && (
        <ReloadActions
          context={runtime.reloadTarget || {}}
          ready={!!ready && !blocked}
        />
      )}
      {session?.running &&
        sharedSources(
          session.sourceRoots,
          runtimeState.sessions || [],
          session.id,
        ).length > 0 && (
          <div className="world-hint">
            此主机与其他会话共用源码目录。修改这些文件会影响所有使用它的会话；需要分别修改时，请使用独立目录或工作副本。
            <ul>
              {sharedSources(
                session.sourceRoots,
                runtimeState.sessions || [],
                session.id,
              ).map((s, i) => (
                <li key={i}>
                  {s.name}：{s.path}
                </li>
              ))}
            </ul>
          </div>
        )}
      {mode !== "overview" && <>
      {mode !== "settings" && <>
      <div className="action-section-title">
        <h2>即时功能</h2>
        <span className="muted">
          作用于当前存档的房主；启动时自动加载开发辅助模组
        </span>
      </div>
      {!ready && (
        <p className="world-hint">
          {runtime.reason || runtime.message || "等待调试连接"}
        </p>
      )}
      <div className="quick-action-grid">
        <Button
          icon="terminal"
          disabled={blocked}
          onClick={() => open(fresh("command"), true)}
        >
          执行指令
        </Button>
        <Button
          icon="cube"
          disabled={blocked}
          onClick={() => open(fresh("item"), true)}
        >
          给予物品
        </Button>
        {presets.map((p) => (
          <Button
            key={p.name}
            icon={p.icon}
            disabled={blocked}
            onClick={() => perform(() => run({ quick: { ...fresh(), ...p } }))}
          >
            {p.name}
          </Button>
        ))}
        <Button
          icon="cube"
          disabled={blocked}
          onClick={() => open(fresh("biome"), true)}
        >
          设置群系
        </Button>
      </div>
      </>}
      <div className="action-section-title">
        <div>
          <h2>自定义功能</h2>
          <span className="muted">
            {config?.actions.length || 0} / 64 个 ·
            自动执行顺序从左到右、从上到下
          </span>
        </div>
        <Button
          primary
          icon="plus"
          disabled={!config || working || config.actions.length >= 64}
          onClick={() => open(fresh())}
        >
          添加功能
        </Button>
      </div>
      <div className="world-hint action-auto-state">
        <span>{runtime.message || "自动操作将在存档玩家就绪后执行"}</span>
        {runtime.phase === "waiting" && (
          <Button
            onClick={() =>
              perform(() =>
                call("world-actions.cancel", { sessionId: runtime.sessionId }),
              )
            }
          >
            取消本次自动执行
          </Button>
        )}
      </div>
      <div className="custom-action-grid">
        {config?.actions.map((a, index) => (
          <article
            key={a.id}
            className={`custom-action-card ${a.enabled ? "" : "disabled"}`}
            aria-label={"功能 " + a.name}
          >
            <div className="action-card-top">
              <Icon
                name={
                  a.type === "item"
                    ? "cube"
                    : a.type === "script"
                      ? "tools"
                      : "terminal"
                }
                size={23}
              />
              <span>
                {types[a.type]}
                {a.type === "script"
                  ? a.target === "client"
                    ? " · 客户端"
                    : " · 服务端"
                  : ""}
              </span>
              <span className="action-order">{index + 1}</span>
            </div>
            <h3>{a.name}</h3>
            <p
              className="action-preview"
              title={
                a.type === "biome"
                  ? biomeSummary(a)
                  : a.command || a.item || a.code
              }
            >
              {a.type === "biome"
                ? biomeSummary(a)
                : a.type === "item"
                  ? `${a.item} × ${a.count}`
                  : a.command || a.code}
            </p>
            <span className="action-mode">
              {!a.enabled
                ? "已停用"
                : a.auto
                  ? "进存档自动执行一次 · 也可手动执行"
                  : "手动点击执行"}
            </span>
            <div className="action-card-footer">
              <Button
                primary
                disabled={mode === "settings" || blocked || !a.enabled}
                onClick={() => perform(() => run({ actionId: a.id }))}
              >
                执行
              </Button>
              <Button disabled={working} onClick={() => open(a)}>
                编辑
              </Button>
              <Button
                disabled={working}
                onClick={() =>
                  perform(() =>
                    persist(
                      config.actions.map((v) =>
                        v.id === a.id ? { ...v, enabled: !v.enabled } : v,
                      ),
                    ),
                  )
                }
              >
                {a.enabled ? "停用" : "启用"}
              </Button>
              <Button
                icon="up"
                aria-label={"上移 " + a.name}
                disabled={working || index === 0}
                onClick={() => move(index, -1)}
              />
              <Button
                icon="down"
                aria-label={"下移 " + a.name}
                disabled={working || index === config.actions.length - 1}
                onClick={() => move(index, 1)}
              />
              <Button
                icon="close"
                aria-label={"删除 " + a.name}
                disabled={working}
                onClick={() => setRemove(a)}
              />
            </div>
          </article>
        ))}
      </div>
      {config && !config.actions.length && (
        <Empty title="添加你的第一个功能按钮">
          例如领取测试物品、切换时间，或执行自己的 ModSDK
          脚本。勾选自动执行后，下次启动存档会按顺序执行。
        </Empty>
      )}
      <div className="action-section-title">
        <h2>本次会话执行记录</h2>
        <span className="muted">保留最近 100 条，结果同时写入脚本日志</span>
      </div>
      <div className="action-history" aria-live="polite">
        {runtime.history?.length ? (
          runtime.history.map((h) => (
            <details key={h.id} className={"action-result " + h.status}>
              <summary>
                <span>
                  {h.status === "success"
                    ? "成功"
                    : h.status === "error"
                      ? "失败"
                      : "执行中"}
                </span>
                <strong>{h.name}</strong>
                <small>
                  {h.automatic ? "自动" : "手动"} ·{" "}
                  {new Date(h.at).toLocaleTimeString()}
                </small>
              </summary>
              <pre>{h.message}</pre>
            </details>
          ))
        ) : (
          <p className="muted">暂无执行记录</p>
        )}
      </div>
      {editing && (
        <ActionEditor
          value={editing.value}
          quick={editing.quick}
          saving={working}
          error={dialogError}
          onSave={saveAction}
          onClose={() => !working && setEditing(null)}
        />
      )}
      {remove && (
        <Modal
          title="删除功能按钮？"
          busy={working}
          onClose={() => !working && setRemove(null)}
          footer={
            <>
              <Button disabled={working} onClick={() => setRemove(null)}>
                取消
              </Button>
              <Button
                danger
                disabled={working}
                onClick={() => {
                  const action = remove;
                  setRemove(null);
                  perform(() =>
                    persist(config.actions.filter((a) => a.id !== action.id)),
                  );
                }}
              >
                确认删除功能
              </Button>
            </>
          }
        >
          <p>
            删除“{remove.name}
            ”的按钮及下次启动配置。本次启动已保存的自动操作不受影响，可在上方取消尚未开始的自动执行。
          </p>
          <ErrorBox>{error}</ErrorBox>
        </Modal>
      )}
      </>}
    </div>
  );
}
