import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useControllerZoom({ viewport, graph, disabled }) {
  const [zoom, setZoom] = useState(1);
  const current = useRef(1), pending = useRef(null), latest = useRef({ graph, disabled });
  latest.current = { graph, disabled };
  const apply = (next, point, reset = false) => {
    const element = viewport.current;
    if (!element || latest.current.disabled) return;
    next = Math.max(0.05, Math.min(1.5, next));
    if (next === current.current && !pending.current) {
      if (reset) { element.scrollLeft = 0; element.scrollTop = 0; }
      return;
    }
    const rect = element.getBoundingClientRect(), board = element.querySelector(".model-controller-graph-board").getBoundingClientRect();
    const x = point?.x ?? rect.left + element.clientLeft + element.clientWidth / 2;
    const y = point?.y ?? rect.top + element.clientTop + element.clientHeight / 2;
    pending.current = { zoom: next, reset, worldX: (x - board.left) / current.current, worldY: (y - board.top) / current.current,
      x: x - rect.left - element.clientLeft, y: y - rect.top - element.clientTop };
    setZoom(next);
  };
  const change = (delta, point) => apply((pending.current?.zoom ?? current.current) + delta, point);
  const fit = all => {
    const element = viewport.current, value = latest.current.graph;
    if (!element || latest.current.disabled) return;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    apply(Math.min(1, (element.clientWidth - 16) / value.width, all ? (element.clientHeight - 16) / value.height : Infinity), undefined, all);
  };
  useLayoutEffect(() => {
    const element = viewport.current, anchor = pending.current;
    current.current = zoom;
    if (!element || !anchor) return;
    const rect = element.getBoundingClientRect(), board = element.querySelector(".model-controller-graph-board").getBoundingClientRect();
    element.scrollLeft = anchor.reset ? 0 : element.scrollLeft + board.left + anchor.worldX * zoom - rect.left - element.clientLeft - anchor.x;
    element.scrollTop = anchor.reset ? 0 : element.scrollTop + board.top + anchor.worldY * zoom - rect.top - element.clientTop - anchor.y;
    if (anchor.zoom === zoom) pending.current = null;
  }, [zoom]);
  useEffect(() => {
    const element = viewport.current;
    const wheel = event => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (event.deltaY) change(event.deltaY < 0 ? 0.1 : -0.1, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return { zoom, change, fit };
}
