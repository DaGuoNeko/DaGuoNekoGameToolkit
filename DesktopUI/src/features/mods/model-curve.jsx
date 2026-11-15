import React, { useEffect, useMemo, useRef, useState } from "react";
import { curveSamples } from "../skins/npc-clip.cjs";
import { timelineTimeAt } from "../../../shared/model-timeline-view.cjs";

export function Curve({ keys, length, axis, overlay = false, incoming = [], part = "post", width, height, selected = [], onSelect, onChange, onMove, onInsert, onDelete, disabled, revision }) {
  const board = useRef(null), dragging = useRef(null);
  const [live, setLive] = useState(null);
  const shown = useMemo(() => keys.map(key => {
    if (!live || live.from !== key[0]) return key;
    const copy = key.slice(); copy[0] = live.time;
    if (live.part === "pre") { copy[5] = key[5].slice(); copy[5][axis] = live.value; }
    else copy[axis + 1] = live.value;
    return copy;
  }).sort((a, b) => a[0] - b[0]), [keys, live, axis]);
  const curves = useMemo(() => (overlay ? [0, 1, 2].filter(index => index !== axis).concat(axis) : [axis])
    .map(index => ({ axis: index, samples: curveSamples(shown, length, index) })), [shown, length, axis, overlay]);
  let min = 0, max = 0;
  for (const curve of curves) for (const [, value] of curve.samples) { min = Math.min(min, value); max = Math.max(max, value); }
  for (const key of shown) if (incoming.includes(key[0]) || live?.time === key[0]) for (const index of overlay ? [0,1,2] : [axis]) {
    const value = key[5]?.[index];
    if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (max - min < 1) { min -= 1; max += 1; }
  if (dragging.current) ({ min, max } = dragging.current);
  const pad = 10;
  const xOf = time => 6 + time / length * (width - 12);
  const yOf = value => pad + (1 - (value - min) / (max - min)) * (height - pad * 2);
  const cancel = () => {
    const mark = dragging.current; dragging.current = null; setLive(null);
    if (mark?.node.hasPointerCapture(mark.pointer)) mark.node.releasePointerCapture(mark.pointer);
  };
  useEffect(() => {
    const blur = () => cancel(), escape = event => {
      if (event.key === "Escape" && dragging.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener("blur", blur); window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("keydown", escape, true); };
  }, []);
  useEffect(() => { cancel(); }, [keys, axis, overlay, width, height, disabled, revision]);
  const update = event => {
    const mark = dragging.current;
    if (!mark || mark.pointer !== event.pointerId) return null;
    if (mark.revision !== revision || mark.keys !== keys || mark.axis !== axis || mark.overlay !== overlay || disabled) { cancel(); return null; }
    const dx = event.clientX - mark.x, dy = event.clientY - mark.y;
    if (!mark.moved && Math.hypot(dx, dy) < 3) return null;
    mark.moved = true;
    const time = Math.abs(dx) < 3 ? mark.from : Math.max(0, Math.min(Math.floor(length * 20 + 1e-6) / 20, Math.round((mark.from + dx / (mark.rect.width - 12) * length) * 20) / 20));
    const value = Math.abs(dy) < 3 ? mark.value : Math.round((mark.value - dy / mark.rect.height * height / (height - 20) * (mark.max - mark.min)) * 1000) / 1000;
    return { from: mark.from, time, value, part: mark.part };
  };
  const move = event => { const next = update(event); if (next) setLive(next); };
  const finish = event => {
    const mark = dragging.current;
    if (!mark || mark.pointer !== event.pointerId) return;
    if (mark.revision !== revision || mark.keys !== keys || mark.axis !== axis || mark.overlay !== overlay || disabled) { cancel(); return; }
    const next = update(event); cancel();
    if (!next) { onSelect?.(mark.from, mark.part); return; }
    if (next.time !== mark.from) onMove(mark.from, next.time, next.value, mark.part);
    else if (next.value !== mark.value) onChange(mark.from, next.value, mark.part);
  };
  const insert = event => {
    if (disabled || event.target?.closest('[role="slider"]')) return;
    const rect = board.current.getBoundingClientRect();
    const time = timelineTimeAt(event.clientX - rect.left, rect.width, length);
    if (!keys.some(key => Math.abs(key[0] - time) < 0.001)) onInsert(time);
  };
  const conflict = live && keys.some(key => key[0] !== live.from && key[0] === live.time);
  return <svg ref={board} className="model-curve" style={{ width, height, "--curve-color": "var(--curve-" + "xyz"[axis] + ")" }} viewBox={"0 0 " + width + " " + height} preserveAspectRatio="none" role="img" aria-label="曲线" data-min={min} data-max={max} data-edit-axis={"XYZ"[axis]} data-overlay={overlay}
    onDoubleClick={insert} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}>
    {[0, 0.5, 1].map(ratio => <g key={ratio}><line className="model-curve-grid" x1="0" x2={width} y1={pad + ratio * (height - 20)} y2={pad + ratio * (height - 20)} /><text className="model-curve-value" x="12" y={Math.max(10, pad + ratio * (height - 20) - 3)}>{Math.round((max - ratio * (max - min)) * 1000) / 1000}</text></g>)}
    {curves.map(curve => <polyline key={curve.axis} data-curve-axis={"XYZ"[curve.axis]} aria-label={"XYZ"[curve.axis] + " 轴曲线"}
      className={curve.axis === axis ? "active-axis" : "reference-axis"} style={{ "--curve-color": "var(--curve-" + "xyz"[curve.axis] + ")" }}
      points={curve.samples.map(([time, value]) => xOf(time) + "," + yOf(value)).join(" ")} />)}
    {keys.filter(key => key[0] >= 0 && key[0] <= length).map(key => {
      const points = incoming.includes(key[0]) && key[5] ? ["pre", "post"] : ["post"];
      points.sort((a, b) => Number(a === part) - Number(b === part));
      return <g key={key[0]}>
        {points.length === 2 && <line className="model-curve-jump" x1={xOf(live?.from === key[0] ? live.time : key[0])} x2={xOf(live?.from === key[0] ? live.time : key[0])}
          y1={yOf(live?.from === key[0] && live.part === "pre" ? live.value : key[5][axis])} y2={yOf(live?.from === key[0] && live.part === "post" ? live.value : key[axis + 1])} />}
        {points.map(target => {
          const moving = live?.from === key[0], changing = moving && live.part === target;
          const time = moving ? live.time : key[0], baseValue = target === "pre" ? key[5][axis] : key[axis + 1], value = changing ? live.value : baseValue;
          const Shape = target === "pre" ? "rect" : "circle";
          const coordinates = target === "pre" ? { x: xOf(time) - 4, y: yOf(value) - 4, width: 8, height: 8 } : { cx: xOf(time), cy: yOf(value), r: 5 };
          return <Shape key={target} {...coordinates} tabIndex={disabled ? -1 : 0} role="slider" data-part={target}
            aria-label={(target === "pre" ? "曲线入点 " : "曲线点 ") + key[0]} aria-valuenow={value} aria-valuetext={"XYZ"[axis] + " 轴" + (target === "pre" ? "入点" : "出点") + "，" + time.toFixed(2) + " 秒，" + value} aria-disabled={disabled}
            className={(selected.includes(key[0]) && part === target ? "selected " : "") + (changing && conflict ? "conflict" : "")}
            onPointerDown={event => {
              if (disabled || event.button !== 0) return;
              event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = { node: event.currentTarget, pointer: event.pointerId, from: key[0], value: baseValue, part: target, x: event.clientX, y: event.clientY, rect: board.current.getBoundingClientRect(), min, max, revision, keys, axis, overlay, moved: false };
            }}
            onKeyDown={event => {
              if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
              const step = event.shiftKey ? 10 : 1;
              if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onChange(key[0], baseValue + (event.key === "ArrowUp" ? step : -step), target); }
              if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onMove(key[0], Math.round((key[0] + (event.key === "ArrowRight" ? 1 : -1) * step * 0.05) * 20) / 20, baseValue, target); }
              if (["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onDelete(key[0]); }
            }} />;
        })}
      </g>;
    })}
  </svg>;
}
