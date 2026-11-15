import React, { useState } from "react";
import { Button, Select } from "../../app/ui.jsx";

export function CubeBoneMove({ bones, count, disabled, keepPose, onKeepPose, onMove }) {
  const [target, setTarget] = useState("");
  const available = bones.some(bone => bone.name === target);
  return <section className="model-bone-move" aria-label="移动所选立方体">
    <div className="model-panel-head"><span>归属骨骼 · {count} 个</span><Button disabled={disabled || !available} onClick={() => onMove(target)}>移入骨骼</Button></div>
    <Select aria-label="目标骨骼" value={available ? target : ""} placeholder="选择目标骨骼" disabled={disabled} options={bones.map(bone => ({ value: bone.name, label: bone.name }))} onChange={setTarget} />
    <label className="model-check"><input type="checkbox" checked={keepPose} disabled={disabled} onChange={event => onKeepPose(event.target.checked)} />保持静止姿态</label>
    <p className="model-texture-note">{keepPose ? "换算位置、轴心和旋转，保持编辑模式下的形状；UV 不变，动画仍继承目标骨骼。" : "保留坐标与 UV，移到目标末尾并继承它的旋转与动画。"}此选项也用于大纲拖动。</p>
  </section>;
}
