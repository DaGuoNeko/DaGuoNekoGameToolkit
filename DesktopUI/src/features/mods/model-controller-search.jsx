import React from "react";
import { Button } from "../../app/ui.jsx";

export function ModelControllerSearch({ query, onChange, results, total, onLocate, disabled }) {
  return <section className="model-controller-search" aria-label="关系图搜索">
    <div className="model-controller-search-tools">
      <input type="search" aria-label="搜索关系图" value={query} maxLength={256} disabled={disabled} placeholder="搜索状态名、动画引用、转移目标或条件…" onChange={event => onChange(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); onChange(""); }
        if (event.key === "Enter") { event.preventDefault(); if (results[0]) onLocate(results[0].name); }
      }} />
      <Button disabled={disabled || !query} onClick={() => onChange("")}>清除搜索</Button>
    </div>
    {!!query.trim() && <>
      <p role="status" aria-label="关系图搜索结果数量">匹配 {results.length}/{total} 个状态。点击结果仅定位，不改变编辑选择。</p>
      {results.length ? <ul className="model-controller-search-results" aria-label="关系图搜索结果">{results.map(result => <li key={result.name}>
        <Button disabled={disabled} aria-label={"定位匹配状态 " + result.name} onClick={() => onLocate(result.name)}><span><strong>{result.name}</strong><small>{result.reasons.join("、")}</small></span></Button>
      </li>)}</ul> : <p className="model-texture-note">没有匹配的状态，原卡片仍保留。可调整关键词或清除搜索。</p>}
    </>}
  </section>;
}
