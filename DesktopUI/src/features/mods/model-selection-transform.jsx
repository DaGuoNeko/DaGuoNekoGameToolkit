import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal } from "../../app/ui.jsx";
import { transformSelectedPixels } from "../../../shared/paint-selection.cjs";

export function SelectionTransform({ draft, onApply, onClose }) {
  const resizing = draft.mode === "resize", action = resizing ? "缩放" : "旋转";
  const [angle, setAngle] = useState("15"), [error, setError] = useState("");
  const [size, setSize] = useState({ width: String(draft.selection.w), height: String(draft.selection.h) });
  const [locked, setLocked] = useState(true);
  const canvas = useRef(null), lastAxis = useRef("width");
  const changeSize = (axis, text, keepRatio = locked) => {
    lastAxis.current = axis; setError("");
    setSize(current => {
      const next = { ...current, [axis]: text }, value = Number(text);
      if (keepRatio && text.trim() && Number.isInteger(value) && value >= 1 && value <= 2048) {
        const other = axis === "width" ? "height" : "width";
        const ratio = axis === "width" ? draft.selection.h / draft.selection.w : draft.selection.w / draft.selection.h;
        next[other] = String(Math.max(1, Math.round(value * ratio)));
      }
      return next;
    });
  };
  const preview = useMemo(() => {
    try {
      const operation = resizing ? { type: "resize", width: size.width.trim() ? Number(size.width) : NaN, height: size.height.trim() ? Number(size.height) : NaN }
        : { type: "rotateAngle", angle: angle.trim() ? Number(angle) : NaN };
      return transformSelectedPixels(draft.image, draft.selection, operation);
    }
    catch (reason) { return { error: reason.message }; }
  }, [draft, angle, size, resizing]);
  useEffect(() => {
    const node = canvas.current;
    if (!node || preview.error) return;
    node.width = preview.width; node.height = preview.height;
    node.getContext("2d").putImageData(new ImageData(preview.data, preview.width, preview.height), 0, 0);
  }, [preview]);
  return <Modal title={action + "选区"} onClose={onClose} description={draft.target === "mask" ? "预览当前图层蒙版；应用后更新三维合成预览。" : "预览当前图层；应用后更新三维合成预览。"}
    footer={<><Button onClick={onClose}>取消</Button><Button primary disabled={!!preview.error} onClick={() => { try { onApply(preview); onClose(); } catch (reason) { setError(reason.message); } }}>应用{action}</Button></>}>
    {resizing ? <>
      <p className="model-texture-note">原选区：{draft.selection.w} × {draft.selection.h} 像素</p>
      <div className="model-selection-size">{[["width", "选区宽度"], ["height", "选区高度"]].map(([axis, label]) => <Field key={axis} label={label}><input type="number" min="1" max="2048" step="1" value={size[axis]} onChange={event => changeSize(axis, event.target.value)} /></Field>)}</div>
      <label className="model-check"><input type="checkbox" checked={locked} onChange={event => { setLocked(event.target.checked); if (event.target.checked) changeSize(lastAxis.current, size[lastAxis.current], true); }} />锁定原比例</label>
      <div className="model-selection-presets" role="group" aria-label="选区缩放预设">{[0.5, 1, 2].map(factor => <Button key={factor} onClick={() => { setSize({ width: String(Math.max(1, Math.round(draft.selection.w * factor))), height: String(Math.max(1, Math.round(draft.selection.h * factor))) }); lastAxis.current = "width"; setError(""); }}>{factor * 100}%</Button>)}</div>
    </> : <>
      <Field label="选区旋转角度" hint="单位：度，顺时针为正"><input type="number" min="-360" max="360" step="0.1" value={angle} onChange={event => { setAngle(event.target.value); setError(""); }} /></Field>
      <div className="model-selection-presets" role="group" aria-label="旋转角度预设">{[-90, -45, 45, 90].map(value => <Button key={value} onClick={() => { setAngle(String(value)); setError(""); }}>{value}°</Button>)}</div>
    </>}
    {!preview.error && <><p className="model-texture-note" role="status">{action}后选区：{preview.selection.w} × {preview.selection.h} 像素</p><div className="model-uv-template model-selection-preview"><canvas ref={canvas} aria-label={"选区" + action + "预览"} /></div></>}
    <p className="model-texture-note">{resizing ? "左上角不动，像素和选区形状一起缩放。按原图最近邻取色，不平滑；缩小会丢失细节，孔洞保留背景。锁定比例按原选区计算，另一边四舍五入且至少 1 像素。预览从原图重算，应用后可一次撤销。" : "外接框左上角保持不动，孔洞和边角保留背景。最近邻采样保留像素颜色和透明度，但斜向旋转可能丢失细节；调整角度始终从原图预览，应用后可一次撤销。"}</p>
    <ErrorBox>{preview.error || error}</ErrorBox>
  </Modal>;
}
