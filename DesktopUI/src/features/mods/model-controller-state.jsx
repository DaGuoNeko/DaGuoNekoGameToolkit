import React, { useEffect, useState } from "react";
import { Button, Select } from "../../app/ui.jsx";

export function StateNameEditor({ name, disabled, onSave }) {
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);
  return <div className="model-controller-state-name">
    <label className="model-sound-name">当前状态名称<input aria-label="当前状态名称" disabled={disabled} value={draft} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); setDraft(name); }
        if (event.key === "Enter") { event.preventDefault(); if (draft.trim() !== name) onSave(draft.trim()); }
      }} /></label>
    <Button disabled={disabled || draft.trim() === name || !draft.trim()} onClick={() => onSave(draft.trim())}>重命名状态</Button>
  </div>;
}

export function ControllerTransitionRow({ row, index, count, states, source, disabled, onSave, onMove, onRemove, onEditingChange, onLocate }) {
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(row.state), [condition, setCondition] = useState(row.condition);
  useEffect(() => { setTarget(row.state); setCondition(row.condition); setEditing(false); }, [row.state, row.condition, index]);
  const label = "转移 " + (index + 1), changed = target !== row.state || condition.trim() !== row.condition;
  const cancel = () => { setTarget(row.state); setCondition(row.condition); setEditing(false); onEditingChange(false); };
  return <section className="model-controller-transition-row" aria-label={label}>
    <div className="model-controller-transition"><span>{index + 1}. {row.state}：{row.condition}</span>
      <Button compact icon="up" disabled={disabled || editing || index === 0} aria-label={"上移" + label} onClick={() => onMove(-1)} />
      <Button compact icon="down" disabled={disabled || editing || index === count - 1} aria-label={"下移" + label} onClick={() => onMove(1)} />
    </div>
    {editing ? <div className="model-controller-transition-edit" onKeyDown={event => { if (!disabled && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <Select aria-label={label + "目标"} disabled={disabled} value={target} options={states.filter(name => name !== source || name === row.state).map(name => ({ value: name, label: name }))} onChange={setTarget} />
      <label className="model-sound-name">条件<input aria-label={label + "条件"} disabled={disabled} value={condition} onChange={event => setCondition(event.target.value)} /></label>
      <div className="model-tools">
        <Button disabled={disabled || !changed || !condition.trim()} onClick={async () => { if (await onSave(target, condition.trim()) === true) { setEditing(false); onEditingChange(false); } }}>保存转移</Button>
        <Button disabled={disabled} onClick={cancel}>取消转移编辑</Button>
      </div>
    </div> : <div className="model-tools">
      <Button disabled={disabled} aria-label={"编辑" + label} onClick={() => { setEditing(true); onEditingChange(true); }}>编辑</Button>
      <Button disabled={disabled} aria-label={"删除" + label} onClick={onRemove}>删除</Button>
      {onLocate && <Button disabled={disabled} aria-label={label + "目标 " + row.state} onClick={onLocate}>查看目标</Button>}
    </div>}
  </section>;
}
