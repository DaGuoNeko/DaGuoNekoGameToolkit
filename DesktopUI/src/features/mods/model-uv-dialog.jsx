import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal } from "../../app/ui.jsx";
import { packUv, templateRects, repackTexture } from "../../../shared/model-uv.cjs";

export function ModelUvDialog({ mode, bones, width, height, name, texture, sources, onApply, onClose }) {
  const repacking = mode === "repack", packing = mode === "pack" || repacking;
  const [padding, setPadding] = useState(1);
  const [targetWidth, setTargetWidth] = useState(String(width)), [targetHeight, setTargetHeight] = useState(String(height));
  const [textureName, setTextureName] = useState(name + "_template");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), canvas = useRef(null);
  const preview = useMemo(() => {
    try {
      if (repacking) {
        if (!texture || texture.width !== width || texture.height !== height) throw Error("当前贴图尺寸必须与模型 UV 分辨率一致");
        return repackTexture(bones, texture, Number(targetWidth), Number(targetHeight), padding, sources);
      }
      const result = packing ? packUv(bones, width, height, padding) : { bones };
      return { ...result, rectangles: templateRects(result.bones, width, height) };
    } catch (reason) { return { error: reason.message }; }
  }, [bones, width, height, padding, packing, repacking, texture, sources, targetWidth, targetHeight]);
  useEffect(() => {
    const node = canvas.current;
    if (!node || preview.error) return;
    node.width = repacking ? preview.width : width; node.height = repacking ? preview.height : height;
    const ctx = node.getContext("2d");
    if (repacking) { ctx.putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0); return; }
    for (const { x, y, w, h, color } of preview.rectangles) {
      ctx.fillStyle = "rgb(" + color.map(value => Math.round(value * 0.65)).join(",") + ")";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgb(" + color.join(",") + ")";
      if (w > 2 && h > 2) ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    }
  }, [preview, width, height, repacking]);
  const apply = async () => {
    if (pending.current || preview.error) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await onApply(repacking ? { repack: { width: preview.width, height: preview.height, padding } } : { bones: preview.bones, name: textureName });
      if (result !== false) onClose();
    }
    catch (reason) { setError(reason.message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title={repacking ? "带贴图重排 UV" : packing ? "自动排列 UV" : "生成贴图模板"} busy={busy} onClose={onClose}
    description={repacking ? "按每个面的贴图来源合并为单张图集，再同步搬移 UV。" : packing ? "排列整个模型；盒子 UV 保持整体，按面 UV 分别排列。" : "按当前 UV 新建分面着色 PNG，空白区域透明。"}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button primary disabled={busy || !!preview.error} onClick={apply}>{busy ? "生成中…" : repacking ? "导出重排工程" : packing ? "应用排列" : "生成模板"}</Button></>}>
    {repacking && <div className="model-selection-size"><Field label="重排贴图宽"><input type="number" min="1" max="2048" step="1" value={targetWidth} disabled={busy} onChange={event => setTargetWidth(event.target.value)} /></Field><Field label="重排贴图高"><input type="number" min="1" max="2048" step="1" value={targetHeight} disabled={busy} onChange={event => setTargetHeight(event.target.value)} /></Field></div>}
    {packing ? <Field label="间距（像素）"><input type="number" min="0" max="16" step="1" disabled={busy} value={Number.isFinite(padding) ? padding : ""} onChange={event => setPadding(event.target.value.trim() ? Number(event.target.value) : NaN)} /></Field>
      : <Field label="模板名称"><input value={textureName} onChange={event => setTextureName(event.target.value)} disabled={busy} /></Field>}
    <p className="model-texture-note">{repacking ? targetWidth : width} × {repacking ? targetHeight : height} 像素{preview.rectangles ? " · " + preview.rectangles.length + " 个面" : ""}{packing && preview.islands ? " · " + preview.islands + " 个 UV 区域" : ""}</p>
    {!preview.error && <div className="model-uv-template model-selection-preview"><canvas ref={canvas} aria-label={repacking ? "贴图重排预览" : packing ? "UV 排列预览" : "贴图模板预览"} /></div>}
    <p className="model-texture-note">{repacking ? "各面按绑定贴图取样，未绑定面使用当前贴图；重叠区域分别复制，空白处透明。导出单张图集与新 UV 的 .bbmodel 副本，保留支持的动画。原模型、贴图和图层保留；副本合并图层，不保留未用像素。含命名材质时拒绝合并，其他工程格式限制仍适用。" : packing ? "只调整 UV 坐标，已有贴图像素不会随之移动。可撤销，保存模型后写回文件。" : "同名文件不会覆盖；重叠 UV 按模型顺序着色。生成后请保存模型的 UV，再一起使用。"}</p>
    <ErrorBox>{preview.error || error}</ErrorBox>
  </Modal>;
}
