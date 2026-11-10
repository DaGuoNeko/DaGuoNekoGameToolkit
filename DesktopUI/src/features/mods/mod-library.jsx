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
import "./mod-library.css";
import { useWorkspaceState } from "../../app/workspaces.jsx";

const studioKey = (value) => String(value || "").toLowerCase();
function studioMod(mod, studio) {
  return (studio?.mods || []).find((item) => studioKey(item.directory) === studioKey(mod?.path)) || null;
}
const call = (method, args = {}) => window.toolkit.call(method, args);
export function ModLibraryPage({ onRemoved }) {
  return (
    <>
      <Intro
        title="全局模组库"
        subtitle="集中登记模组目录，编辑启动配置时可直接勾选。移出模组时同步清理各套配置中的对应条目。"
      />
      <ModCatalog onRemoved={onRemoved} />
    </>
  );
}

const contentTypes = [
  ["item", "物品"], ["block", "方块"], ["entity", "实体"], ["model", "模型"],
  ["texture", "贴图"], ["animation", "动画"], ["particle", "粒子"], ["script", "脚本"],
  ["ui", "界面"], ["data", "数据"],
];

export function ModWorkspacePage({ onRemoved, request, onClearScope, onBack, onEditor }) {
  // 保留原模组库作为默认页，旧配置和已有操作仍可直接进入；内容浏览作为同一工作区的增强视图。
  const [tab, setTab] = useWorkspaceState("mod-tab", request ? "content" : "library");
  useEffect(() => { if (request) setTab("content"); }, [request]);
  return <div className="mod-workspace-page">
    <Intro title="模组与内容" subtitle="浏览模组定义与来源文件；世界里已经保存的实例在存档的世界数据中查看。">
      {request && <><Button onClick={onBack}>返回来源存档</Button><Button onClick={onClearScope}>切换全局模组库</Button></>}
      {onEditor && <Button onClick={onEditor}>UI 编辑器</Button>}
    </Intro>
    <div className="mod-workspace-tabs" role="tablist" aria-label="模组工作区">
      <button className={tab === "content" ? "active" : ""} role="tab" aria-selected={tab === "content"} onClick={() => setTab("content")}>内容浏览</button>
      <button className={tab === "library" ? "active" : ""} role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>模组目录</button>
    </div>
    {tab === "content" ? <ContentBrowserV2 key={`${request?.worldId || "global"}:${request?.packId || "all"}`} request={request} onManage={() => setTab("library")} /> : <ModCatalog onRemoved={onRemoved} />}
  </div>;
}

