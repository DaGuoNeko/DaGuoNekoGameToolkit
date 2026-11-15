import React, { useMemo } from "react";
import { Button } from "../../app/ui.jsx";
import { queryFields, defaultMolangContext, simulationResult } from "../../../shared/molang-context.cjs";

export function ModelMolangContext({ simulation, onChange, disabled = false }) {
  const { enabled, values } = simulation;
  const result = useMemo(() => simulationResult(enabled, values), [enabled, values]);
  return <section className="model-molang-context" aria-label="模拟查询">
    <label className="model-check"><input type="checkbox" aria-label="启用模拟查询" disabled={disabled} checked={enabled} onChange={event => { const enabled = event.target.checked; onChange(current => ({ ...current, enabled })); }} />启用模拟查询</label>
    {enabled && <>
      <div className="model-molang-flags">{queryFields.filter(field => field.type === "boolean").map(field => {
        const key = "query." + field.key;
        return <label className="model-check" key={key} title={key}><input type="checkbox" aria-label={"模拟" + field.label} disabled={disabled} checked={values[key] === 1} onChange={event => { const value = event.target.checked ? 1 : 0; onChange(current => ({ ...current, values: { ...current.values, [key]: value } })); }} />{field.label}</label>;
      })}</div>
      {queryFields.filter(field => field.type === "number").map(field => {
        const key = "query." + field.key;
        return <label className="model-sound-name" key={key} title={key}>{field.label}<input aria-label={"模拟" + field.label} disabled={disabled} type="number" step="0.1" min={field.min} max={field.max} value={values[key]}
          onChange={event => { const value = event.target.value; onChange(current => ({ ...current, values: { ...current.values, [key]: value } })); }} /></label>;
      })}
      <Button disabled={disabled} onClick={() => onChange(current => ({ ...current, values: defaultMolangContext() }))}>重置模拟值</Button>
    </>}
    {result.error && <p role="alert">{result.error}</p>}
    <p className="model-texture-note">{enabled ? "以下值为手动模拟，不来自游戏。播放时即时生效；暂停时只更新姿势，续播后才继续转移。修改不会写入工程。" : "需要预览游戏条件时手动启用；未启用的查询仍会报错。"}</p>
  </section>;
}
