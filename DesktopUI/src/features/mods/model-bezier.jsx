import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import { bezierAmount, bezierDraft, bezierPreviewSegment } from "../skins/npc-clip.cjs";

const presets = [
  { value: "linear", label: "线性", control: [1 / 3, 1 / 3, 2 / 3, 2 / 3] },
  { value: "in", label: "缓入", control: [0.42, 0, 1, 1] },
  { value: "out", label: "缓出", control: [0, 0, 0.58, 1] },
  { value: "both", label: "缓入缓出", control: [0.42, 0, 0.58, 1] },
];

export function BezierEditor({ animation, bone, channel, axis, time, onApply, onClose }) {
  const draft = bezierDraft(animation, bone, channel, axis, time);
  const [start, setStart] = useState(draft.start);
  const [control, setControl] = useState(draft.control || presets[3].control);
  const [preset, setPreset] = useState(draft.control ? "custom" : "both"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const board = useRef(null), drag = useRef(null), current = useRef(control), pending = useRef(false);
  current.current = control;
  const preview = useMemo(() => {
    try {
      const segment = bezierPreviewSegment(animation, bone, channel, start);
      const samples = Array.from({ length: segment.steps + 1 }, (_, i) => [i / segment.steps, bezierAmount(i / segment.steps, control)]);
      return { ...segment, samples };
    } catch (reason) { return { error: reason.message }; }
  }, [animation, bone, channel, start, control]);
  const span = drag.current?.span || [Math.min(0, control[1], control[3]), Math.max(1, control[1], control[3])];
  const x = value => 26 + value * 368, y = value => 18 + (span[1] - value) / (span[1] - span[0]) * 184;
  const cancel = () => { if (drag.current) { setControl(drag.current.control); setPreset(drag.current.preset); drag.current = null; } };
  useEffect(() => { window.addEventListener("blur", cancel); return () => window.removeEventListener("blur", cancel); }, []);
  const updatePoint = (index, timeValue, amount) => {
    const next = current.current.slice();
    next[index] = Math.max(index === 2 ? next[0] : 0, Math.min(index === 0 ? next[2] : 1, timeValue));
    next[index + 1] = Math.max(-2, Math.min(3, amount)); setControl(next); setPreset("custom");
  };
  const position = event => {
    const rect = board.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) * 420 / rect.width, py = (event.clientY - rect.top) * 228 / rect.height;
    return [(px - 26) / 368, span[1] - (py - 18) / 184 * (span[1] - span[0])];
  };
  const apply = async () => {
    if (preview.error || pending.current || drag.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await onApply(start, control); onClose(); }
    catch (reason) { setError(reason.message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title="贝塞尔缓动" description={bone + " · " + ({ rotation: "旋转", position: "位移", scale: "缩放" }[channel]) + " " + "XYZ"[axis]} busy={busy} onClose={onClose}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button primary disabled={busy || !!preview.error} onClick={apply}>{busy ? "保存中…" : "生成关键帧"}</Button></>}>
    <div className="model-bezier-fields">
      <Field label="起点关键帧"><Select value={String(start)} disabled={busy} options={draft.starts.map(at => ({ value: String(at), label: at.toFixed(2) + " 秒" }))} onChange={value => { const next = bezierDraft(animation, bone, channel, axis, Number(value)); setStart(next.start); setControl(next.control || presets[3].control); setPreset(next.control ? "custom" : "both"); }} /></Field>
      <Field label="缓动预设"><Select value={preset} disabled={busy} options={[...presets, { value: "custom", label: "自定义" }]} onChange={value => { setPreset(value); const selected = presets.find(item => item.value === value); if (selected) setControl(selected.control); }} /></Field>
    </div>
    {!preview.error && <p className="model-texture-note">{preview.from.toFixed(2)} → {preview.to.toFixed(2)} 秒 · {preview.first[axis]} → {preview.last[axis]} · 新增 {preview.steps - 1} 帧</p>}
    <ErrorBox>{preview.error || error}</ErrorBox>
    {!preview.error && <svg ref={board} className="model-bezier-graph" viewBox="0 0 420 228" preserveAspectRatio="none" role="img" aria-label="贝塞尔缓动预览"
      onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      {[0, 0.5, 1].map(at => <g key={at}><line className="grid" x1={x(at)} y1="18" x2={x(at)} y2="202" /><line className="grid" x1="26" y1={y(at)} x2="394" y2={y(at)} /></g>)}
      <line className="handle" x1={x(0)} y1={y(0)} x2={x(control[0])} y2={y(control[1])} /><line className="handle" x1={x(1)} y1={y(1)} x2={x(control[2])} y2={y(control[3])} />
      {!preview.error && <polyline className="sample" points={preview.samples.map(([t, value]) => x(t) + "," + y(value)).join(" ")} />}
      {[0, 2].map(index => <circle key={index} cx={x(control[index])} cy={y(control[index + 1])} r="7" tabIndex={busy ? -1 : 0} role="slider" aria-label={index ? "终点控制点" : "起点控制点"} aria-valuetext={control[index].toFixed(3) + ", " + control[index + 1].toFixed(3)}
        onPointerDown={event => { if (busy || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { index, span, control: current.current.slice(), preset }; }}
        onPointerMove={event => { if (drag.current?.index === index) updatePoint(index, ...position(event)); }}
        onPointerUp={event => { if (drag.current?.index !== index) return; updatePoint(index, ...position(event)); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => { const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key]; if (busy || !direction) return; event.preventDefault(); const step = event.shiftKey ? 0.1 : 0.01; updatePoint(index, control[index] + direction[0] * step, control[index + 1] + direction[1] * step); }} />)}
      <text x="26" y="222">起点</text><text x="394" y="222" textAnchor="end">终点</text>
    </svg>}
    <div className="model-bezier-fields">{[0, 2].map(index => <fieldset key={index} disabled={busy}><legend>{index ? "终点控制点" : "起点控制点"}</legend>{[0, 1].map(offset => <label key={offset}>{offset ? "数值比例" : "时间比例"}<input aria-label={(index ? "终点" : "起点") + (offset ? "数值比例" : "时间比例")} type="number" step="0.01" min={offset ? -2 : 0} max={offset ? 3 : 1} value={Math.round(control[index + offset] * 10000) / 10000} onChange={event => { const next = control.slice(); next[index + offset] = Number(event.target.value); setControl(next); setPreset("custom"); }} /></label>)}</fieldset>)}</div>
    <p className="model-texture-note">拖动控制点或用方向键调整，Shift 加速；Esc 取消本次拖动。控制点随动画保存，按 0.05 秒生成播放用关键帧。样本未改动时，导出 .bbmodel 会恢复原生贝塞尔控制柄；手工改帧后以实际关键帧导出。应用后可一次撤销。</p>
  </Modal>;
}
