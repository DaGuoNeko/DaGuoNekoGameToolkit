import React, { useState } from "react";
import { ErrorBox, Select } from "../../app/ui.jsx";
import { PropertyInput } from "./model-multi-properties.jsx";
import { boneProperty } from "../../../shared/model-bone-properties.cjs";
import { boneSelection } from "../../../shared/model-bone-operations.cjs";

export function MultiBoneProperties({ bones, allBones, disabled, onChange, onParent }) {
  const [mode, setMode] = useState("set"), [error, setError] = useState("");
  const common = (property, axis) => {
    try { const values = bones.map(bone => boneProperty(bone, property)[axis]); return values.every(value => value === values[0]) ? values[0] : null; }
    catch { return null; }
  };
  const commit = (property, axis, value) => {
    try { onChange(property, axis, value, mode); setError(""); return true; }
    catch (reason) { setError(reason.message); return false; }
  };
  const vector = (property, label) => <div className="model-vec" key={property}><span>{label}</span>{["X", "Y", "Z"].map((axis, index) => <PropertyInput key={mode + property + axis} label={"批量骨骼" + label + axis} value={common(property, index)} mode={mode} disabled={disabled} onCommit={value => commit(property, index, value)} />)}</div>;
  let selection;
  try { selection = boneSelection(allBones, bones.map(bone => bone.name)); }
  catch (reason) { return <section aria-label="多选骨骼属性"><ErrorBox>{reason.message}</ErrorBox></section>; }
  const { roots, tree } = selection;
  const parents = roots.map(name => allBones.find(bone => bone.name === name).parent || "");
  const parent = parents.every(name => name === parents[0]) ? parents[0] : null;
  return <section className="model-multi-properties" aria-label="多选骨骼属性">
    <p className="model-texture-note" role="status" aria-label="骨骼选择">已选 {bones.length} 根骨骼</p>
    <Select aria-label="骨骼批量修改方式" value={mode} disabled={disabled} options={[{ value: "set", label: "统一设值" }, { value: "add", label: "按原值增减" }]} onChange={value => { setMode(value); setError(""); }} />
    {vector("pivot", "轴心")}{vector("rotation", "旋转")}
    <Select aria-label="批量父级骨骼" value={parent === null ? "mixed" : "parent:" + parent} disabled={disabled}
      options={[{ value: "mixed", label: "父级：多个值", disabled: true }, { value: "parent:", label: "父级：无" }, ...allBones.filter(bone => !tree.has(bone.name)).map(bone => ({ value: "parent:" + bone.name, label: bone.name }))]}
      onChange={value => { try { onParent(value.slice(7)); setError(""); } catch (reason) { setError(reason.message); } }} />
    <p className="model-texture-note">Enter 或离开输入框应用，Esc 取消。空白不修改；每次只改这一分量。</p>
    <p className="model-texture-note">改父级只移动所选骨骼的最上层，保留内部层级和原数值；旋转父级下的外观可能改变。</p>
    <ErrorBox>{error}</ErrorBox>
  </section>;
}
