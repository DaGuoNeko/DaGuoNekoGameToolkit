import React, { useEffect, useState } from "react";
import { Button, Empty, ErrorBox, Select } from "../../app/ui.jsx";
import { labels } from "../../../shared/world-data-model.cjs";

export const relationStates = { resolved: "已找到", "not-found": "当前范围未找到", ambiguous: "身份不唯一", unknown: "无法静态判断" };
export function useDataQuery(requestId, args) {
  const key = JSON.stringify(args), [state, setState] = useState({ rows: [], total: 0, loading: true, error: "" });
  useEffect(() => {
    let alive = true;
    setState({ rows: [], total: 0, loading: !!requestId, error: "" });
    if (!requestId) return;
    const timer = setTimeout(() => window.toolkit.call("world-data.query", { requestId, ...JSON.parse(key) }).then(result => {
      if (alive) setState({ ...result, requestId, objectId: JSON.parse(key).id || "", loading: false, error: "" });
    }).catch(error => { if (alive) setState({ rows: [], total: 0, loading: false, error: error.message }); }), 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [requestId, key]);
  return state;
}
export function DataPager({ offset, total, size = 50, onChange }) {
  return <div className="data-pager"><span>{total} 项 · {Math.floor(offset / size) + 1} / {Math.max(1, Math.ceil(total / size))} 页</span><Button disabled={!offset} onClick={() => onChange(Math.max(0, offset - size))}>上一页</Button><Button disabled={offset + size >= total} onClick={() => onChange(offset + size)}>下一页</Button></div>;
}
export function Relations({ requestId, objectId = "", query = "", graph = false, onSelect }) {
  const [direction, setDirection] = useState("both"), [status, setStatus] = useState(""), [offset, setOffset] = useState(0), [focus, setFocus] = useState("");
  const id = objectId || focus;
  useEffect(() => { setOffset(0); }, [id, direction, status, query]);
  const result = useDataQuery(requestId, { view: "relations", id, direction, status, query, offset, limit: 50 });
  return <div className="data-relations">
    <div className="data-toolbar"><Select aria-label="引用方向" value={direction} onChange={setDirection} options={[{ value: "both", label: "全部关联" }, { value: "outgoing", label: "引用了谁" }, { value: "incoming", label: "谁引用了我" }]} disabled={!id} /><Select aria-label="引用结果" value={status} onChange={setStatus} options={[{ value: "", label: "所有结果" }, ...Object.entries(relationStates).map(([value, label]) => ({ value, label }))]} />{focus && <Button onClick={() => setFocus("")}>返回全部关系</Button>}</div>
    <p className="data-hint">根据已支持的字段和命令语法检查。未找到不等于不存在；动态脚本与外部模组不作完整性判断。</p>
    <ErrorBox>{result.error}</ErrorBox>
    {result.loading ? <p role="status">正在读取关联…</p> : result.rows.length ? <div className={graph ? "data-relation-graph" : "data-relation-list"}>{result.rows.map((edge, i) => <article className="data-edge" key={i}>
      <button className="data-edge-node" onClick={() => onSelect(edge.from)}><small>引用来源</small><strong>{edge.fromName || edge.from}</strong></button>
      <div className="data-edge-link"><span aria-hidden="true">→</span><span className={`data-badge ${edge.status}`}>{relationStates[edge.status]}</span><small>{edge.rule}</small></div>
      <button className="data-edge-node" disabled={!edge.to} onClick={() => onSelect(edge.to)}><small>{edge.target}</small><strong>{edge.toName || "尚未解析到目标"}</strong></button>
      <div className="data-edge-evidence"><code>{edge.field}</code>{graph && <><Button onClick={() => setFocus(edge.from)}>展开来源关联</Button>{edge.to && <Button onClick={() => setFocus(edge.to)}>展开目标关联</Button>}</>}</div>
    </article>)}</div> : !result.error && <Empty title="当前范围没有匹配的引用">更换筛选条件；没有静态引用不代表没有运行时调用。</Empty>}
    <DataPager offset={offset} total={result.total} onChange={setOffset} />
  </div>;
}
function FieldBrowser({ requestId, objectId, initialField = "", onEdit }) {
  const [field, setField] = useState(initialField), [offset, setOffset] = useState(0), [notice, setNotice] = useState("");
  const result = useDataQuery(requestId, { view: "fields", id: objectId, field, offset, limit: 50 });
  const navigate = next => { setField(next); setOffset(0); setNotice(""); };
  const copy = async text => { try { await navigator.clipboard.writeText(text); setNotice("已复制"); } catch { setNotice("复制失败，请选择文本后复制"); } };
  return <div className="data-fields"><nav className="data-field-breadcrumbs" aria-label="字段位置"><button onClick={() => navigate("")}>根节点</button>{field.split("/").slice(1).map((part, i, parts) => <React.Fragment key={i}><span>/</span><button onClick={() => navigate("/" + parts.slice(0, i + 1).join("/"))}>{part.replace(/~1/g, "/").replace(/~0/g, "~")}</button></React.Fragment>)}</nav><div className="data-toolbar"><Button disabled={!field} onClick={() => navigate(field.slice(0, field.lastIndexOf("/")))}>上一级</Button><code>{field || "/"}</code><Button onClick={() => copy(field)}>复制路径</Button></div><ErrorBox>{result.error}</ErrorBox>{notice && <p role="status">{notice}</p>}
    {result.loading ? <p role="status">正在读取字段…</p> : result.rows.map(row => <div className="data-field" key={row.field}><div><button disabled={!row.expandable} onClick={() => navigate(row.field)}><span aria-hidden="true">{row.expandable ? "▸" : "·"}</span> {row.key || "值"}</button><small>{row.type}</small></div><pre>{row.preview}{row.truncated ? "\n…预览已截断，完整值请导出 JSON" : ""}</pre><div className="data-field-actions">{onEdit && row.editable && <Button aria-label={"编辑字段 " + (row.key || "值")} onClick={() => onEdit(row.field)}>编辑</Button>}<Button onClick={() => copy(row.expandable ? row.field : row.preview)}>{row.expandable ? "复制路径" : "复制预览"}</Button></div></div>)}
    <DataPager offset={offset} total={result.total} onChange={setOffset} />
  </div>;
}
export function ObjectDetail({ requestId, object, onLocate, onSelect, onEdit }) {
  const [tab, setTab] = useState("summary"), [field, setField] = useState("");
  if (!object) return <Empty title="选择一个对象">从左侧列表开始浏览世界内容。</Empty>;
  const openField = value => { setField(value); setTab("fields"); };
  return <div className="data-object"><header className="data-object-header"><span className="data-badge">{labels[object.kind]}</span><h3>{String(object.name)}</h3><code>{object.identity}</code>{object.position && <div className="data-position"><span>维度 {object.dimension ?? "未知"} · {object.position.join(", ")}</span><Button disabled={![0, 1, 2].includes(object.dimension)} onClick={() => onLocate(object)}>在地图定位</Button></div>}</header>
    {onEdit && object.evidence?.field?.startsWith("/scriptData/") && <Button onClick={() => onEdit("")}>编辑业务内容</Button>}
    <div className="data-tabs" role="tablist" aria-label="对象详情">{[["summary", "业务摘要"], ["relations", "双向引用"], ["fields", "原始字段"], ["evidence", "来源证据"]].map(([id, name]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>)}</div>
    {tab === "summary" && <div className="data-summary">{object.summary?.sections.map((section, i) => <section key={i}><h4>{section.title}<span>{section.total} 项</span></h4>{section.rows.length ? section.rows.map((row, index) => <button className="data-summary-row" key={index} onClick={() => openField(row.field)} title="查看原始字段"><span>{row.label}</span><div><pre>{row.value}</pre>{row.note && <small>{row.note}</small>}</div><span aria-hidden="true">↗</span></button>) : <p className="data-hint">尚未记录内容</p>}{section.total > section.rows.length && <p className="data-hint">显示前 {section.rows.length} 项；原始字段支持分页查看全部内容。</p>}</section>)}{!object.summary?.sections.length && <Empty title="没有可展示的业务字段">可在原始字段中检查保存内容。</Empty>}</div>}
    {tab === "relations" && <Relations requestId={requestId} objectId={object.id} onSelect={onSelect} />}
    {tab === "fields" && <FieldBrowser key={object.id + field} requestId={requestId} objectId={object.id} initialField={field} onEdit={onEdit} />}
    {tab === "evidence" && <section className="data-evidence"><p>{object.rule}</p><p className="data-hint">这些信息用于追溯磁盘中的保存记录，不表示游戏已经成功执行。</p><pre>{JSON.stringify(object.evidence, null, 2)}</pre><Button onClick={() => openField("")}>查看字段及原始类型</Button></section>}
  </div>;
}
const changeNames = { added: "新增", removed: "删除", changed: "字段变化", ambiguous: "身份不唯一", "not-observed-right": "右侧未读到", "not-observed-left": "左侧未读到" };
export function Comparison({ comparison }) {
  const [kind, setKind] = useState(""), [offset, setOffset] = useState(0);
  const rows = comparison.changes.filter(row => !kind || row.kind === kind);
  const kinds = [...new Set(comparison.changes.map(row => row.kind).filter(Boolean))];
  return <div className="data-comparison"><div className="data-comparison-head"><h3>{comparison.changes.length} 处对象变化</h3><Select aria-label="差异类型" value={kind} onChange={value => { setKind(value); setOffset(0); }} options={[{ value: "", label: "全部类型" }, ...kinds.map(value => ({ value, label: labels[value] }))]} /></div><div className="data-sources"><span>比较前<small>{comparison.left}</small></span><span>比较后<small>{comparison.right}</small></span></div>
    {comparison.partial && <p className="data-hint">扫描范围、模组条件不同或数据不完整，未读到的对象不能判定为新增或删除。</p>}{comparison.truncated && <p className="data-hint">差异达到上限；请缩小读取范围并核对双方导出。</p>}
    {rows.slice(offset, offset + 50).map(row => <Difference key={row.identity} row={row} />)}<DataPager offset={offset} total={rows.length} onChange={setOffset} /></div>;
}
function Difference({ row }) {
  const [open, setOpen] = useState(false);
  return <details className="data-difference" onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="data-badge">{changeNames[row.status]}</span> · {String(row.name)}<small>{row.identity}</small></summary>{open && <div>{row.fields.map((field, i) => <div className="data-diff-field" key={i}><strong>{field.label || field.path}</strong><div><pre aria-label="比较前">{JSON.stringify(field.before, null, 2) ?? "未记录"}</pre><pre aria-label="比较后">{JSON.stringify(field.after, null, 2) ?? "未记录"}</pre></div></div>)}{row.fieldsTruncated && <p>字段列表已截断，完整值请核对双方 JSON。</p>}<details><summary>比较来源</summary><pre>{JSON.stringify({ before: row.before, after: row.after }, null, 2)}</pre></details></div>}</details>;
}
