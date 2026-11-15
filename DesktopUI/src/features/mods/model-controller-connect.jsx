import React, { useEffect, useRef, useState } from "react";
import { scrollControllerViewport } from "./model-controller-scroll.cjs";

export function ModelControllerConnect({ graph, disabled, viewport, onDragging, onConnect }) {
  const board = useRef(null), drag = useRef(null);
  const frame = useRef(0);
  const [line, setLine] = useState(null);
  const canConnect = (from, to) => from !== to && !graph.edges.some(edge => edge.from === from && edge.to === to);
  const targets = from => graph.edges.filter(edge => edge.from === from).length < 8 && graph.nodes.some(node => canConnect(from, node.name));
  const cancel = () => {
    cancelAnimationFrame(frame.current);
    const current = drag.current;
    if (!current) return;
    drag.current = null; setLine(null); onDragging(false);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  };
  const refresh = event => {
    const next = position(event);
    if (next) setLine(previous => previous?.x === next.x && previous?.y === next.y && previous?.target === next.target ? previous : next);
  };
  const scroll = now => {
    const current = drag.current, element = viewport.current;
    if (!current || !element) return;
    const elapsed = Math.max(0, now - current.lastFrame); current.lastFrame = now;
    if (current.moved) {
      scrollControllerViewport(element, { x: current.clientX, y: current.clientY }, elapsed);
      refresh(current);
    }
    frame.current = requestAnimationFrame(scroll);
  };
  const position = event => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return null;
    const rect = board.current.getBoundingClientRect();
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-connect-state]");
    const target = hit && viewport.current.contains(hit) ? hit.dataset.connectState : "";
    return { source: current.source, target: target && canConnect(current.source.name, target) ? target : "",
      x: (event.clientX - rect.left) * graph.width / rect.width, y: (event.clientY - rect.top) * graph.height / rect.height };
  };
  useEffect(() => {
    const key = event => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener("keydown", key, true); window.addEventListener("blur", cancel); window.addEventListener("resize", cancel);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel); cancelAnimationFrame(frame.current); drag.current = null; };
  }, []);
  useEffect(() => { cancel(); }, [graph, disabled]);
  return <>
    <svg ref={board} className="model-controller-connect-preview" width={graph.width} height={graph.height} aria-hidden="true">
      {line && <>
        <path className="model-controller-connect-line" d={`M ${line.source.x + graph.cardWidth} ${line.source.y + graph.cardHeight - 14} L ${line.x} ${line.y}`} />
        {line.target && (() => { const node = graph.nodes.find(item => item.name === line.target); return <rect className="model-controller-connect-target" x={node.x - 4} y={node.y - 4} width={graph.cardWidth + 8} height={graph.cardHeight + 8} rx="10" />; })()}
      </>}
    </svg>
    {graph.nodes.map(node => <button key={node.name} type="button" className="model-controller-connect-port"
      aria-label={"从 " + node.name + " 连接转移"} title="拖到目标状态；Enter 或空格选择目标" disabled={disabled || !targets(node.name)}
      style={{ left: node.x + graph.cardWidth - 10, top: node.y + graph.cardHeight - 24 }}
      onPointerDown={event => {
        if (event.button !== 0 || disabled || drag.current || !targets(node.name)) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { element: event.currentTarget, pointerId: event.pointerId, source: node, clientX: event.clientX, clientY: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, lastFrame: performance.now() };
        setLine(position(event)); onDragging(true);
        frame.current = requestAnimationFrame(scroll);
      }}
      onPointerMove={event => {
        const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
        current.clientX = event.clientX; current.clientY = event.clientY;
        current.moved ||= Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 3;
        refresh(event);
      }}
      onPointerUp={event => {
        const next = position(event); if (!next) return;
        cancel(); if (next.target) onConnect(next.source.name, next.target);
      }} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onClick={event => { if (event.detail === 0 && !drag.current && !disabled) onConnect(node.name, ""); }}>+</button>)}
  </>;
}
