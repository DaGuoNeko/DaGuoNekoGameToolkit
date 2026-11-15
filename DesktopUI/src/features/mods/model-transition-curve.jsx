import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import { readTransition, writeTransition, linearPoints, moveTransitionPoint, addTransitionPoint, removeTransitionPoint } from "../../../shared/controller-transition-curve.cjs";

const presets = [
  { value: "linear", label: "线性", points: linearPoints() },
  { value: "in", label: "缓入", points: [{ time: 0, value: 1 }, { time: 0.25, value: 0.95 }, { time: 0.5, value: 0.8 }, { time: 0.75, value: 0.45 }, { time: 1, value: 0 }] },
  { value: "out", label: "缓出", points: [{ time: 0, value: 1 }, { time: 0.25, value: 0.55 }, { time: 0.5, value: 0.2 }, { time: 0.75, value: 0.05 }, { time: 1, value: 0 }] },
];

function PointFields({ points, index, disabled, onChange, onError }) {
  const point = points[index];
  const [draft, setDraft] = useState([String(point.time), String(point.value)]);
  useEffect(() => { setDraft([String(point.time), String(point.value)]); }, [point.time, point.value]);
  return ["时间比例", "源状态权重"].map((label, field) => <Field key={label} label={label}><input type="number" step="0.01" min="0" max="1" value={draft[field]} disabled={disabled} onChange={event => {
    const next = draft.slice(); next[field] = event.target.value; setDraft(next);
    try {
      const [time, value] = next.map(text => text.trim() ? Number(text) : NaN);
      onChange(moveTransitionPoint(points, index, time, value));
      onError("");
    } catch (reason) { onError(reason.message); }
  }} /></Field>);
}

