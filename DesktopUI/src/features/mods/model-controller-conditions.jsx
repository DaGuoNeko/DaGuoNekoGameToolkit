import React from "react";

export function ModelControllerConditions({ inspection }) {
  if (!inspection) return null;
  return <section className="model-controller-conditions" aria-label="转移条件检查">
    <p role="status" aria-label="条件检查时刻">{inspection.state} · 状态时间 {inspection.time.toFixed(3)} 秒</p>
    {inspection.rows.length ? <ol>{inspection.rows.map(row => <li key={row.index} data-result={row.status} aria-label={"条件 " + (row.index + 1)}>
      <div><strong>{row.index + 1}. → {row.target}</strong><span>{row.status === "match" ? "当前首个成立" : row.status === "false" ? "不成立" : row.status === "error" ? "表达式错误" : "未检查：第 " + (row.after + 1) + " 条" + (row.reason === "error" ? "报错" : "已成立")}</span></div>
      <code>{String(row.condition)}</code>
      {row.error ? <p className="model-controller-condition-error">{row.error}</p> : row.value !== undefined && <small>计算结果：{String(row.value)}</small>}
    </li>)}</ol> : <p className="model-texture-note">没有出站转移</p>}
    <p className="model-texture-note">这是当前时刻的检查结果，未执行转移；继续播放或单步时会按新的时间重新判断。</p>
  </section>;
}
