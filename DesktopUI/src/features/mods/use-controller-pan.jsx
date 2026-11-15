import { useEffect, useRef } from "react";

export function useControllerPan({ viewport, disabled, context, onPanning }) {
  const drag = useRef(null);
  const finish = restore => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (restore) { current.element.scrollLeft = current.left; current.element.scrollTop = current.top; }
    onPanning(false);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  };
  const cancel = () => finish(true);
  useEffect(() => {
    const key = event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener("keydown", key, true); window.addEventListener("blur", cancel); window.addEventListener("resize", cancel);
    return () => {
      window.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel); window.removeEventListener("resize", cancel);
      const current = drag.current; drag.current = null;
      if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    };
  }, []);
  useEffect(() => { cancel(); }, [context, disabled]);
  return {
    onPointerDown: event => {
      if (disabled || drag.current || event.button !== 0 || event.target.closest("button,input,select,textarea,a")) return;
      const element = viewport.current, rect = element.getBoundingClientRect();
      // 原生滚动条保留自己的鼠标行为。
      if (event.clientX < rect.left + element.clientLeft || event.clientX >= rect.left + element.clientLeft + element.clientWidth || event.clientY < rect.top + element.clientTop || event.clientY >= rect.top + element.clientTop + element.clientHeight) return;
      event.preventDefault(); element.focus({ preventScroll: true }); element.setPointerCapture(event.pointerId);
      drag.current = { element, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, remainderX: 0, remainderY: 0 };
      onPanning(true);
    },
    onPointerMove: event => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const element = current.element;
      const left = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + current.x - event.clientX + current.remainderX));
      const top = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + current.y - event.clientY + current.remainderY));
      element.scrollLeft = left; element.scrollTop = top;
      // 保留浏览器滚动取整的小数余量，避免多次 pointermove 累积偏移。
      current.remainderX = left - element.scrollLeft; current.remainderY = top - element.scrollTop;
      current.x = event.clientX; current.y = event.clientY;
    },
    onPointerUp: event => { if (drag.current?.pointerId === event.pointerId) finish(false); },
    onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId) cancel(); },
    onLostPointerCapture: event => {
      const current = drag.current;
      if (current && event.target === current.element && current.pointerId === event.pointerId && !current.element.hasPointerCapture(current.pointerId)) cancel();
    },
  };
}
