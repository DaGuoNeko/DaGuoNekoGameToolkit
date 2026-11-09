import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, ErrorBox, Select } from "../../app/ui.jsx";
import { labels } from "../../../shared/world-data-model.cjs";
import { useWorkspaceState } from "../../app/workspaces.jsx";
import "./world-data.css";
const call = (name, args = {}) => window.toolkit.call(name, args);
const states = { resolved: "已找到", "not-found": "当前范围未找到", ambiguous: "身份不唯一", unknown: "无法静态判断" };
const changes = { added: "新增", removed: "删除", changed: "字段变化", ambiguous: "身份不唯一" };

export function WorldData({ source, worldId, data, onData, onSource, onLocate, selectedId, onSelected }) {
  const [query, setQuery] = useWorkspaceState("world-data-query", ""), [kind, setKind] = useWorkspaceState("world-data-kind", "");
  const [mode, setMode] = useWorkspaceState("world-data-mode", "objects");
  const [scope, setScope] = useWorkspaceState("world-data-scope", "gameplay");
  const [page, setPage] = useState(0), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(null), [comparison, setComparison] = useWorkspaceState("world-comparison:" + source, null);
  const active = useRef(""), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (active.current) call("world-data.cancel", { requestId: active.current }).catch(() => {}); }; }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => call("world-data.state", { requestId: active.current }).then(value => { if (alive.current) setProgress(value); }).catch(() => {}), 350);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { setPage(0); }, [query, kind, data]);
  const rows = useMemo(() => (data?.objects || []).map(row => ({ row, search: `${row.name} ${row.identity} ${JSON.stringify(row.value)}`.toLowerCase() })), [data]);
  const filtered = useMemo(() => rows.filter(({ row, search }) => (!kind || row.kind === kind) && (!query || search.includes(query.toLowerCase()))).map(({ row }) => row), [rows, kind, query]);
  const selected = data?.objects.find(row => row.id === selectedId) || filtered[0];
  const selectedText = useMemo(() => selected ? JSON.stringify(selected.value, null, 2) : "", [selected]);
  const selectedEvidence = useMemo(() => selected ? JSON.stringify({ ...selected.evidence, types: selected.types }, null, 2) : "", [selected]);
  const relations = (data?.relations || []).filter(edge => !query || `${edge.target} ${edge.rule} ${edge.field}`.toLowerCase().includes(query.toLowerCase()));
  const run = async (compareSource) => {
    if (active.current) return;
    const id = crypto.randomUUID(); active.current = id; setBusy(true); setError(""); setNotice("");
    try {
      const result = await call("world-data.scan", { requestId: id, scope: compareSource ? data.scope : scope, ...(compareSource ? { source: compareSource } : worldId ? { worldId } : { source }) });
      if (!alive.current) return;
      if (compareSource) {
        const diff = await call("world-data.compare", { left: data.requestId, right: result.requestId });
        if (alive.current) { setComparison({ ...diff, rightRequestId: result.requestId }); setMode("compare"); }
      } else { onData(result); setComparison(null); onSelected(""); }
    } catch (e) { if (alive.current) setError(e.message); }
    finally { active.current = ""; if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const choose = async (kind, compare = false) => {
    try { const value = await call("map-preview.pick", { kind }); if (value) { if (compare) await run(value); else onSource({ source: value, worldId: "" }); } }
    catch (e) { setError(e.message); }
  };
  const exportData = async (format, compareWith) => {
    try { if (await call("world-data.export", { requestId: data.requestId, format, kind, compareWith })) setNotice("数据已导出"); }
    catch (e) { setError(e.message); }
  };
  return <section className="world-data" aria-label="世界数据">
    <div className="workspace-actions">
      <Select aria-label="读取范围" disabled={busy} value={scope} onChange={setScope} options={[{ value: "gameplay", label: "交互对象与业务数据" }, { value: "all", label: "全部受支持记录" }, { value: "world", label: "世界与玩家数据" }, { value: "entities", label: "实体与业务数据" }]} />
      <Button primary disabled={busy || (!source && !worldId)} onClick={() => run()}>扫描已保存数据</Button>
      {!worldId && <><Button disabled={busy} onClick={() => choose("folder")}>选择外部文件夹</Button><Button disabled={busy} onClick={() => choose("archive")}>选择 ZIP / MCWORLD</Button></>}
      {busy && <Button onClick={() => call("world-data.cancel", { requestId: active.current }).catch(e => setError(e.message))}>取消扫描</Button>}
      <Button disabled={!data || busy} onClick={() => choose("folder", true)}>比较另一目录</Button>
      <Button disabled={!data || busy} onClick={() => choose("archive", true)}>比较另一压缩包</Button>
      <Button disabled={!data || busy} onClick={() => exportData("json")}>导出 JSON</Button>
      <Button disabled={!data || busy} onClick={() => exportData("csv")}>导出当前类型 CSV</Button>
      <Button disabled={!data || busy} onClick={() => exportData("svg")}>导出关系图</Button>
      {comparison && <Button disabled={busy} onClick={() => exportData("json", comparison.rightRequestId)}>导出差异 JSON</Button>}
    </div>
    <ErrorBox>{error}</ErrorBox>{notice && <p role="status">{notice}</p>}
    {busy && <p role="status">{progress?.stage || "准备读取"} · {progress?.completed ?? 0} <progress aria-label="扫描进度" /></p>}
    {data && <><div className="data-coverage"><strong>{data.complete ? "受支持记录扫描完成" : "部分结果，请检查覆盖与错误"}</strong><span>{data.objects.length} 个对象 · {data.statistics.failed} 处读取失败{data.truncated ? " · 已达到读取上限" : ""} · 范围：{{ all: "全部受支持记录", gameplay: "交互对象与业务数据", world: "世界与玩家数据", entities: "实体与业务数据" }[data.scope]}</span><small>{new Date(data.generatedAt).toLocaleString()} · {data.source}</small><p>{data.coverage}</p></div>
      <div className="data-toolbar"><input aria-label="搜索世界数据" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索名称、坐标、标识符或字段内容…" /><Select aria-label="数据类型" value={kind} onChange={setKind} options={[{ value: "", label: "全部对象" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} />
      <Select aria-label="数据视图" value={mode} onChange={setMode} options={[{ value: "objects", label: "对象与字段" }, { value: "relations", label: "关系检查" }, { value: "graph", label: "关系图" }, { value: "compare", label: "存档比较" }]} /></div>
      {mode === "objects" && <div className="data-layout"><div className="data-results"><div className="data-list-summary">{filtered.length} 项 · 第 {page + 1} 页</div>{filtered.slice(page * 100, (page + 1) * 100).map(row => <button className={selected?.id === row.id ? "selected" : ""} key={row.id} onClick={() => onSelected(row.id)}><strong>{String(row.name)}</strong><small>{labels[row.kind]} · {row.position?.join(", ") || row.identity}</small></button>)}<div className="workspace-actions"><Button disabled={!page} onClick={() => setPage(page - 1)}>上一页</Button><Button disabled={(page + 1) * 100 >= filtered.length} onClick={() => setPage(page + 1)}>下一页</Button></div></div>
      <aside className="data-detail">{selected ? <><h3>{String(selected.name)}</h3><p>{labels[selected.kind]} · {selected.rule}</p>{selected.position && <><p>维度 {selected.dimension ?? "未知"} · {selected.position.join(", ")}</p><Button disabled={![0, 1, 2].includes(selected.dimension)} onClick={() => onLocate(selected)}>在地图定位</Button></>}<details><summary>来源与原始类型</summary><pre>{selectedEvidence}</pre></details><h4>已保存字段</h4><pre>{selectedText}</pre></> : <Empty title="没有匹配对象">调整搜索或类型筛选。</Empty>}</aside></div>}
      {mode === "relations" && <><p className="muted">“当前范围未找到”不等于目标不存在；外部物品定义及动态脚本不参与完整性结论。旧指令库接管关系需结合配置确认。</p><div className="data-table"><table><thead><tr><th>引用目标</th><th>结果</th><th>依据</th><th>来源</th></tr></thead><tbody>{relations.slice(0, 1000).map((edge, i) => <tr key={i}><td>{edge.target}</td><td>{states[edge.status]}</td><td>{edge.rule}<small>{edge.field}</small></td><td><Button onClick={() => { onSelected(edge.from); setMode("objects"); }}>查看来源</Button>{edge.to && <Button onClick={() => { onSelected(edge.to); setMode("objects"); }}>查看目标</Button>}</td></tr>)}</tbody></table></div>{relations.length > 1000 && <p>展示前 1000 条，请搜索缩小范围。</p>}</>}
      {mode === "graph" && <RelationGraph objects={data.objects} edges={relations} onSelect={id => { onSelected(id); setMode("objects"); }} />}
      {mode === "compare" && (comparison ? <><p>{comparison.left} → {comparison.right}</p><p>{comparison.changes.length} 处对象变化{comparison.partial ? " · 来源包含未解析或截断数据，不能据此断言删除" : ""}{comparison.truncated ? " · 差异列表已截断" : ""}</p>{comparison.changes.map(row => <DifferenceRow key={row.identity} row={row} />)}</> : <Empty title="选择另一份存档进行比较">使用上方比较按钮；按稳定对象身份比较已保存字段，来源保持只读。</Empty>)}
      <details className="data-issues"><summary>解析规则与读取问题（{data.statistics.failed}）</summary><p>{data.rules.join("、")}</p>{data.issues.map((issue, i) => <p key={i}>{issue.key}：{issue.message}</p>)}</details>
    </>}
    {!data && <Empty title="查看世界中已保存的数据">扫描命令方块、实体、容器和世界业务数据。不会执行指令、启动游戏或修改存档。</Empty>}
  </section>;
}
const DifferenceRow = React.memo(function DifferenceRow({ row }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => open ? JSON.stringify(row, null, 2) : "", [row, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{changes[row.status]} · {String(row.name)} · {row.identity}</summary>{open && <pre>{text}</pre>}</details>;
});
function RelationGraph({ objects, edges, onSelect }) {
  const shown = edges.slice(0, 30), index = new Map(objects.map(row => [row.id, row]));
  return <div className="data-graph"><p>显示筛选后的前 {shown.length} 条引用；实线表示已找到，虚线表示未解析或当前范围未找到。点击对象查看字段证据。</p>
    <svg viewBox={`0 0 800 ${Math.max(90, shown.length * 70)}`} role="img" aria-label="存档对象关系图">{shown.map((edge, i) => <g key={i} transform={`translate(0, ${i * 70 + 10})`}><line x1="275" x2="525" y1="25" y2="25" stroke="currentColor" strokeDasharray={edge.to ? undefined : "5 5"} /><text x="400" y="16" textAnchor="middle">{states[edge.status]}</text><g role="button" tabIndex={0} aria-label="查看引用来源" onClick={() => onSelect(edge.from)} onKeyDown={e => { if (e.key === "Enter") onSelect(edge.from); }}><rect x="5" width="270" height="50" rx="6" /><text x="15" y="30">{String(index.get(edge.from)?.name || edge.from).slice(0, 22)}</text></g><g role={edge.to ? "button" : undefined} tabIndex={edge.to ? 0 : undefined} aria-label="查看引用目标" onClick={() => edge.to && onSelect(edge.to)} onKeyDown={e => { if (e.key === "Enter" && edge.to) onSelect(edge.to); }}><rect x="525" width="270" height="50" rx="6" /><text x="535" y="30">{edge.target.slice(0, 28)}</text></g></g>)}</svg>
  </div>;
}
