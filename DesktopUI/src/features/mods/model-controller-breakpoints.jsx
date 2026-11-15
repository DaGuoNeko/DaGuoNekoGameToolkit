import React from "react";
import { Button } from "../../app/ui.jsx";

export function ModelControllerBreakpoints({ states, breakpoints, onChange, disabled }) {
  return <details className="model-controller-breakpoints">
    <summary>状态断点 · {breakpoints.length}</summary>
    <div className="model-breakpoint-list" role="group" aria-label="状态断点列表">
      {states.map(name => <label key={name} title={name}><input type="checkbox" aria-label={"进入状态时暂停 " + name} disabled={disabled} checked={breakpoints.includes(name)} onChange={event => {
        const checked = event.target.checked;
        onChange(current => checked ? current.includes(name) ? current : [...current, name] : current.filter(item => item !== name));
      }} /><span>{name}</span></label>)}
    </div>
    <Button disabled={disabled || !breakpoints.length} onClick={() => onChange([])}>清除状态断点</Button>
    <p className="model-texture-note">进入勾选状态后暂停；继续播放或单步会从暂停处运行。断点只在当前控制器内保留。</p>
  </details>;
}
