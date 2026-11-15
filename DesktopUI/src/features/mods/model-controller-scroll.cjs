function connectionScroll(pointer, bounds, elapsed) {
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top || pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom) return { x: 0, y: 0 };
  const distance = 480 * Math.min(50, Math.max(0, elapsed)) / 1000;
  const axis = (at, min, max) => {
    const edge = Math.min(32, (max - min) / 4);
    if (at < min + edge) return -distance * (min + edge - at) / edge;
    if (at > max - edge) return distance * (at - max + edge) / edge;
    return 0;
  };
  return { x: axis(pointer.x, bounds.left, bounds.right), y: axis(pointer.y, bounds.top, bounds.bottom) };
}

function scrollControllerViewport(element, pointer, elapsed) {
  const rect = element.getBoundingClientRect(), clip = element.closest(".modal-body").getBoundingClientRect();
  // 只使用弹窗内可见的画布边缘，避免指针在表单或滚动条上时继续滚动。
  const bounds = { left: Math.max(rect.left + element.clientLeft, clip.left, 0), top: Math.max(rect.top + element.clientTop, clip.top, 0),
    right: Math.min(rect.left + element.clientLeft + element.clientWidth, clip.right, innerWidth), bottom: Math.min(rect.top + element.clientTop + element.clientHeight, clip.bottom, innerHeight) };
  const delta = connectionScroll(pointer, bounds, elapsed);
  element.scrollLeft += delta.x; element.scrollTop += delta.y;
}

module.exports = { connectionScroll, scrollControllerViewport };
