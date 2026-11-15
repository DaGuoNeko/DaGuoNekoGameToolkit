import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitLayout } from "../../../shared/model-layout.cjs";

function Splitter({ name, axis, value, min, max, style, onChange, onCommit, onCancel, disabled }) {
  const drag = useRef(null);
  const latest = useRef(value); latest.current = value;
  const vertical = axis !== "top";
  const bound = next => Math.min(max, Math.max(min, next));
  const cancel = event => {
    const mark = drag.current;
    if (!mark) return;
    drag.current = null;
    onCancel();
    if (event?.currentTarget?.hasPointerCapture?.(mark.pointer)) event.currentTarget.releasePointerCapture(mark.pointer);
  };
  useEffect(() => {
    const blur = () => { if (drag.current) { drag.current = null; onCancel(); } };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  }, [onCancel]);
  return <div className={"model-splitter " + (vertical ? "vertical" : "horizontal")} style={style} role="separator" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
    aria-label={name} aria-orientation={vertical ? "vertical" : "horizontal"} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={Math.round(value) + " 像素"}
    title="拖动调整；方向键微调，Shift 加速，Esc 取消"
    onPointerDown={event => {
      if (disabled || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, start: vertical ? event.clientX : event.clientY, value };
    }}
    onPointerMove={event => {
      const mark = drag.current;
      if (!mark || mark.pointer !== event.pointerId) return;
      const delta = ((vertical ? event.clientX : event.clientY) - mark.start) * (axis === "right" ? -1 : 1);
      const next = bound(mark.value + delta);
      latest.current = next; onChange(next);
    }}
    onPointerUp={event => {
      if (!drag.current || drag.current.pointer !== event.pointerId) return;
      drag.current = null;
      onCommit(latest.current);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => {
      if (disabled) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(event); return; }
      const down = vertical ? "ArrowLeft" : "ArrowUp", up = vertical ? "ArrowRight" : "ArrowDown";
      if (![down, up, "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      let next = event.key === "Home" ? min : event.key === "End" ? max : value + (event.key === down ? -1 : 1) * (axis === "right" ? -1 : 1) * (event.shiftKey ? 40 : 10);
      next = bound(next); onChange(next); onCommit(next);
    }} />;
}

export function ModelBench({ mode, layout, onLayout, reset, disabled, children }) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState(null);
  const source = draft?.mode === mode ? draft.value : layout;
  const fitted = fitLayout(source, size.width, size.height, mode);
  const split = mode !== "paint" && mode !== "display";
  useLayoutEffect(() => { setDraft(null); }, [mode, reset]);
  useLayoutEffect(() => {
    const node = host.current;
    const resize = () => setSize(previous => {
      const width = node.clientWidth, height = node.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    resize();
    const observer = new ResizeObserver(resize); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const changed = (axis, value) => ({ ...layout, left: fitted.left, right: fitted.right, [axis === "top" ? "split" : axis]: axis === "top" ? value / Math.max(1, size.height - 8) : value });
  const handle = (axis, name, style) => <Splitter key={mode + name + reset} disabled={disabled} name={name} axis={axis} value={axis === "top" ? fitted.top : fitted[axis]} min={fitted[axis + "Min"]} max={fitted[axis + "Max"]} style={style}
    onChange={value => setDraft({ mode, value: changed(axis, value) })}
    onCommit={value => { onLayout(changed(axis, value)); setDraft(null); }} onCancel={() => setDraft(null)} />;
  const upperHeight = mode === "animate" ? fitted.top : size.height;
  return <div ref={host} className={"model-bench" + (mode === "animate" ? " animate" : mode === "display" ? " display" : mode === "solid" ? " paint solid" : mode === "paint" ? " paint" : "")}
    style={size.width ? { gridTemplateColumns: fitted.left + "px minmax(0, 1fr) " + fitted.right + "px", gridTemplateRows: split ? fitted.top + "px " + fitted.bottom + "px" : "minmax(0, 1fr)" } : undefined}>
    {children}
    {size.width > 0 && <>
      {handle("left", "调整左侧面板宽度", { left: fitted.left, top: 0, height: upperHeight })}
      {handle("right", "调整右侧面板宽度", { right: fitted.right, top: 0, height: upperHeight })}
      {mode === "edit" && handle("top", "调整大纲与 UV 高度", { top: fitted.top, left: 0, width: fitted.left })}
      {mode === "edit" && handle("top", "调整贴图与元素高度", { top: fitted.top, right: 0, width: fitted.right })}
      {(mode === "animate" || mode === "solid") && handle("top", mode === "animate" ? "调整时间轴高度" : "调整预览与画板高度", { top: fitted.top, left: mode === "solid" ? fitted.left + 8 : 0, right: mode === "solid" ? fitted.right + 8 : 0 })}
    </>}
  </div>;
}