export function TransitionCurveEditor({ state, onApply, onClose }) {
  const initial = useMemo(() => readTransition(state), [state]);
  const [duration, setDuration] = useState(String(initial.duration || 1));
  const [points, setPoints] = useState(initial.points || linearPoints());
  const [preset, setPreset] = useState(initial.points ? "custom" : "linear");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState(""), [saveError, setSaveError] = useState(""), [busy, setBusy] = useState(false);
  const board = useRef(null), drag = useRef(null), current = useRef(points), pending = useRef(false);
  current.current = points;
  const preview = useMemo(() => {
    try {
      if (!duration.trim()) throw Error("时长不能为空");
      const seconds = Number(duration);
      const curve = preset === "linear" ? null : points;
      return { value: writeTransition(state, seconds, curve), seconds, curve };
    } catch (reason) { return { error: reason.message }; }
  }, [state, duration, points, preset]);
  const x = at => 26 + at * 368, y = value => 18 + (1 - value) * 184;
  const cancel = () => {
    if (!drag.current) return;
    const mark = drag.current; drag.current = null; setPoints(mark.points); setPreset(mark.preset); setError("");
  };
  useEffect(() => { window.addEventListener("blur", cancel); return () => window.removeEventListener("blur", cancel); }, []);
  const change = (index, time, value) => {
    try { setPoints(moveTransitionPoint(current.current, index, time, value)); setPreset("custom"); setError(""); }
    catch (reason) { setError(reason.message); }
  };
  const move = (event, index) => {
    const rect = board.current.getBoundingClientRect(), values = current.current;
    const px = ((event.clientX - rect.left) * 420 / rect.width - 26) / 368;
    const py = 1 - ((event.clientY - rect.top) * 228 / rect.height - 18) / 184;
    const time = Math.max(values[index - 1].time + 0.000001, Math.min(values[index + 1].time - 0.000001, px));
    change(index, Number(time.toFixed(6)), Number(Math.max(0, Math.min(1, py)).toFixed(6)));
  };
  const apply = async () => {
    if (preview.error || error || drag.current || pending.current) return;
    pending.current = true; setBusy(true); setSaveError("");
    try { const result = await onApply(preview.seconds, preview.curve); if (result !== true) throw Error(result?.error || "曲线未保存，请重试"); onClose(); }
    catch (reason) { setSaveError(reason.message); }
    finally { pending.current = false; setBusy(false); }
  };
  const point = points[selected], endpoint = selected === 0 || selected === points.length - 1;
  return <Modal title="状态过渡曲线" description="横轴：过渡时间比例；纵轴：源状态剩余权重。点之间使用直线插值。" busy={busy} onClose={onClose}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button primary disabled={busy || !!preview.error || !!error} onClick={apply}>{busy ? "保存中…" : "应用过渡曲线"}</Button></>}>
    <div className="model-bezier-fields">
      <Field label="过渡时长（秒）"><input type="number" min="0" max="60" step="0.05" disabled={busy} value={duration} onChange={event => setDuration(event.target.value)} /></Field>
      <Field label="曲线预设"><Select disabled={busy} value={preset} options={[...presets, { value: "custom", label: "自定义" }]} onChange={value => {
        setPreset(value); const found = presets.find(item => item.value === value);
        if (found) { setPoints(found.points.map(point => ({ ...point }))); setSelected(0); }
        setError("");
      }} /></Field>
    </div>
    <ErrorBox>{preview.error || error || saveError}</ErrorBox>
    <svg ref={board} className="model-bezier-graph" viewBox="0 0 420 228" preserveAspectRatio="none" role="img" aria-label="状态过渡曲线预览"
      onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      {[0, 0.5, 1].map(at => <g key={at}><line className="grid" x1={x(at)} y1="18" x2={x(at)} y2="202" /><line className="grid" x1="26" y1={y(at)} x2="394" y2={y(at)} /></g>)}
      <polyline className="sample" points={points.map(point => x(point.time) + "," + y(point.value)).join(" ")} />
      {points.map((point, index) => <circle key={index} cx={x(point.time)} cy={y(point.value)} r={selected === index ? 8 : 6} tabIndex={busy ? -1 : 0}
        role="slider" aria-label={"过渡曲线点 " + index} aria-valuetext={point.time.toFixed(3) + ", " + point.value.toFixed(3)}
        onFocus={() => setSelected(index)}
        onPointerDown={event => {
          if (busy || event.button !== 0) return;
          event.preventDefault(); event.currentTarget.focus(); setSelected(index);
          if (index === 0 || index === points.length - 1) return;
          event.currentTarget.setPointerCapture(event.pointerId); drag.current = { index, points: current.current, preset };
        }}
        onPointerMove={event => { if (drag.current?.index === index) move(event, index); }}
        onPointerUp={event => { if (drag.current?.index !== index) return; drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => {
          const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
          if (busy || !direction || !index || index === points.length - 1) return;
          event.preventDefault(); const step = event.shiftKey ? 0.1 : 0.01;
          change(index, Number((point.time + direction[0] * step).toFixed(6)), Number((point.value + direction[1] * step).toFixed(6)));
        }} />)}
      <text x="26" y="222">开始：1</text><text x="394" y="222" textAnchor="end">结束：0</text>
    </svg>
    <Field label="选中曲线点"><Select disabled={busy} value={String(selected)} options={points.map((point, i) => ({ value: String(i), label: "点 " + i + " · " + Number(point.time.toFixed(4)) }))} onChange={value => { setSelected(Number(value)); setError(""); }} /></Field>
    <div className="model-bezier-fields">
      <PointFields key={selected} points={points} index={selected} disabled={busy || endpoint} onChange={next => { setPoints(next); setPreset("custom"); }} onError={setError} />
    </div>
    <div className="model-tools">
      <Button disabled={busy || selected === points.length - 1 || points.length >= 32} onClick={() => { try { setPoints(addTransitionPoint(points, selected)); setSelected(selected + 1); setPreset("custom"); setError(""); } catch (reason) { setError(reason.message); } }}>添加中间点</Button>
      <Button disabled={busy || endpoint} onClick={() => { setPoints(removeTransitionPoint(points, selected)); setSelected(selected - 1); setPreset("custom"); setError(""); }}>删除曲线点</Button>
    </div>
    <p className="model-texture-note">首尾点固定，支持最多 32 个点。选择“线性”并应用可恢复匀速过渡。拖动或方向键调整，Esc/失焦取消本次拖动；应用前不写文件，保存失败可重试。</p>
  </Modal>;
}
