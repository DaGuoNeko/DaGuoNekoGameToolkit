import { useEffect, useRef, useState } from "react";
import { scrollControllerViewport } from "./model-controller-scroll.cjs";

export function useControllerArrange({ graph, disabled, viewport, onMoving, onSwap }) {
  const drag = useRef(null), frame = useRef(0), suppressClick = useRef(false);
  const [preview, setPreview] = useState(null);
  const finish = () => {
    cancelAnimationFrame(frame.current);
    const current = drag.current;
    drag.current = null; setPreview(null); onMoving(false);
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  };
  const position = current => {
    const rect = viewport.current.querySelector(".model-controller-graph-board").getBoundingClientRect();
    const hit = document.elementFromPoint(current.clientX, current.clientY)?.closest("[data-connect-state]");
    const target = hit && viewport.current.contains(hit) ? hit.dataset.connectState : "";
    return { name: current.node.name, x: (current.clientX - rect.left) * graph.width / rect.width - current.offsetX,
      y: (current.clientY - rect.top) * graph.height / rect.height - current.offsetY, target: target !== current.node.name ? target : "" };
  };
  const refresh = current => {
    const next = position(current);
    setPreview(previous => previous?.name === next.name && previous?.x === next.x && previous?.y === next.y && previous?.target === next.target ? previous : next);
  };
  const tick = now => {
    const current = drag.current;
    if (!current || !viewport.current) return;
    const elapsed = now - current.lastFrame; current.lastFrame = now;
    if (current.moved) {
      scrollControllerViewport(viewport.current, { x: current.clientX, y: current.clientY }, elapsed);
      refresh(current);
    }
    frame.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const key = event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); finish(); } };
    window.addEventListener("keydown", key, true); window.addEventListener("blur", finish); window.addEventListener("resize", finish);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("blur", finish); window.removeEventListener("resize", finish); cancelAnimationFrame(frame.current); drag.current = null; };
  }, []);
  useEffect(() => { if (drag.current) finish(); }, [graph, disabled]);
  const preparePointer = () => { if (!drag.current) suppressClick.current = false; };
  const consumeClick = event => { if (event.detail === 0) suppressClick.current = false; return suppressClick.current; };
  const handlers = node => ({
    onPointerDown: event => {
      if (disabled || event.button !== 0 || drag.current) return;
      suppressClick.current = false;
      event.preventDefault(); event.currentTarget.closest("button").focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = viewport.current.querySelector(".model-controller-graph-board").getBoundingClientRect();
      drag.current = { node, element: event.currentTarget, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        clientX: event.clientX, clientY: event.clientY, offsetX: (event.clientX - rect.left) * graph.width / rect.width - node.x,
        offsetY: (event.clientY - rect.top) * graph.height / rect.height - node.y, lastFrame: performance.now(), moved: false };
      frame.current = requestAnimationFrame(tick);
    },
    onPointerMove: event => {
      const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
      current.clientX = event.clientX; current.clientY = event.clientY;
      if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 3) {
        current.moved = true; suppressClick.current = true; onMoving(true);
      }
      if (current.moved) refresh(current);
    },
    onPointerUp: event => {
      const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
      current.clientX = event.clientX; current.clientY = event.clientY;
      const result = current.moved ? position(current) : null;
      finish(); if (result?.target) onSwap(current.node.name, result.target);
    },
    onPointerCancel: finish, onLostPointerCapture: () => { if (drag.current) finish(); },
  });
  return { preview, handlers, preparePointer, consumeClick };
}
