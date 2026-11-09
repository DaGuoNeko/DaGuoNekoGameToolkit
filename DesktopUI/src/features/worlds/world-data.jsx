import React, { useEffect, useRef, useState } from "react";
import { Button, Empty, ErrorBox, Icon, Modal, Select } from "../../app/ui.jsx";
import { labels, kindOrder } from "../../../shared/world-data-model.cjs";
import { useWorkspaceState } from "../../app/workspaces.jsx";
import { Comparison, DataPager, ObjectDetail, Relations, useDataQuery } from "./world-data-views.jsx";
import { ConfirmWrite, EditFieldDialog, VersionSettings } from "./world-data-edit.jsx";
import { cancelWorldData, scanWorldData } from "./use-world-data.jsx";
import "./world-data.css";
const call = (name, args = {}) => window.toolkit.call(name, args);
const scopes = { gameplay: "交互对象与业务数据", all: "全部受支持记录", world: "世界与玩家数据", entities: "实体与业务数据" };
const capabilityStates = { enabled: "存档已启用", disabled: "未确认启用", unconfirmed: "缺少启用清单", ambiguous: "包身份不唯一", "version-mismatch": "启用版本不匹配" };

export function WorldData({ source, worldId, data, load, onData, onSource, onLocate, selectedId, onSelected }) {
  const context = worldId || source;
  const [query, setQuery] = useWorkspaceState("world-data-query:" + context, ""), [kind, setKind] = useWorkspaceState("world-data-kind:" + context, "");
  const [mode, setMode] = useWorkspaceState("world-data-mode:" + context, "objects");
  const { scope, setScope } = load;
  const [offset, setOffset] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [comparing, setComparing] = useState(false), [compareProgress, setCompareProgress] = useState(null), [comparison, setComparison] = useWorkspaceState("world-comparison:" + context, null);
  const busy = load.busy || comparing, progress = load.busy ? load.progress : compareProgress;
  const [editor, setEditor] = useState(null), [writePlan, setWritePlan] = useState(null), [restore, setRestore] = useState(false), [saving, setSaving] = useState(false);
  const [backup, setBackup] = useWorkspaceState("world-data-backup:" + context, null), [history, setHistory] = useState([]), [detailOpen, setDetailOpen] = useState(false);
  const active = useRef(""), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (active.current) cancelWorldData(active.current); }; }, []);
  useEffect(() => {
    if (!comparing) return;
    const timer = setInterval(() => call("world-data.state", { requestId: active.current }).then(value => { if (alive.current) setCompareProgress(value); }).catch(() => {}), 350);
    return () => clearInterval(timer);
  }, [comparing]);
  useEffect(() => { if (data && comparison && comparison.leftRequestId !== data.requestId) setComparison(null); }, [data?.requestId]);
  useEffect(() => { setOffset(0); }, [query, kind, data?.requestId]);
  useEffect(() => { if (data && kind && !data.availableKinds?.includes(kind)) setKind(""); }, [data, kind]);
  const result = useDataQuery(data?.requestId, { kind, query, offset, limit: 50 });
  const targetId = selectedId || result.rows[0]?.id;
  const detail = useDataQuery(data?.requestId && targetId ? data.requestId : null, { id: targetId || "", limit: 1 });
  const selected = detail.rows[0];
  useEffect(() => { if (data && selectedId && detail.requestId === data.requestId && detail.objectId === selectedId && !detail.loading && !detail.error && !detail.rows.length) onSelected(""); }, [data?.requestId, selectedId, detail.requestId, detail.objectId, detail.loading, detail.error, detail.rows]);
  const search = value => { setQuery(value); onSelected(""); setOffset(0); setHistory([]); };
  const category = value => { setKind(value); onSelected(""); setOffset(0); setHistory([]); };
  const select = id => { if (selected) setHistory(previous => [...previous.slice(-19), { id: selected.id, kind, query, offset }]); onSelected(id); setKind(""); setQuery(""); setOffset(0); setMode("objects"); setDetailOpen(true); };
  const back = () => { const previous = history.at(-1); if (!previous) return; setHistory(value => value.slice(0, -1)); onSelected(previous.id); setKind(previous.kind); setQuery(previous.query); setOffset(previous.offset); };
  const run = async compareSource => {
    if (!compareSource) {
      setError(""); setNotice("");
      const result = await load.reload();
      if (result && alive.current) { setComparison(null); if (!editor) onSelected(""); setHistory([]); }
      return result;
    }
    if (active.current) return;
    const id = crypto.randomUUID(); active.current = id; setComparing(true); setError(""); setNotice("");
    try {
      const result = await scanWorldData({ requestId: id, summaryOnly: true, scope: data.scope, source: compareSource }, () => alive.current && active.current === id);
      if (!alive.current) return;
      const diff = await call("world-data.compare", { left: data.requestId, right: result.requestId });
      if (alive.current) { setComparison({ ...diff, leftRequestId: data.requestId, rightRequestId: result.requestId }); setMode("compare"); }
    } catch (e) { if (alive.current) setError(e.message); }
    finally { active.current = ""; if (alive.current) { setComparing(false); setCompareProgress(null); } }
  };
  const choose = async (kind, compare = false) => {
    try { const value = await call("map-preview.pick", { kind }); if (value) { if (compare) await run(value); else if (value === source && !worldId) await run(); else onSource({ source: value, worldId: "" }); } }
    catch (e) { setError(e.message); }
  };
  const exportData = async (format, compareWith) => {
    try { if (await call("world-data.export", { requestId: data.requestId, format, kind, compareWith })) setNotice("数据已导出"); }
    catch (e) { setError(e.message); }
  };
  const saved = async result => {
    setEditor(null); setWritePlan(null); setBackup(result); onData(null);
    const refreshed = await run(); setNotice(refreshed ? "已保存并重新读取。自动备份可用于撤销本次改动。" : "已保存并保留备份；重新读取失败，请重试扫描。");
  };
  const restoreLast = async () => {
    setSaving(true); setError("");
    try { await call("world-data.edit.restore", { requestId: data.requestId, backupId: backup.backupId, confirmed: true }); setBackup(null); setRestore(false); onData(null); const refreshed = await run(); setNotice(refreshed ? "已恢复本次修改前的记录，并重新读取。" : "已恢复备份；重新读取失败，请重试扫描。"); }
    catch (error) { setRestore(false); await run(); setError(error.message); }
    finally { setSaving(false); }
  };
  const kinds = kindOrder.filter(value => data?.availableKinds?.includes(value) && ((data.counts?.[value] || 0) > 0 || ["npc", "quest", "dialogue", "library", "attributes"].includes(value)));
  return <section className="world-data" aria-label="世界数据">
    <header className={`data-hero ${data ? "has-data" : ""}`}><div className="data-hero-title"><span className="data-hero-icon"><Icon name="inspect" /></span><div><h2>探索已保存的世界</h2><p>打开存档后自动加载，随时查看内容、关联与变化。</p></div><span className="data-badge">后台读取</span></div><div className="workspace-actions"><Select aria-label="读取范围" disabled={comparing || load.unavailable} value={scope} onChange={setScope} options={Object.entries(scopes).map(([value, label]) => ({ value, label }))} /><Button icon="inspect" disabled={busy || load.unavailable || (!source && !worldId)} onClick={() => run()}>重新扫描</Button>{busy && <Button onClick={() => load.busy ? load.cancel() : cancelWorldData(active.current)}>取消扫描</Button>}</div>
      {!worldId && <div className="data-source-actions"><Button icon="folder" disabled={comparing} onClick={() => choose("folder")}>选择外部文件夹</Button><Button icon="archive" disabled={comparing} onClick={() => choose("archive")}>选择 ZIP / MCWORLD</Button></div>}
    </header>
    <ErrorBox>{error || load.error}</ErrorBox>{notice && <p role="status">{notice}</p>}{backup && <div className="data-backup-notice"><span>上次保存已自动备份</span><Button disabled={busy || saving || !data} onClick={() => setRestore(true)}>撤销上次保存</Button></div>}{busy && <div className="data-scan-progress" role="status"><progress aria-label="扫描进度" /><span><strong>扫描中，请等待</strong><small>{progress?.stage || "准备读取"} · {progress?.completed ?? 0}</small></span></div>}
    {data ? <>
      <div className="data-overview"><div><span>已读取对象</span><strong>{data.objectCount ?? 0}</strong></div><div><span>已识别引用</span><strong>{data.relationCount ?? 0}</strong></div><div><span>读取问题</span><strong className={data.statistics.failed ? "data-warning" : ""}>{data.statistics.failed}</strong></div><div className="data-overview-status"><strong>{data.complete ? "受支持记录扫描完成" : "部分结果，请检查覆盖与错误"}</strong><span>{new Date(data.generatedAt).toLocaleString()} · {scopes[data.scope]}</span></div></div>
      <details className="data-coverage"><summary><span>{data.edition === "netease" ? "已识别网易扩展" : data.format === "java" ? "Java 存档" : "基岩存档"}</span><span>模组条件与扫描覆盖</span></summary><p>{data.coverage}</p><p>仅核对存档内的启用清单与包内容；额外启动模组未纳入本次判断，配置已启用不代表运行时已成功加载。</p><div className="data-capabilities">{Object.entries(data.capabilities || {}).map(([id, entry]) => <div key={id}><strong>{entry.name}</strong><span className={`data-badge ${entry.state === "enabled" ? "resolved" : ""}`}>{capabilityStates[entry.state]}</span>{entry.packs.map(pack => <small key={pack.id + pack.name}>{pack.name} · {pack.version?.join(".")}</small>)}</div>)}</div><p>{data.extraData ? "已读取网易 ExtraData；未知结构按原始字段展示。" : "本次未读取到网易 ExtraData，这是可选数据，不代表存档异常。"}</p>{data.truncated && <p className="data-warning">读取达到上限，当前仅显示部分结果。</p>}</details>
      <nav className="data-view-tabs" role="tablist" aria-label="数据视图">{[["objects", "对象与字段"], ["relations", "关系检查"], ["graph", "关系图"], ["compare", "存档比较"], ["versions", "版本与兼容"]].map(([value, label]) => <button key={value} role="tab" aria-selected={mode === value} onClick={() => setMode(value)}>{label}</button>)}</nav>
      {!["compare", "versions"].includes(mode) && <div className="data-toolbar"><input aria-label="搜索世界数据" value={query} onChange={e => search(e.target.value)} maxLength={256} placeholder="搜索当前分类中的名称、坐标或内容…" /><span className="data-hint">{data.editable ? "目录存档 · 支持备份后编辑" : "当前来源仅查看"}</span></div>}
      {mode === "objects" && <div className={`data-browser ${detailOpen ? "detail-open" : ""}`}><nav className="data-categories" aria-label="数据分类"><small>内容分类</small><button aria-pressed={!kind} onClick={() => { category(""); setDetailOpen(false); }}>全部<span>{data.objectCount}</span></button>{kinds.map(value => <button key={value} aria-pressed={kind === value} onClick={() => { category(value); setDetailOpen(false); }}>{labels[value]}<span>{data.counts?.[value] || 0}</span></button>)}</nav><div className="data-layout"><div className="data-results"><div className="data-list-summary">{labels[kind] || "全部对象"} <span>{result.loading ? "读取中…" : `${result.total} 项`}</span></div><ErrorBox>{result.error}</ErrorBox>{result.rows.map(row => <button aria-pressed={selected?.id === row.id} className={selected?.id === row.id ? "selected" : ""} key={row.id} onClick={() => { onSelected(row.id); setDetailOpen(true); }}><span className="data-result-kind">{labels[row.kind]}</span><strong>{String(row.name)}</strong><small>{row.summary.description || row.identity}</small>{row.position && <small>{row.position.join(", ")}</small>}</button>)}{!result.loading && !result.rows.length && !result.error && <Empty title="没有匹配对象">相关模组可能尚未保存此类数据，也可调整筛选条件。</Empty>}<DataPager offset={offset} total={result.total} onChange={setOffset} /></div><aside className="data-detail"><div className="data-detail-navigation"><Button className="data-back-list" onClick={() => setDetailOpen(false)}>返回对象列表</Button>{history.length > 0 && <Button onClick={back}>返回上一个对象</Button>}</div><ErrorBox>{detail.error}</ErrorBox>{selectedId && detail.loading ? <p role="status">正在读取对象…</p> : <ObjectDetail key={selected?.id || "empty"} requestId={data.requestId} object={selected} onLocate={onLocate} onSelect={select} onEdit={data.editable && !busy ? field => setEditor({ object: selected, field }) : undefined} />}</aside></div></div>}
      {["relations", "graph"].includes(mode) && <Relations key={mode + data.requestId} requestId={data.requestId} query={query} graph={mode === "graph"} onSelect={select} />}
      {mode === "compare" && (comparison ? <Comparison key={comparison.rightRequestId} comparison={comparison} /> : <Empty title="选择另一份存档进行比较">在下方选择目录或压缩包，查看对象及字段变化。</Empty>)}
      {mode === "versions" && <VersionSettings key={data.requestId} data={busy ? { ...data, editable: false } : data} onPreview={setWritePlan} />}
      <div className="data-actions"><div><Button disabled={busy} onClick={() => choose("folder", true)}>比较另一目录</Button><Button disabled={busy} onClick={() => choose("archive", true)}>比较另一压缩包</Button></div><div><Button disabled={busy} onClick={() => exportData("json")}>导出 JSON</Button><Button disabled={busy} onClick={() => exportData("csv")}>导出当前类型 CSV</Button><Button disabled={busy} onClick={() => exportData("svg")}>导出关系图</Button>{comparison && <Button disabled={busy} onClick={() => exportData("json", comparison.rightRequestId)}>导出差异 JSON</Button>}</div></div>
      <details className="data-issues"><summary>解析规则与读取问题（{data.statistics.failed}）</summary><p>{data.rules.join(" · ")}</p><p>跳过 {data.statistics.ignored} 个不在支持范围内的数据库键；这不表示全部世界状态已被解析。</p>{data.issues.map((issue, i) => <p key={i}><code>{issue.key}</code> · {issue.message}</p>)}</details>
    </> : !busy && <Empty title={load.unavailable ? "存档尚未生成或暂不可用" : load.cancelled ? "扫描已取消" : load.error ? "暂时无法读取世界数据" : "选择要查看的存档"}>{load.unavailable ? "存档生成并保存后会自动读取。" : load.cancelled || load.error ? "点击重新扫描即可再次读取。" : "选择外部目录或压缩包后会自动加载已保存的数据。"}</Empty>}
    {editor && data && <EditFieldDialog requestId={data.requestId} source={source} {...editor} onClose={() => setEditor(null)} onSaved={saved} onRefresh={() => run()} />}
    {writePlan && data && <ConfirmWrite requestId={data.requestId} plan={writePlan} onClose={() => setWritePlan(null)} onSaved={saved} />}
    {restore && <Modal title="恢复上次保存前的记录？" busy={saving} onClose={() => !saving && setRestore(false)} footer={<><Button disabled={saving} onClick={() => setRestore(false)}>取消</Button><Button primary disabled={saving} onClick={restoreLast}>确认恢复备份</Button></>}><p>仅恢复工具箱上次修改的记录。如果游戏或其他工具已改动该记录，恢复会被拒绝。</p></Modal>}
  </section>;
}
