import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Intro,
  Section,
  Field,
  Modal,
  ErrorBox,
  Empty,
  FileDropZone,
  Icon,
} from "../../app/ui.jsx";
import { modRows, setModOption } from "../../../shared/mod-selection.cjs";
import { groupMods } from "../../../shared/mod-groups.cjs";
import "./mod-library.css";
import { useWorkspaceState } from "../../app/workspaces.jsx";

const studioKey = (value) => String(value || "").toLowerCase();
function studioMod(mod, studio) {
  return (studio?.mods || []).find((item) => studioKey(item.directory) === studioKey(mod?.path)) || null;
}
const call = (method, args = {}) => window.toolkit.call(method, args);
export function ModLibraryPage({ onRemoved, onOpenContent }) {
  return (
    <>
      <Intro
        title="全局模组库"
        subtitle="集中登记模组目录，编辑启动配置时可直接勾选。移出模组时同步清理各套配置中的对应条目。"
      />
      <ModCatalog onRemoved={onRemoved} onOpenContent={onOpenContent} />
    </>
  );
}

const contentTypes = [
  ["item", "物品"], ["block", "方块"], ["entity", "实体"], ["model", "模型"],
  ["texture", "贴图"], ["animation", "动画"], ["particle", "粒子"], ["script", "脚本"],
  ["ui", "界面"], ["data", "数据"],
];

export function ModWorkspacePage({ onRemoved, onOpenContent }) {
  return <ModLibraryPage onRemoved={onRemoved} onOpenContent={onOpenContent} />;
}

function PackFields({ worldId, revision, pack, onSaved, file = false }) {
  const [name, setName] = useState(pack.name || "");
  const [version, setVersion] = useState(Array.isArray(pack.version) ? pack.version.join(".") : "");
  const [enabled, setEnabled] = useState(!!pack.enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const save = async () => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) { setMessage("版本须为三个整数，例如 1.0.0"); return; }
    setSaving(true); setMessage("");
    try {
      const numbers = version.split(".").map(Number);
      if (file) await call("content.save-manifest", { directory: pack.path, manifestFile: pack.manifestFile, name, version: numbers, worldId });
      else await call("worlds.edit-pack", { worldId, packId: pack.packId, confirmed: true, revision, values: { name, version: numbers, enabled } });
      setMessage("已保存");
      onSaved?.();
    } catch (e) { setMessage(e.message); }
    finally { setSaving(false); }
  };
  return <fieldset className="content-pack-fields" disabled={saving || (!file && !revision)}>
    <strong>{pack.kind === "behavior" ? "行为包" : "资源包"}</strong>
    <input aria-label={(pack.kind === "behavior" ? "行为包" : "资源包") + "名称"} value={name} maxLength={80} onChange={e => setName(e.target.value)} />
    <input aria-label={(pack.kind === "behavior" ? "行为包" : "资源包") + "版本"} value={version} onChange={e => setVersion(e.target.value)} />
    {!file && <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />列入清单</label>}
    <Button disabled={saving || (!file && !revision)} onClick={save}>{saving ? "保存中…" : "保存"}</Button>
    {message && <small>{message}</small>}
  </fieldset>;
}

