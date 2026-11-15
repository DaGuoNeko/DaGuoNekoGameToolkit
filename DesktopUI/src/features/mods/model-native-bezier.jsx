import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorBox, Field, Modal, Select } from "../../app/ui.jsx";
import { nativeBezierDraft, updateNativeBezier, changeNativeHandle, linkNativeHandles } from "../../../shared/animation-bezier-edit.cjs";
import { bakeNativeFrames } from "../../../shared/animation-bezier-exchange.cjs";

export function NativeBezierEditor({ animation, bone, channel, axis: initialAxis, time, onApply, onClose }) {
  const initial = useMemo(() => {
    try { return { frames: nativeBezierDraft(animation, bone, channel) }; }
    catch (reason) { return { frames: [], error: reason.message }; }
  }, [animation, bone, channel]);
  const [frames, setFrames] = useState(initial.frames), [axis, setAxis] = useState(initialAxis);
  const [index, setIndex] = useState(() => {
    const found = initial.frames.findIndex((frame, i) => initial.frames[i + 1]?.time > time && frame.time <= time);
    return found >= 0 ? found : time >= initial.frames.at(-1)?.time ? Math.max(0, initial.frames.length - 2) : 0;
  });
  const [error, setError] = useState(""), [saveError, setSaveError] = useState(""), [busy, setBusy] = useState(false);
  const board = useRef(null), drag = useRef(null), current = useRef(frames), pending = useRef(false);
  current.current = frames;
  const preview = useMemo(() => {
    try {
      if (initial.error) throw Error(initial.error);
      if (!frames[index + 1]) throw Error("至少需要两个原生端点");
      const next = updateNativeBezier(animation, bone, channel, frames);
      const sampled = bakeNativeFrames(frames).sampled.filter(frame => frame.time >= frames[index].time && frame.time <= frames[index + 1].time);
      return { next, sampled };
    } catch (reason) { return { error: reason.message }; }
  }, [animation, bone, channel, frames, index, initial.error]);
  const a = frames[index], b = frames[index + 1], axisName = "xyz"[axis];
  const from = a?.time || 0, span = b ? b.time - from : 1;
  const ends = [a?.data_points.at(-1)?.[axisName] || 0, b?.data_points[0]?.[axisName] || 0];
  const points = a && b ? [
    [from + Math.max(0, Math.min(span, a.bezier_right_time[axis])), ends[0] + a.bezier_right_value[axis]],
    [b.time + Math.max(-span, Math.min(0, b.bezier_left_time[axis])), ends[1] + b.bezier_left_value[axis]],
  ] : [[0, 0], [1, 0]];
  const values = [...ends, ...points.map(point => point[1]), ...(preview.sampled || []).flatMap(frame => frame.data_points.map(point => point[axisName]))];
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max(1, (high - low) * 0.12);
  const range = drag.current?.range || [low - padding, high + padding];
  const x = at => 26 + (at - from) / span * 368, y = value => 18 + (range[1] - value) / (range[1] - range[0]) * 184;
  const cancel = () => {
    if (!drag.current) return;
    const mark = drag.current; drag.current = null; setFrames(mark.frames); setError("");
  };
  useEffect(() => { window.addEventListener("blur", cancel); return () => window.removeEventListener("blur", cancel); }, []);
  const change = (handle, dt, value) => {
    try { setFrames(changeNativeHandle(current.current, index + handle, handle ? "left" : "right", axis, dt, value)); setError(""); }
    catch (reason) { setError(reason.message); }
  };
  const pointAt = event => {
    const rect = board.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) * 420 / rect.width, py = (event.clientY - rect.top) * 228 / rect.height;
    return [from + Math.max(0, Math.min(1, (px - 26) / 368)) * span, range[1] - (py - 18) / 184 * (range[1] - range[0])];
  };
  const apply = async () => {
    if (preview.error || error || pending.current || drag.current) return;
    pending.current = true; setBusy(true); setSaveError("");
    try { await onApply(frames, from); onClose(); }
    catch (reason) { setSaveError(reason.message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Modal title="原生控制柄" description={bone + " · " + ({ rotation: "旋转", position: "位移", scale: "缩放" }[channel])} busy={busy} onClose={onClose}
    footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button primary disabled={busy || !!preview.error || !!error || preview.next === animation} onClick={apply}>{busy ? "保存中…" : "应用控制柄"}</Button></>}>
    <div className="model-bezier-fields">
      <Field label="原生区间"><Select aria-label="原生区间" disabled={busy} value={String(index)} options={frames.slice(0, -1).map((frame, i) => ({ value: String(i), label: frame.time.toFixed(2) + " → " + frames[i + 1].time.toFixed(2) + " 秒" }))} onChange={value => { setIndex(Number(value)); setError(""); }} /></Field>
      <Field label="控制柄轴"><Select disabled={busy} value={String(axis)} options={["X", "Y", "Z"].map((label, i) => ({ label, value: String(i) }))} onChange={value => { setAxis(Number(value)); setError(""); }} /></Field>
    </div>
    <ErrorBox>{preview.error || error || saveError}</ErrorBox>
    {a && b && <><svg ref={board} className="model-bezier-graph" viewBox="0 0 420 228" preserveAspectRatio="none" role="img" aria-label="原生贝塞尔预览"
      onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      {[0, 0.5, 1].map(at => <line className="grid" key={at} x1={26 + at * 368} y1="18" x2={26 + at * 368} y2="202" />)}
      <line className="handle" x1={x(from)} y1={y(ends[0])} x2={x(points[0][0])} y2={y(points[0][1])} />
      <line className="handle" x1={x(b.time)} y1={y(ends[1])} x2={x(points[1][0])} y2={y(points[1][1])} />
      {!preview.error && <polyline className="sample" points={preview.sampled.flatMap(frame => frame.data_points.map(point => x(frame.time) + "," + y(point[axisName]))).join(" ")} />}
      {[a, b].map((frame, handle) => <circle key={handle} cx={x(points[handle][0])} cy={y(points[handle][1])} r="7" role="slider" tabIndex={busy || frame.interpolation !== "bezier" ? -1 : 0}
        aria-label={handle ? "原生入柄" : "原生出柄"} aria-disabled={busy || frame.interpolation !== "bezier"} aria-valuetext={points[handle].map(value => value.toFixed(3)).join(", ")}
        onPointerDown={event => { if (busy || frame.interpolation !== "bezier" || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { handle, range, frames: current.current }; }}
        onPointerMove={event => { if (drag.current?.handle !== handle) return; const [at, value] = pointAt(event); change(handle, at - frame.time, value - ends[handle]); }}
        onPointerUp={event => { if (drag.current?.handle !== handle) return; drag.current = null; setFrames(current.current.slice()); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => {
          const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
          if (busy || frame.interpolation !== "bezier" || !direction) return;
          event.preventDefault();
          const side = handle ? "left" : "right", step = event.shiftKey ? 0.1 : 0.01;
          const dt = frame["bezier_" + side + "_time"][axis] + direction[0] * step;
          change(handle, handle ? Math.max(-span, Math.min(0, dt)) : Math.max(0, Math.min(span, dt)), frame["bezier_" + side + "_value"][axis] + direction[1] * (event.shiftKey ? 1 : 0.1));
        }} />)}
      <text x="26" y="222">{from.toFixed(2)} 秒 · {ends[0]}</text><text x="394" y="222" textAnchor="end">{b.time.toFixed(2)} 秒 · {ends[1]}</text>
    </svg>
    <div className="model-bezier-fields">{[a, b].map((frame, handle) => {
      const side = handle ? "left" : "right", label = handle ? "入柄" : "出柄";
      return <fieldset key={handle} disabled={busy || frame.interpolation !== "bezier"}><legend>{label} · {"XYZ"[axis]}</legend>
        <label>时间偏移（秒）<input aria-label={label + "时间偏移"} type="number" step="0.01" value={Number(frame["bezier_" + side + "_time"][axis].toFixed(6))} onChange={event => { if (!event.target.value.trim()) { setError("时间偏移不能为空"); return; } change(handle, Number(event.target.value), frame["bezier_" + side + "_value"][axis]); }} /></label>
        <label>数值偏移<input aria-label={label + "数值偏移"} type="number" step="0.1" value={Number(frame["bezier_" + side + "_value"][axis].toFixed(6))} onChange={event => { if (!event.target.value.trim()) { setError("数值偏移不能为空"); return; } change(handle, frame["bezier_" + side + "_time"][axis], Number(event.target.value)); }} /></label>
        <label>左右联动<input className="model-native-link" aria-label={label + "左右联动"} type="checkbox" checked={frame.bezier_linked !== false} onChange={event => { setFrames(linkNativeHandles(frames, index + handle, side, event.target.checked)); setError(""); }} /></label>
      </fieldset>;
    })}</div></>}
    <p className="model-texture-note">偏移相对所选端点，数值使用当前模型坐标。左右联动会同时调整该端点另一侧的柄，可能影响相邻区间。应用后重算播放样本，可一次撤销；取消保留原动画。</p>
  </Modal>;
}