export function ContentBrowserV2({ onManage, request }) {
  const scope = `content:${request?.worldId || "global"}:${request?.packId || "all"}`;
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useWorkspaceState(scope + ":query", ""), [type, setType] = useWorkspaceState(scope + ":type", ""), [source, setSource] = useWorkspaceState(scope + ":source", ""), [packId, setPackId] = useWorkspaceState(scope + ":pack", request?.packId || ""), [selected, setSelected] = useWorkspaceState(scope + ":selected", null), [showIssues, setShowIssues] = useState(false);
  const scan = async () => { setBusy(true); setError(""); try { setData(await call("content.scan", request?.worldId ? { worldId: request.worldId } : {})); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  useEffect(() => { scan(); }, [request?.worldId, request?.packId]);
  const summary = data?.summary || {};
  const { rows, searchText, packCounts } = useMemo(() => {
    const entries = data?.entries || [], semanticSourceIds = new Set(entries.map(entry => entry.sourceAssetId));
    const rows = [...entries, ...(data?.assets || []).filter(asset => !semanticSourceIds.has(asset.id) || !["item", "block", "entity", "model", "animation"].includes(asset.type))];
    const packCounts = new Map(); for (const entry of entries) packCounts.set(entry.packId, (packCounts.get(entry.packId) || 0) + 1);
    return { rows, packCounts, searchText: rows.map(asset => `${asset.label} ${asset.displayName || ""} ${asset.identifier || ""} ${asset.relative} ${(asset.identifiers || []).join(" ")}`.toLowerCase()) };
  }, [data]);
  const needle = query.trim().toLowerCase();
  const assets = useMemo(() => rows.filter((asset, index) => (!type || asset.type === type) && (!source || asset.sourceId === source) && (!packId || asset.packId === packId) && (!needle || searchText[index].includes(needle))), [rows, searchText, type, source, packId, needle]);
  const sourceRows = data?.sources || [], packRows = data?.packs || [], selectedPack = packRows.find(pack => pack.id === (selected?.packId || packId));
  const typeLabel = key => contentTypes.find(item => item[0] === key)?.[1] || key;
  const clear = () => { setQuery(""); setType(""); setSource(""); setPackId(""); };
  const issueLabel = issue => issue.code === "duplicate-identifier" ? "标识符重复" : issue.code === "invalid-json" ? "JSON 无法解析" : issue.code === "source-missing" ? "来源不可用" : "扫描提示";
  useEffect(() => {
    if (!assets.length) { setSelected(null); return; }
    const match = assets.find(asset => asset.id === selected?.id) || assets[0];
    if (selected !== match) setSelected(match);
  }, [data, type, source, packId, query]);
  return <section className="content-workbench content-workbench-v2">
    <header className="content-workbench-header"><div><span className="content-eyebrow">CONTENT WORKBENCH</span><h2>{request?.worldName || "模组内容浏览"}</h2><p>{request?.packName ? `正在查看 ${request.packName} 的内容` : "按内容浏览模组，文件只是来源证据。"}</p></div><div className="content-workbench-actions"><Button primary disabled={busy} onClick={scan}>{busy ? "扫描中…" : "重新扫描"}</Button><Button disabled={busy} onClick={onManage}>模组目录</Button></div></header>
    {error && <ErrorBox>{error}</ErrorBox>}
    <div className="content-kpi-row"><div className="content-kpi content-kpi-primary"><strong>{summary.entryCount ?? "—"}</strong><span>可浏览内容</span><small>{summary.fileCount ?? "—"} 个来源文件</small></div><div className="content-kpi"><strong>{summary.counts?.item ?? 0}</strong><span>物品</span></div><div className="content-kpi"><strong>{summary.counts?.block ?? 0}</strong><span>方块</span></div><div className="content-kpi"><strong>{summary.counts?.entity ?? 0}</strong><span>实体</span></div><div className="content-kpi"><strong>{summary.counts?.model ?? 0}</strong><span>模型</span></div><div className={`content-kpi ${summary.issueCount ? "content-kpi-warn" : ""}`}><strong>{summary.issueCount ?? 0}</strong><span>检查提示</span></div></div>
    <div className="content-filter-bar"><input aria-label="搜索内容" placeholder="搜索显示名称、标识符或文件…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="内容来源" value={source} onChange={e => setSource(e.target.value)}><option value="">全部来源</option>{sourceRows.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select>{(query || source || type || packId) && <button className="content-clear-filter" onClick={clear}>清除筛选</button>}<span className="content-result-count">{assets.length} 项</span></div>
    <div className="content-type-tabs" role="tablist" aria-label="内容类型"><button className={!type ? "active" : ""} onClick={() => setType("")}>全部</button>{contentTypes.slice(0, 8).map(([key, label]) => <button key={key} className={type === key ? "active" : ""} onClick={() => setType(type === key ? "" : key)}>{label}<small>{summary.counts?.[key] || 0}</small></button>)}</div>
    {request?.worldId && <div className="content-context-line"><strong>{request.worldName || "当前存档"}</strong><span>{request.packName ? `来自存档模组：${request.packName}` : "来自存档模组列表"}</span>{packId && <button onClick={() => setPackId("")}>查看全部包</button>}</div>}
    <div className="content-scope-bar"><div className="content-scope-current"><span>当前范围</span><strong>{packId ? (selectedPack?.name || request?.packName || "当前包") : "全部包"}</strong><small>{assets.length} 项内容</small></div><details className="content-scope-menu"><summary>按包筛选</summary><div className="content-scope-list"><button className={!packId ? "active" : ""} onClick={() => setPackId("")}><span>全部包</span><small>{rows.length}</small></button>{packRows.map(pack => <button className={packId === pack.id ? "active" : ""} key={pack.id} onClick={() => setPackId(packId === pack.id ? "" : pack.id)}><span>{pack.name}<em>{pack.kind === "behavior" ? "行为" : "资源"} · v{pack.version?.join(".") || "—"}</em></span><small>{packCounts.get(pack.id) || 0}</small></button>)}</div></details></div>
    <div className="content-workbench-grid content-workbench-grid-v2">
      <main className="content-results"><div className="content-results-heading"><div><strong>{packId ? (selectedPack?.name || "当前包") : "全部内容"}</strong><span>{assets.length} 项匹配</span></div>{data?.generatedAt && <time>{new Date(data.generatedAt).toLocaleTimeString()}</time>}</div>{assets.length ? <div className="content-result-list">{assets.slice(0, 500).map(asset => <button className={`content-result-row ${asset.status} ${selected?.id === asset.id ? "selected" : ""}`} key={asset.id} onClick={() => setSelected(asset)}>{asset.texture?.preview || asset.preview ? <img src={asset.texture?.preview || asset.preview} alt="" /> : <span className={`content-asset-icon type-${asset.type}`}>{typeLabel(asset.type).slice(0, 1)}</span>}<span className="content-result-copy"><strong>{asset.displayName || asset.label}</strong><small>{typeLabel(asset.type)}{asset.identifier ? ` · ${asset.identifier}` : ""}</small><em>{asset.packName} · {asset.relative}</em></span>{asset.status !== "ok" && <b>{asset.status === "warning" ? "重复" : "错误"}</b>}<span className="content-row-arrow">›</span></button>)}</div> : <div className="content-no-results"><strong>没有匹配内容</strong><p>试试清除筛选，或搜索一个物品标识符。</p><button onClick={clear}>清除筛选</button></div>}{assets.length > 500 && <p className="content-list-limit">当前仅展示前 500 项，请继续缩小筛选范围。</p>}</main>
      <aside className="content-detail-panel">{selected ? <ContentDetailV2 asset={selected} typeLabel={typeLabel} /> : <div className="content-detail-empty"><span>⌁</span><strong>选择一项内容</strong><p>名称、属性、贴图、模型结构和来源会显示在这里。</p></div>}</aside>
    </div>
    <section className={`content-issues-panel ${showIssues ? "open" : ""}`}><button className="content-issues-toggle" onClick={() => setShowIssues(value => !value)}><span><strong>{summary.issueCount ? `${summary.issueCount} 项检查提示` : "检查结果正常"}</strong><small>{showIssues ? "收起" : "展开详情"}</small></span><b>{showIssues ? "⌃" : "⌄"}</b></button>{showIssues && <div className="content-issues-list">{data?.issues?.length ? data.issues.slice(0, 30).map((issue, index) => <div key={index}><strong>{issueLabel(issue)}</strong><p>{issue.message}</p><small>{issue.sourceName || issue.packName || "内容索引"}</small></div>) : <p>没有静态检查提示。</p>}</div>}</section>
  </section>;
}

function ContentDetailV2({ asset, typeLabel }) {
  return <div className="content-detail"><div className="content-detail-heading">{asset.texture?.preview || asset.preview ? <img src={asset.texture?.preview || asset.preview} alt="" /> : <span className={`content-asset-icon type-${asset.type}`}>{typeLabel(asset.type).slice(0, 1)}</span>}<div><span>{typeLabel(asset.type)}</span><h3>{asset.displayName || asset.label}</h3><p>{asset.packName}</p></div></div><dl><dt>标识符</dt><dd>{asset.identifier || asset.identifiers?.join("、") || "未提取"}</dd><dt>包 UUID</dt><dd>{asset.packId || "未关联"}</dd><dt>来源文件</dt><dd title={asset.path}>{asset.relative}</dd></dl>{asset.components?.length > 0 && <DetailSection title="组件与属性"><div className="content-chip-list">{asset.components.map(component => <span key={component}>{component}</span>)}</div><pre>{JSON.stringify(asset.componentValues, null, 2)}</pre></DetailSection>}{asset.model && <DetailSection title="模型结构"><p>{asset.model.bones} 根骨骼 · {asset.model.cubes} 个 Cube · {asset.model.textureWidth || "?"}×{asset.model.textureHeight || "?"} 贴图</p><div className="content-chip-list">{asset.model.boneNames?.slice(0, 24).map(name => <span key={name}>{name}</span>)}</div></DetailSection>}{asset.animation && <DetailSection title="动画摘要"><p>时长：{asset.animation.length ?? "未指定"} · 循环：{String(asset.animation.loop)} · 骨骼轨道：{asset.animation.bones}</p></DetailSection>}{asset.entity && <DetailSection title="实体关联"><p>Geometry：{asset.entity.geometry?.join("、") || "未提取"}</p><p>贴图：{asset.entity.textures?.join("、") || "未提取"}</p><p>动画：{asset.entity.animations?.join("、") || "未提取"}</p></DetailSection>}<p className="content-detail-foot">只读浏览 · 运行时加载状态需在游戏会话中确认</p></div>;
}

function DetailSection({ title, children }) {
  return <details className="content-detail-fold" open><summary>{title}</summary><div>{children}</div></details>;
}

function ContentBrowserLegacy({ onManage, request }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [query, setQuery] = useState(""), [type, setType] = useState(""), [source, setSource] = useState(""), [selected, setSelected] = useState(null), [packId, setPackId] = useState(request?.packId || "");
  const scan = async () => {
    setBusy(true); setError("");
    try { setData(await call("content.scan", request?.worldId ? { worldId: request.worldId } : {})); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { setPackId(request?.packId || ""); setData(null); scan(); }, [request?.worldId]);
  const summary = data?.summary || {};
  const semanticSourceIds = new Set((data?.entries || []).map(entry => entry.sourceAssetId));
  const rows = [...(data?.entries || []), ...(data?.assets || []).filter(asset => !semanticSourceIds.has(asset.id) || !["item", "block", "entity", "model", "animation"].includes(asset.type))];
  const assets = rows.filter(asset => (!type || asset.type === type) && (!source || asset.sourceId === source) && (!packId || asset.packId === packId) && (!query || `${asset.label} ${asset.displayName || ""} ${asset.identifier || ""} ${asset.relative} ${(asset.identifiers || []).join(" ")}`.toLowerCase().includes(query.toLowerCase())));
  const sourceRows = data?.sources || [];
  const packRows = (data?.packs || []).filter(pack => !packId || pack.id === packId);
  return <section className="content-workbench">
    <div className="content-hero">
      <div><span className="content-eyebrow">CONTENT WORKBENCH</span><h2>浏览模组真正提供的内容</h2><p>扫描已登记目录中的行为包、资源包和常见 Bedrock 资源，建立文件、标识符与来源关系。</p></div>
      <div className="content-hero-actions"><Button primary disabled={busy} onClick={scan}>{busy ? "正在扫描…" : "重新扫描内容"}</Button><Button disabled={busy} onClick={onManage}>管理模组目录</Button></div>
    </div>
    <ErrorBox>{error}</ErrorBox>
    <div className="content-summary-grid">
      <div className="content-summary-main"><strong>{summary.entryCount ?? summary.assetCount ?? "—"}</strong><span>语义内容</span><small>{summary.fileCount ?? "—"} 个文件 · {summary.packCount ?? "—"} 个包</small></div>
      {contentTypes.slice(0, 6).map(([key, label]) => <div className="content-summary-card" key={key}><strong>{summary.counts?.[key] ?? 0}</strong><span>{label}</span></div>)}
      <div className={`content-summary-card ${summary.issueCount ? "warn" : "ok"}`}><strong>{summary.issueCount ?? 0}</strong><span>{summary.issueCount ? "检查提示" : "检查通过"}</span></div>
    </div>
    {request?.worldId && <div className="content-context-banner"><strong>{request.worldName || "当前存档"}</strong><span>从存档模组列表进入 · {request.packName ? `当前包：${request.packName}` : "全部存档内容"}</span><button onClick={() => setPackId("")}>查看全部包</button></div>}
      <div className="content-source-strip"><div><strong>内容来源</strong><span>扫描不会修改模组文件，Blockbench 仅保留后续接入位置。</span></div><div className="content-source-pills">{sourceRows.map(row => <button key={row.id} className={source === row.id ? "active" : ""} onClick={() => setSource(source === row.id ? "" : row.id)}>{row.name}<small>{row.assets} 项</small></button>)}</div></div>
      <div className="content-pack-strip">{packRows.map(pack => <div className="content-pack-card" key={pack.id}><div><strong>{pack.name}</strong><small>{pack.kind === "behavior" ? "行为包" : pack.kind === "resource" ? "资源包" : "未知类型"} · v{pack.version?.join(".") || "—"}</small></div><code>{pack.id}</code><span>{pack.modules?.length || 0} 个模块 · {pack.dependencies?.length || 0} 个依赖</span></div>)}</div>
    <div className="content-browser-toolbar"><input aria-label="搜索内容" placeholder="搜索名称、标识符或文件路径…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="内容类型" value={type} onChange={e => setType(e.target.value)}><option value="">全部类型</option>{contentTypes.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span>{assets.length} 项</span></div>
    <div className="content-browser-layout">
      <div className="content-asset-grid">{assets.slice(0, 500).map(asset => <button className={`content-asset-card ${asset.status}`} key={asset.id} onClick={() => setSelected(asset)}>{asset.texture?.preview || asset.preview ? <img className="content-asset-thumb" src={asset.texture?.preview || asset.preview} alt="" /> : <span className={`content-asset-icon type-${asset.type}`}>{contentTypes.find(item => item[0] === asset.type)?.[1]?.slice(0, 1) || "·"}</span>}<span className="content-asset-card-body"><strong>{asset.displayName || asset.label}</strong><small>{contentTypes.find(item => item[0] === asset.type)?.[1] || asset.type}{asset.identifier ? ` · ${asset.identifier}` : ` · ${asset.packName}`}</small><em>{asset.relative}</em></span>{asset.status !== "ok" && <span className="content-asset-status">{asset.status === "warning" ? "重复" : "错误"}</span>}</button>)}</div>
      <aside className="content-side-panel"><div className="content-side-heading"><strong>扫描状态</strong><span>{busy ? "进行中" : data ? "已完成" : "等待扫描"}</span></div>{data?.issues?.length ? <div className="content-issue-list">{data.issues.slice(0, 12).map((issue, index) => <div key={index}><strong>{issue.code === "duplicate-identifier" ? "标识符重复" : issue.code === "invalid-json" ? "JSON 无法解析" : issue.code === "source-missing" ? "来源不可用" : "扫描提示"}</strong><p>{issue.message}</p><small>{issue.sourceName || issue.packName || "内容索引"}</small></div>)}</div> : <div className="content-empty-panel"><span>✓</span><strong>暂未发现问题</strong><p>静态扫描通过不等于游戏内已加载，运行验证会在后续版本接入。</p></div>}<div className="content-reserved"><span>BLOCKBENCH</span><strong>建模工作台预留</strong><p>模型、贴图和动画已建立文件关联。后续可从这里打开桌面版或 Web App。</p><button disabled title="后续版本接入">暂未接入</button></div></aside>
    </div>
    {selected && <Modal wide title={selected.displayName || selected.label} onClose={() => setSelected(null)} footer={<Button onClick={() => setSelected(null)}>关闭</Button>}><div className="content-detail"><div className="content-detail-head">{selected.texture?.preview || selected.preview ? <img className="content-detail-thumb" src={selected.texture?.preview || selected.preview} alt="" /> : <span className={`content-asset-icon type-${selected.type}`}>{contentTypes.find(item => item[0] === selected.type)?.[1]?.slice(0, 1) || "·"}</span>}<div><strong>{contentTypes.find(item => item[0] === selected.type)?.[1] || selected.type}</strong><p>{selected.packName} · {selected.status === "ok" ? "静态文件有效" : selected.status === "warning" ? "存在重复标识符" : selected.error}</p></div></div><dl><dt>包 UUID</dt><dd>{selected.packId || "未关联"}</dd><dt>文件</dt><dd>{selected.path}</dd><dt>标识符</dt><dd>{selected.identifier || selected.identifiers?.join("、") || "未提取到标准标识符"}</dd><dt>显示名称</dt><dd>{selected.displayName || "未找到语言文件名称"}</dd><dt>格式</dt><dd>{selected.format || "JSON/资源"}{selected.size ? ` · ${selected.size} bytes` : ""}</dd></dl>{selected.components?.length > 0 && <section className="content-detail-section"><strong>组件与属性</strong><div className="content-chip-list">{selected.components.map(component => <span key={component}>{component}</span>)}</div><pre>{JSON.stringify(selected.componentValues, null, 2)}</pre></section>}{selected.model && <section className="content-detail-section"><strong>模型结构</strong><p>{selected.model.bones} 根骨骼 · {selected.model.cubes} 个 Cube · {selected.model.textureWidth || "?"}×{selected.model.textureHeight || "?"} 贴图</p><div className="content-chip-list">{selected.model.boneNames?.slice(0, 24).map(name => <span key={name}>{name}</span>)}</div></section>}{selected.animation && <section className="content-detail-section"><strong>动画摘要</strong><p>时长：{selected.animation.length ?? "未指定"} · 循环：{String(selected.animation.loop)} · 骨骼轨道：{selected.animation.bones}</p></section>}{selected.entity && <section className="content-detail-section"><strong>实体关联</strong><p>Geometry：{selected.entity.geometry?.join("、") || "未提取"}</p><p>贴图：{selected.entity.textures?.join("、") || "未提取"}</p><p>动画：{selected.entity.animations?.join("、") || "未提取"}</p></section>}<p className="muted">当前只读浏览，不会修改模组文件；运行时是否成功加载需要在游戏会话中单独验证。</p></div></Modal>}
  </section>;
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