export function ContentBrowserV2({ onManage, request, onEditModel }) {

  const fromWorld = !!request?.worldId;
  const scope = `content:${request?.worldId || "global"}:${request?.sourceId || ""}`;
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useWorkspaceState(scope + ":query", ""), [type, setType] = useWorkspaceState(scope + ":type", ""), [source, setSource] = useWorkspaceState(scope + ":source", request?.sourceId || ""), [packId, setPackId] = useState(request?.packId || ""), [packHealth, setPackHealth] = useState(null), [selected, setSelected] = useWorkspaceState(scope + ":selected", null), [showIssues, setShowIssues] = useState(false);
  const catalog = packHealth?.packs || [];
  const scan = async (nextPackId = packId) => {
    setBusy(true); setError("");
    try {
      const args = request?.worldId ? { worldId: request.worldId } : {};
      if (request?.worldId && nextPackId) args.packId = nextPackId;
      setData(await call("content.scan", args));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { scan(packId); }, [request?.worldId, packId]);
  useEffect(() => {
    if (!request?.worldId) return undefined;
    let live = true;
    call("worlds.inspect-pack-health", { worldId: request.worldId }).then(health => { if (live) setPackHealth(health); }).catch(() => {});
    return () => { live = false; };
  }, [request?.worldId]);
  useEffect(() => {
    if (!fromWorld || !catalog.length || !packId || String(packId).includes(",")) return;
    const owner = groupMods(catalog).find(mod => mod.packIds.includes(packId));
    if (owner && owner.packIds.length > 1) setPackId(owner.packIds.join(","));
  }, [catalog, fromWorld, packId]);
  const summary = data?.summary || {};
  const { rows, searchText } = useMemo(() => {
    const entries = data?.entries || [], semanticSourceIds = new Set(entries.map(entry => entry.sourceAssetId));
    const rows = [...entries, ...(data?.assets || []).filter(asset => !semanticSourceIds.has(asset.id) || !["item", "block", "entity", "model", "animation"].includes(asset.type))];
    return { rows, searchText: rows.map(asset => `${asset.label} ${asset.displayName || ""} ${asset.identifier || ""} ${asset.relative} ${(asset.identifiers || []).join(" ")}`.toLowerCase()) };
  }, [data]);
  const needle = query.trim().toLowerCase();
  const assets = useMemo(() => rows.filter((asset, index) => (!type || asset.type === type) && (fromWorld || !source || asset.sourceId === source) && (fromWorld || !packId || asset.packId === packId) && (!needle || searchText[index].includes(needle))), [rows, searchText, type, source, packId, needle, fromWorld]);
  const sourceRows = data?.sources || [];
  const typeLabel = key => contentTypes.find(item => item[0] === key)?.[1] || key;
  const clear = () => { setQuery(""); setType(""); if (!fromWorld) { setSource(""); setPackId(""); } };
  const worldMods = fromWorld ? (catalog.length ? groupMods(catalog) : (request?.packId ? [{ name: request.packName || "当前模组", packIds: String(request.packId).split(",").filter(Boolean) }] : [])) : [];
  const chosen = worldMods.find(mod => mod.packIds.join(",") === packId || (packId && !String(packId).includes(",") && mod.packIds.includes(packId)));
  const libraryMods = !fromWorld && request?.sourceId ? groupMods((data?.packs || []).filter(pack => pack.sourceId === request.sourceId).map(pack => ({
    ...pack, packId: pack.id, packName: String(pack.path || "").split(/[\\/]/).pop(),
  }))) : [];
  const issueLabel = issue => issue.code === "duplicate-identifier" ? "标识符重复" : issue.code === "invalid-json" ? "JSON 无法解析" : issue.code === "source-missing" ? "来源不可用" : "扫描提示";
  useEffect(() => {
    if (!assets.length) { setSelected(null); return; }
    const match = assets.find(asset => asset.id === selected?.id) || assets[0];
    if (selected !== match) setSelected(match);
  }, [data, type, source, packId, query]);
  return <section className="content-workbench content-workbench-v2">
    <header className="content-workbench-header"><div><span className="content-eyebrow">CONTENT WORKBENCH</span><h2>{fromWorld ? (request.worldName || "存档模组") : (request?.sourceName || "模组内容")}</h2><p>{fromWorld ? "一个模组包含它的行为包和资源包。选全部则查看这个存档里的所有模组。" : (request?.sourceName || "按内容查看这个模组，文件只是来源证据。")}</p></div><div className="content-workbench-actions">{fromWorld && <label className="content-pack-picker">模组<select aria-label="存档模组" value={chosen ? chosen.packIds.join(",") : ""} disabled={busy} onChange={e => setPackId(e.target.value)}><option value="">全部</option>{worldMods.map(mod => <option key={mod.packIds.join(",")} value={mod.packIds.join(",")}>{mod.name}</option>)}</select></label>}<Button primary disabled={busy} onClick={() => scan()}>{busy ? "扫描中…" : "重新扫描"}</Button><Button disabled={busy} onClick={onManage}>{request?.returnTo === "launch" ? "返回存档" : "返回模组目录"}</Button></div></header>
    {fromWorld && chosen && <div className="content-mod-info">
      {chosen.behavior && <PackFields key={chosen.behavior.packId} worldId={request.worldId} revision={packHealth?.revision} pack={chosen.behavior} onSaved={() => call("worlds.inspect-pack-health", { worldId: request.worldId }).then(setPackHealth).catch(() => {})} />}
      {chosen.resource && <PackFields key={chosen.resource.packId} worldId={request.worldId} revision={packHealth?.revision} pack={chosen.resource} onSaved={() => call("worlds.inspect-pack-health", { worldId: request.worldId }).then(setPackHealth).catch(() => {})} />}
    </div>}
    {!fromWorld && libraryMods.map(mod => <div className="content-mod-info" key={mod.packIds.join(",")}>
      {mod.behavior && <PackFields file key={mod.behavior.packId} pack={mod.behavior} worldId={request?.worldId} onSaved={() => scan()} />}
      {mod.resource && <PackFields file key={mod.resource.packId} pack={mod.resource} worldId={request?.worldId} onSaved={() => scan()} />}
    </div>)}
    {error && <ErrorBox>{error}</ErrorBox>}
    <div className="content-kpi-row"><div className="content-kpi content-kpi-primary"><strong>{summary.entryCount ?? "—"}</strong><span>可浏览内容</span><small>{summary.fileCount ?? "—"} 个来源文件</small></div><div className="content-kpi"><strong>{summary.counts?.item ?? 0}</strong><span>物品</span></div><div className="content-kpi"><strong>{summary.counts?.block ?? 0}</strong><span>方块</span></div><div className="content-kpi"><strong>{summary.counts?.entity ?? 0}</strong><span>实体</span></div><div className="content-kpi"><strong>{summary.counts?.model ?? 0}</strong><span>模型</span></div><div className={`content-kpi ${summary.issueCount ? "content-kpi-warn" : ""}`}><strong>{summary.issueCount ?? 0}</strong><span>检查提示</span></div></div>
    <div className="content-filter-bar"><input aria-label="搜索内容" placeholder="搜索显示名称、标识符或文件…" value={query} onChange={e => setQuery(e.target.value)} />{!fromWorld && <select aria-label="内容来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{sourceRows.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select>}{(query || type || (!fromWorld && (source || packId))) && <button className="content-clear-filter" onClick={clear}>清除筛选</button>}<span className="content-result-count">{assets.length} 项</span></div>
    <div className="content-type-tabs" role="tablist" aria-label="内容类型"><button className={!type ? "active" : ""} onClick={() => setType("")}>全部</button>{contentTypes.slice(0, 8).map(([key, label]) => <button key={key} className={type === key ? "active" : ""} onClick={() => setType(type === key ? "" : key)}>{label}<small>{summary.counts?.[key] || 0}</small></button>)}</div>
    <div className="content-workbench-grid content-workbench-grid-v2">
      <main className="content-results"><div className="content-results-heading"><div><strong>{fromWorld ? (packId ? (chosen?.name || "当前模组") : "全部模组") : "全部内容"}</strong><span>{assets.length} 项匹配</span></div>{data?.generatedAt && <time>{new Date(data.generatedAt).toLocaleTimeString()}</time>}</div>{assets.length ? <div className="content-result-list">{assets.slice(0, 500).map(asset => <button className={`content-result-row ${asset.status} ${selected?.id === asset.id ? "selected" : ""}`} key={asset.id} onClick={() => setSelected(asset)}>{asset.texture?.preview || asset.preview ? <img src={asset.texture?.preview || asset.preview} alt="" /> : <span className={`content-asset-icon type-${asset.type}`}>{typeLabel(asset.type).slice(0, 1)}</span>}<span className="content-result-copy"><strong>{asset.displayName || asset.label}</strong><small>{typeLabel(asset.type)}{asset.identifier ? ` · ${asset.identifier}` : ""}</small><em>{asset.packName} · {asset.relative}</em></span>{asset.status !== "ok" && <b>{asset.status === "warning" ? "重复" : "错误"}</b>}<span className="content-row-arrow">›</span></button>)}</div> : <div className="content-no-results"><strong>没有匹配内容</strong><p>试试清除筛选，或搜索一个物品标识符。</p><button onClick={clear}>清除筛选</button></div>}{assets.length > 500 && <p className="content-list-limit">当前仅展示前 500 项，请继续缩小筛选范围。</p>}</main>
      <aside className="content-detail-panel">{selected ? <ContentDetailV2 asset={selected} typeLabel={typeLabel} onEditModel={onEditModel} /> : <div className="content-detail-empty"><span>⌁</span><strong>选择一项内容</strong><p>名称、属性、贴图、模型结构和来源会显示在这里。</p></div>}</aside>
    </div>
    <section className={`content-issues-panel ${showIssues ? "open" : ""}`}><button className="content-issues-toggle" onClick={() => setShowIssues(value => !value)}><span><strong>{summary.issueCount ? `${summary.issueCount} 项检查提示` : "检查结果正常"}</strong><small>{showIssues ? "收起" : "展开详情"}</small></span><b>{showIssues ? "⌃" : "⌄"}</b></button>{showIssues && <div className="content-issues-list">{data?.issues?.length ? data.issues.slice(0, 30).map((issue, index) => <div key={index}><strong>{issueLabel(issue)}</strong><p>{issue.message}</p><small>{issue.sourceName || issue.packName || "内容索引"}</small></div>) : <p>没有静态检查提示。</p>}</div>}</section>
  </section>;
}

function ContentDetailV2({ asset, typeLabel, onEditModel }) {
  return <div className="content-detail"><div className="content-detail-heading">{asset.texture?.preview || asset.preview ? <img src={asset.texture?.preview || asset.preview} alt="" /> : <span className={`content-asset-icon type-${asset.type}`}>{typeLabel(asset.type).slice(0, 1)}</span>}<div><span>{typeLabel(asset.type)}</span><h3>{asset.displayName || asset.label}</h3><p>{asset.packName}</p></div></div><dl><dt>标识符</dt><dd>{asset.identifier || asset.identifiers?.join("、") || "未提取"}</dd><dt>包 UUID</dt><dd>{asset.packId || "未关联"}</dd><dt>来源文件</dt><dd title={asset.path}>{asset.relative}</dd></dl>{asset.components?.length > 0 && <DetailSection title="组件与属性"><div className="content-chip-list">{asset.components.map(component => <span key={component}>{component}</span>)}</div><pre>{JSON.stringify(asset.componentValues, null, 2)}</pre></DetailSection>}{asset.model && <DetailSection title="模型结构"><p>{asset.model.bones} 根骨骼 · {asset.model.cubes} 个 Cube · {asset.model.textureWidth || "?"}×{asset.model.textureHeight || "?"} 贴图</p><div className="content-chip-list">{asset.model.boneNames?.slice(0, 24).map(name => <span key={name}>{name}</span>)}</div></DetailSection>}{asset.animation && <DetailSection title="动画摘要"><p>时长：{asset.animation.length ?? "未指定"} · 循环：{String(asset.animation.loop)} · 骨骼轨道：{asset.animation.bones}</p></DetailSection>}{asset.entity && <DetailSection title="实体关联"><p>Geometry：{asset.entity.geometry?.join("、") || "未提取"}</p><p>贴图：{asset.entity.textures?.join("、") || "未提取"}</p><p>动画：{asset.entity.animations?.join("、") || "未提取"}</p></DetailSection>}{asset.type === "model" && onEditModel && <Button onClick={() => onEditModel(asset)}>编辑模型</Button>}<p className="content-detail-foot">只读浏览 · 运行时加载状态需在游戏会话中确认</p></div>;
}

function DetailSection({ title, children }) {
  return <details className="content-detail-fold" open><summary>{title}</summary><div>{children}</div></details>;
}

export function ModSelector({ form, change, snapshot, onManage, busy }) {
  return (
    <Section
      title="模组列表"
      description="从全局模组库快速勾选本配置要加载的模组，取消勾选即停用。保存配置后用于下一次启动。"
    >
      <ModCatalog
        entries={form.included_mod_dirs}
        onChange={(value) => change("included_mod_dirs", value)}
        snapshot={snapshot}
        onManage={onManage}
        busy={busy}
      />
    </Section>
  );
}
export function ModCatalog({
  entries,
  onChange,
  snapshot,
  onManage,
  onRemoved,
  onOpenContent,
  busy = false,
}) {
  const selecting = !!onChange;
  const [library, setLibrary] = useState(null),
    [studio, setStudio] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState(""),
    [working, setWorking] = useState(false),
    [dialog, setDialog] = useState(null),
    [name, setName] = useState(""),
    [directory, setDirectory] = useState("");
  const ticket = useRef(0);
  async function refresh() {
    const current = ++ticket.current;
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.list");
      const found = await call("mcstudio.scan").catch(() => null);
      if (current === ticket.current) setLibrary(value);
      if (current === ticket.current) setStudio(found);
    } catch (e) {
      if (current === ticket.current) setError(e.message);
    } finally {
      if (current === ticket.current) setWorking(false);
    }
  }
  useEffect(() => {
    refresh();
    return () => {
      ticket.current++;
    };
  }, []);
  const rows = selecting
    ? modRows(library?.mods || [], entries, snapshot)
    : library?.mods || [];
  const shown = rows.filter((m) =>
    `${m.name}\n${m.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  const registeredMods = new Set(rows.map((item) => studioKey(item.path)));
  const externalMods = selecting ? [] : (studio?.mods || []).filter((item) => item.importable && !registeredMods.has(studioKey(item.directory)) && (item.name + " " + item.projectName + " " + item.directory).toLowerCase().includes(query.toLowerCase()));
  async function importStudioMod(item) {
    const current = ticket.current;
    setWorking(true);
    setError("");
    try {
      const value = await call("mcstudio.import-mod", { directory: item.directory, revision: library.revision });
      if (current !== ticket.current) return;
      setLibrary(value);
      setNotice("已从 MCStudio 收录 " + value.added + " 个模组目录，文件仍留在原处。");
    } catch (e) {
      if (current === ticket.current) setError(e.message);
    } finally {
      if (current === ticket.current) setWorking(false);
    }
  }
  function open(kind, mod) {
    setDialog({ kind, mod });
    setName(mod?.name || "");
    setDirectory(mod?.path || "");
    setError("");
    setNotice("");
  }
  async function pick() {
    try {
      const value = await call("files.directory");
      if (value) {
        setDirectory(value);
        if (!name)
          setName(value.split(/[\\/]/).filter(Boolean).at(-1).slice(0, 80));
      }
    } catch (e) {
      setError(e.message);
    }
  }
  async function submit() {
    setWorking(true);
    setError("");
    const action = dialog;
    setDialog(null);
    try {
      const value =
        action.kind === "remove"
          ? await call("mods.remove", {
              id: action.mod.id,
              revision: library.revision,
            })
          : await call("mods.save", {
              id: action.mod?.id,
              name,
              directory,
              revision: library.revision,
            });
      setLibrary(value);
      if (action.kind === "remove") await onRemoved?.(value);
      setNotice(
        action.kind === "remove"
          ? `已移除，并清理 ${value.changes.length} 套启动配置中的 ${value.removedReferences} 条引用；模组文件保留，下次启动生效。`
          : "模组库已保存；已有配置保持不变。",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function importProfiles() {
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.import-profiles", {
        revision: library.revision,
      });
      setLibrary(value);
      setNotice(`已收录 ${value.added} 个新目录，重复路径已跳过。`);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  function selectShown(enabled) {
    let next = entries;
    for (const row of shown) {
      if (enabled && row.available === false && !row.enabled) continue;
      next = setModOption(next, row, "enabled", enabled);
    }
    onChange(next);
  }
  async function openFolder(mod) {
    setError("");
    try {
      await call(
        "mods.folder",
        mod.id
          ? { id: mod.id }
          : {
              profileId: snapshot.project.id,
              index: mod.indexes[0],
              expectedPath: mod.path,
            },
      );
    } catch (e) {
      setError(e.message);
    }
  }
  async function dropFiles(files) {
    if (files.some((file) => !file.directory))
      throw Error("请拖入模组目录，而不是文件");
    const current = ticket.current;
    setWorking(true);
    setError("");
    try {
      const value = await call("mods.add-directories", {
        directories: files.map((file) => file.path),
        revision: library.revision,
      });
      if (current !== ticket.current) return;
      setLibrary(value);
      if (selecting) {
        let next = entries;
        for (const row of modRows(value.mods, entries, snapshot))
          if (value.selectedIds.includes(row.id))
            next = setModOption(next, row, "enabled", true);
        onChange(next);
      }
      setNotice(
        selecting
          ? "拖入的模组已收录并启用，请保存启动配置。"
          : `已收录 ${value.added} 个新模组目录。`,
      );
    } finally {
      if (current === ticket.current) setWorking(false);
    }
  }
  return (
    <FileDropZone
      className="mod-catalog"
      onFiles={dropFiles}
      report={(e) => setError(e.message)}
      disabled={busy || working || !library}
      blockWhenModal
      hint={selecting ? "松开以收录并启用模组" : "松开以收录到全局模组库"}
    >
      <div className="mod-library-toolbar">
        <input
          aria-label="搜索模组"
          placeholder="搜索模组名称或路径…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button
          disabled={busy || working || !library}
          onClick={() => open("add")}
        >
          添加全局模组
        </Button>
        <Button disabled={busy || working} onClick={refresh}>
          刷新模组库
        </Button>
        {selecting ? (
          <Button disabled={busy || working} onClick={onManage}>
            管理模组库
          </Button>
        ) : (
          <Button disabled={working || !library} onClick={importProfiles}>
            从启动配置收录
          </Button>
        )}
      </div>
      {!dialog && <ErrorBox>{error}</ErrorBox>}
      {!!library?.warnings.length && (
        <ErrorBox>{library.warnings.join("；")}</ErrorBox>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {working && <p className="muted" role="status">正在处理模组库操作…</p>}
      {selecting && (
        <div className="mod-selection-toolbar">
          <span className="muted">
            已启用 {rows.filter((m) => m.enabled).length} / {rows.length}{" "}
            个模组目录
          </span>
          <Button
            disabled={busy || working || !shown.length}
            onClick={() => selectShown(true)}
          >
            启用筛选结果
          </Button>
          <Button
            disabled={busy || working || !shown.length}
            onClick={() => selectShown(false)}
          >
            停用筛选结果
          </Button>
        </div>
      )}
      <div className={selecting ? "mod-pick-list" : "mod-library-grid"}>
        {shown.map((m) => (
          <article
            className={`mod-library-card ${selecting ? "pick-row" : ""} ${m.enabled ? "enabled" : ""}`}
            key={m.key || m.id}
            data-available={m.available !== false}
            aria-label={"模组 " + m.name}
          >
            {selecting && (
              <input
                type="checkbox"
                aria-label={"启用模组 " + m.name}
                checked={m.enabled}
                disabled={
                  busy || working || (m.available === false && !m.enabled)
                }
                onChange={(e) =>
                  onChange(
                    setModOption(entries, m, "enabled", e.target.checked),
                  )
                }
              />
            )}
            {!selecting && <div className="mod-glyph" aria-hidden="true"><Icon name="cube" size={26} /></div>}
            <div className="mod-library-info">
              <h3 title={m.name}>{m.name}</h3>
              <p title={m.path}>{m.path}</p>
              {studioMod(m, studio) && <p>来自 MCStudio · {studioMod(m, studio).projectName}</p>}
              {(!selecting ||
                m.local ||
                !m.available ||
                m.indexes?.length > 1) && (
                <div
                  className="mod-library-status"
                  title={`${m.local ? "仅在此配置中，未登记到全局库" : m.available ? "目录可用" : "目录不存在或无法读取"}${m.indexes?.length > 1 ? ` · 此配置有 ${m.indexes.length} 条同路径记录，勾选同步切换` : ""}`}
                >
                  <small>
                    {m.local
                      ? "仅在此配置中，未登记到全局库"
                      : m.available
                        ? "目录可用"
                        : "目录不存在或无法读取"}
                  </small>
                  {m.indexes?.length > 1 && (
                    <small>
                      {" "}
                      · 此配置有 {m.indexes.length} 条同路径记录，勾选同步切换
                    </small>
                  )}
                </div>
              )}
              <ErrorBox>{m.error}</ErrorBox>
            </div>
            {selecting ? (
              <>
                <Button
                  icon="folder"
                  aria-label={"打开模组文件夹 " + m.name}
                  title="打开当前模组文件夹"
                  disabled={busy || working || m.available === false}
                  onClick={() => openFolder(m)}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    aria-label={"模组热更新 " + m.name}
                    checked={m.hotReload}
                    disabled={busy || working || !m.enabled}
                    onChange={(e) =>
                      onChange(
                        setModOption(
                          entries,
                          m,
                          "hot_reload",
                          e.target.checked,
                        ),
                      )
                    }
                  />
                  热更新
                </label>
              </>
            ) : (
              <div className="mod-library-actions">
                <Button
                  icon="folder"
                  disabled={working || !m.available}
                  onClick={() => openFolder(m)}
                >
                  打开文件夹
                </Button>
                {onOpenContent && <Button icon="inspect" compact disabled={working || m.available === false} onClick={() => onOpenContent({ sourceId: m.id, sourceName: m.name })}>编辑内容</Button>}
                <Button icon="edit" compact disabled={working} onClick={() => open("edit", m)}>
                  编辑模组
                </Button>
                <Button
                  icon="trash" compact
                  danger
                  disabled={working}
                  onClick={() => open("remove", m)}
                >
                  移出模组库
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
      {!!externalMods.length && (
        <section aria-label="可从 MCStudio 导入">
          <h2>可从 MCStudio 导入</h2>
          <p className="muted">这些目录带有行为包或资源包清单，尚未收入模组库。收录只登记路径，不移动文件。</p>
          <div className="mod-library-grid">
            {externalMods.map((item) => (
              <article className="mod-library-card mcstudio-import-card" key={item.id} aria-label={"MCStudio 模组 " + item.name}>
                <div className="mod-library-info">
                  <h3>{item.name}</h3>
                  <p title={item.directory}>{item.directory}</p>
                  <p>来自 MCStudio · {item.projectName}</p>
                </div>
                <div className="mod-library-actions">
                  <Button disabled={working || !library} onClick={() => importStudioMod(item)}>从外部导入</Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {!shown.length && (
        <Empty
          title={
            working
              ? "正在读取模组库…"
              : query
                ? "没有匹配的模组"
                : "模组库为空"
          }
        >
          添加模组目录后，可以在每套启动配置中勾选使用。
        </Empty>
      )}
      {dialog && (
        <Modal
          title={
            dialog.kind === "remove"
              ? "移出全局模组库？"
              : dialog.kind === "edit"
                ? "编辑全局模组"
                : "添加全局模组"
          }
          onClose={() => !working && setDialog(null)}
          footer={
            <>
              <Button disabled={working} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button
                primary
                disabled={
                  working ||
                  (dialog.kind !== "remove" &&
                    (!name.trim() || !directory.trim()))
                }
                onClick={submit}
              >
                {working
                  ? "处理中…"
                  : dialog.kind === "remove"
                    ? "确认移出"
                    : "保存到模组库"}
              </Button>
            </>
          }
        >
          {dialog.kind === "remove" ? (
            <p>
              将“{dialog.mod.name}
              ”移出全局模组库，并从所有启动配置中删除同路径的模组条目（包括停用项和重复项）。磁盘文件不删除，已运行的游戏不受影响，下次启动生效。
            </p>
          ) : (
            <>
              <Field label="模组名称">
                <input
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="模组目录">
                <div className="mod-library-toolbar">
                  <input
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                  />
                  <Button disabled={working} onClick={pick}>
                    选择模组目录
                  </Button>
                </div>
              </Field>
              {dialog.kind === "edit" && (
                <p className="muted">
                  更改目录只更新模组库。已有配置保留原路径，需要在配置中重新勾选。
                </p>
              )}
            </>
          )}
          <ErrorBox>{error}</ErrorBox>
        </Modal>
      )}
    </FileDropZone>
  );
}
