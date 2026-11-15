import React from "react";

export function ModelControllerRunNotice({ run }) {
  if (!run) return null;
  const message = run.phase === "waiting" ? "正在等待下一次转移，可随时暂停" : run.phase === "empty" ? "当前状态 " + run.state + " 没有出站转移" :
    "已在 " + run.entry.from + " → " + run.entry.to + " 的第 " + (run.entry.index + 1) + " 条转移后暂停";
  return <p role="status" aria-label="运行到转移状态">{message}</p>;
}

export const ModelControllerTrace = React.memo(function ModelControllerTrace({ records = [] }) {
  return <details className="model-controller-trace">
    <summary>转移记录 · {records.length}/50</summary>
    {records.length ? <ol aria-label="控制器转移记录">{records.slice().reverse().map((row, index) => <li key={index}>
      <span>{row.elapsed.toFixed(3)} 秒 · {row.from} → {row.to} · 第 {row.index + 1} 条</span>
      <code>{String(row.condition)}</code><small>离开状态时：{row.stateTime.toFixed(3)} 秒</small>
    </li>)}</ol> : <p className="model-texture-note">尚未发生转移</p>}
  </details>;
});
