import React, { useEffect, useState } from "react";
import { ErrorBox, Select } from "../../app/ui.jsx";
import { cubeProperty } from "../../../shared/model-cube-properties.cjs";

export function PropertyInput({ label, value, mode, disabled, onCommit }) {
  const shown = mode === "add" || value === null ? "" : String(value);
  const [text, setText] = useState(shown), [edited, setEdited] = useState(false);
  useEffect(() => { setText(shown); setEdited(false); }, [shown]);
  const reset = () => { setText(shown); setEdited(false); };
  const commit = () => {
    if (!edited) return;
    if (text.trim() && onCommit(Number(text))) { setEdited(false); if (mode === "add") setText(""); }
    else reset();
  };
  return <input type="number" step="0.5" disabled={disabled} aria-label={label} title={mode === "add" ? "各元素在原值上增减" : value === null ? "所选元素具有多个值" : undefined} value={text} placeholder={mode === "add" ? "增减值" : value === null ? "多个值" : ""}
    onChange={event => { setText(event.target.value); setEdited(true); }} onBlur={commit}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); reset(); } }} />;
}

export function MultiCubeProperties({ cubes, disabled, onChange }) {
  const [mode, setMode] = useState("set"), [error, setError] = useState("");
  const common = (property, axis) => {
    try { const values = cubes.map(cube => { const value = cubeProperty(cube, property); return axis === undefined ? value : value[axis]; }); return values.every(value => value === values[0]) ? values[0] : null; }
    catch { return null; }
  };
  const commit = (property, axis, value, usedMode = mode) => {
    try { onChange(property, axis, value, usedMode); setError(""); return true; }
    catch (reason) { setError(reason.message); return false; }
  };
  const vector = (property, label, axes = ["X", "Y", "Z"], blocked = false) => <div className={"model-vec" + (property === "uv" ? " model-multi-uv" : "")} key={property}><span>{label}</span>{axes.map((axis, index) => <PropertyInput key={mode + property + axis} label={"批量" + label + axis} value={common(property, index)} mode={mode} disabled={disabled || blocked} onCommit={value => commit(property, index, value)} />)}</div>;
  const boxUv = cubes.every(cube => Array.isArray(cube.uv)), mirror = common("mirror");
  return <section className="model-multi-properties" aria-label="多选元素属性">
    <p className="model-texture-note" role="status" aria-label="元素选择">已选 {cubes.length} 个立方体</p>
    <Select aria-label="批量修改方式" value={mode} disabled={disabled} options={[{ value: "set", label: "统一设值" }, { value: "add", label: "按原值增减" }]} onChange={value => { setMode(value); setError(""); }} />
    {vector("origin", "起点")}{vector("size", "尺寸")}{vector("pivot", "轴心")}{vector("rotation", "旋转")}
    <div className="model-vec model-multi-scalar"><span>膨胀</span><PropertyInput key={mode + "inflate"} label="批量膨胀" value={common("inflate")} mode={mode} disabled={disabled} onCommit={value => commit("inflate", undefined, value)} /></div>
    {vector("uv", "UV", ["U", "V"], !boxUv)}
    <Select aria-label="批量镜像贴图" disabled={disabled || !boxUv} value={mirror === null ? "mixed" : String(mirror)} options={[{ value: "mixed", label: "镜像贴图：多个值", disabled: true }, { value: "true", label: "镜像贴图：开启" }, { value: "false", label: "镜像贴图：关闭" }]} onChange={value => commit("mirror", undefined, value === "true", "set")} />
    <p className="model-texture-note">Enter 或离开输入框应用，Esc 取消。空白不修改；每次只改这一分量。尺寸不移动起点，轴心未设置时取立方体中心。</p>
    {!boxUv && <p className="model-texture-note">包含按面 UV，盒子 UV 和镜像贴图批量输入不可用。</p>}
    <ErrorBox>{error}</ErrorBox>
  </section>;
}
