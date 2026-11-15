import React, { useEffect, useState } from "react";
import { Button, Select } from "../../app/ui.jsx";
import { blendModes } from "../../../shared/texture-layers.cjs";

export function ModelLayerPanel({ layers, active, editTarget, disabled, onSelect, onTarget, onChange }) {
  const current = layers[active];
  const [name, setName] = useState(current?.name || ""), [opacity, setOpacity] = useState(current?.opacity ?? 100);
  useEffect(() => { setName(current?.name || ""); setOpacity(current?.opacity ?? 100); }, [current?.name, current?.opacity, active]);
  return <section className="model-panel model-layers" aria-label="贴图图层">
    <div className="model-panel-head"><h2>图层</h2><div className="model-texture-actions"><Button icon="plus" compact disabled={disabled || !current} onClick={() => onChange("add")}>新建图层</Button><Button icon="copy" compact disabled={disabled || !current} onClick={() => onChange("duplicate")}>复制图层</Button><Button icon="trash" compact disabled={disabled || !current || layers.length < 2 || current.locked} onClick={() => onChange("delete")}>删除图层</Button></div></div>
    <div className="model-layer-list" role="list" aria-label="图层列表">
      {layers.map((layer, index) => <div key={index} className={"model-layer-row" + (active === index ? " active" : "")} role="listitem">
        <button type="button" className="model-layer-select" disabled={disabled} aria-pressed={active === index} onClick={() => onSelect(index)}>{layer.name}</button>
        <button type="button" disabled={disabled} aria-label={(layer.visible ? "隐藏" : "显示") + "图层 " + layer.name} aria-pressed={layer.visible} onClick={() => onChange("visible", !layer.visible, index)}>{layer.visible ? "显" : "隐"}</button>
        <button type="button" disabled={disabled} aria-label={(layer.locked ? "解锁" : "锁定") + "图层 " + layer.name} aria-pressed={layer.locked} onClick={() => onChange("locked", !layer.locked, index)}>{layer.locked ? "锁" : "开"}</button>
      </div>).reverse()}
    </div>
    {current && <>
      <div className="model-layer-field"><span>混合</span><Select aria-label="图层混合模式" disabled={disabled} value={current.blendMode || "normal"} options={blendModes} onChange={value => onChange("blendMode", value)} /></div>
      <section className="model-layer-mask" aria-label="图层蒙版"><div className="model-panel-head"><span>蒙版</span><Button disabled={disabled || current.locked || !!current.mask} onClick={() => onChange("maskAdd")}>添加蒙版</Button></div>{current.mask && <><div className="model-layer-actions"><Button aria-pressed={editTarget === "image"} disabled={disabled} onClick={() => onTarget("image")}>编辑像素</Button><Button aria-pressed={editTarget === "mask"} disabled={disabled} onClick={() => onTarget("mask")}>编辑蒙版</Button></div><div className="model-layer-actions"><Button disabled={disabled || current.locked} onClick={() => onChange("maskEnabled", !current.mask.enabled)}>{current.mask.enabled ? "停用蒙版" : "启用蒙版"}</Button><Button disabled={disabled || current.locked} onClick={() => onChange("maskInvert")}>反相蒙版</Button><Button disabled={disabled || current.locked || !current.mask.enabled} onClick={() => onChange("maskApply")}>应用蒙版</Button><Button disabled={disabled || current.locked} onClick={() => onChange("maskDelete")}>删除蒙版</Button></div></>}</section>
      <label className="model-layer-field">名称<input aria-label="图层名称" disabled={disabled} maxLength="64" value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (name !== current.name) onChange("name", name); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>
      <label className="model-layer-field">不透明度<input aria-label="图层不透明度" disabled={disabled} type="number" min="0" max="100" value={opacity} onChange={e => setOpacity(Number(e.target.value))} onBlur={() => { if (opacity !== current.opacity) onChange("opacity", opacity); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /><span>%</span></label>
      <div className="model-layer-actions"><Button disabled={disabled || active === layers.length - 1} onClick={() => onChange("up")}>上移</Button><Button disabled={disabled || !active} onClick={() => onChange("down")}>下移</Button><Button disabled={disabled || !active || current.locked || !current.visible || layers[active - 1]?.locked || !layers[active - 1]?.visible} onClick={() => onChange("merge")}>向下合并</Button></div>
      <p className="model-texture-note">绘制目标可切换为图层像素或灰度蒙版。白色显示、黑色隐藏、灰色控制透明度；导出 .bbmodel 使用合成图。</p>
    </>}
  </section>;
}
