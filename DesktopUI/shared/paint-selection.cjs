function containsPixel(selection, x, y) {
  if (!selection) return true;
  if (x < selection.x || y < selection.y || x >= selection.x + selection.w || y >= selection.y + selection.h) return false;
  if (!selection.mask) return true;
  return selection.mask[(y - selection.y) * selection.w + (x - selection.x)] === 1;
}

function connectedPixels(image, x, y, limit) {
  const { width, height, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || !data || data.length !== width * height * 4) throw Error("贴图数据无效");
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw Error("魔棒位置超出贴图");
  if (limit && !containsPixel(limit, x, y)) throw Error("魔棒位置不在选区内");
  const origin = (y * width + x) * 4;
  const source = [data[origin], data[origin + 1], data[origin + 2], data[origin + 3]];
  const seen = new Uint8Array(width * height);
  const stack = [[x, y]];
  let minX = x, minY = y, maxX = x, maxY = y, count = 0;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= width || cy >= height || (limit && !containsPixel(limit, cx, cy))) continue;
    const index = cy * width + cx;
    if (seen[index]) continue;
    const pixel = index * 4;
    if (source.some((value, channel) => data[pixel + channel] !== value)) continue;
    seen[index] = 1;
    count += 1;
    minX = Math.min(minX, cx); minY = Math.min(minY, cy); maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  if (count === w * h) return { x: minX, y: minY, w, h, count };
  const mask = new Uint8Array(w * h);
  for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) if (seen[py * width + px]) mask[(py - minY) * w + (px - minX)] = 1;
  return { x: minX, y: minY, w, h, mask, count };
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const [x1, y1] = points[current], [x0, y0] = points[previous];
    if (((y1 > y) !== (y0 > y)) && x < (x0 - x1) * (y - y1) / (y0 - y1) + x1) inside = !inside;
  }
  return inside;
}

function lassoSelection(points, width, height, limit) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) throw Error("贴图数据无效");
  if (!Array.isArray(points) || points.length < 3 || points.length > 8192) throw Error("套索至少需要 3 个点");
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isInteger(point[0]) || !Number.isInteger(point[1]) || point[0] < 0 || point[1] < 0 || point[0] >= width || point[1] >= height) throw Error("套索超出贴图");
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]); maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  const w = maxX - minX + 1, h = maxY - minY + 1, mask = new Uint8Array(w * h);
  let count = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if (limit && !containsPixel(limit, x, y)) continue;
    if (!pointInPolygon(x + 0.5, y + 0.5, points)) continue;
    mask[(y - minY) * w + (x - minX)] = 1;
    count += 1;
  }
  if (!count) throw Error("套索内没有像素");
  if (count === w * h) return { x: minX, y: minY, w, h, count };
  return { x: minX, y: minY, w, h, mask, count };
}

function paintMasked(image, selection, mode) {
  const rect = selectionBounds(selection, image.width, image.height);
  if (!image.data || image.data.length !== image.width * image.height * 4) throw Error("贴图数据无效");
  const output = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const selected = !selection.mask || selection.mask[y * rect.w + x] === 1;
    const source = ((rect.y + y) * image.width + rect.x + x) * 4;
    const target = (y * rect.w + x) * 4;
    if (mode === "keep" ? selected : !selected) output.set(image.data.subarray(source, source + 4), target);
  }
  return { width: rect.w, height: rect.h, data: output };
}

function compositeSelected(destination, source, mask) {
  if (destination.length !== source.length || (mask && mask.length * 4 !== source.length)) throw Error("选区贴图尺寸不一致");
  const output = new Uint8ClampedArray(destination);
  for (let i = 0; i < source.length; i += 4) if (!mask || mask[i / 4] === 1) output.set(source.subarray(i, i + 4), i);
  return output;
}

function selectionBounds(selection, width, height) {
  if (!selection || ![selection.x, selection.y, selection.w, selection.h, width, height].every(Number.isInteger)
    || width < 1 || height < 1 || width > 2048 || height > 2048 || selection.w < 1 || selection.h < 1
    || selection.x < 0 || selection.y < 0 || selection.x + selection.w > width || selection.y + selection.h > height) throw Error("选区超出贴图范围");
  return { x: selection.x, y: selection.y, w: selection.w, h: selection.h };
}

function moveSelection(selection, dx, dy, width, height) {
  const rect = selectionBounds(selection, width, height);
  if (![dx, dy].every(Number.isInteger)) throw Error("选区移动应为整数像素");
  return { ...rect, x: Math.max(0, Math.min(width - rect.w, rect.x + dx)), y: Math.max(0, Math.min(height - rect.h, rect.y + dy)) };
}

function transformPixels(image, operation) {
  const { width, height, data, mask } = image;
  selectionBounds({ x: 0, y: 0, w: width, h: height }, width, height);
  const angle = operation?.type === "rotateAngle" ? operation.angle : undefined;
  const kind = typeof operation === "object" ? operation?.type : operation;
  if (!data || data.length !== width * height * 4 || !["flipX", "flipY", "rotate", "scale2", "scaleHalf", "rotateAngle", "resize"].includes(kind)) throw Error("选区变换数据无效");
  if (mask != null && (!(mask instanceof Uint8Array || Array.isArray(mask)) || mask.length !== width * height || mask.some(value => value !== 0 && value !== 1) || !mask.some(value => value === 1))) throw Error("选区遮罩无效");
  if (kind === "rotateAngle") {
    if (typeof angle !== "number" || !Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) throw Error("旋转角度应为 -360–360 的非零数字");
    const radians = (angle % 360) * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const w = Math.ceil(Math.abs(width * cos) + Math.abs(height * sin) - 1e-10);
    const h = Math.ceil(Math.abs(width * sin) + Math.abs(height * cos) - 1e-10);
    if (w > 2048 || h > 2048) throw Error("选区超出贴图范围");
    const output = new Uint8ClampedArray(w * h * 4), outputMask = new Uint8Array(w * h);
    let count = 0;
    // 从目标像素中心反查源像素，避免正向投影的碰撞和漏点；边角始终用遮罩留空。
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2, dy = y + 0.5 - h / 2;
      const sx = Math.floor(dx * cos + dy * sin + width / 2 + 1e-10);
      const sy = Math.floor(-dx * sin + dy * cos + height / 2 + 1e-10);
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const from = sy * width + sx, to = y * w + x;
      output.set(data.subarray(from * 4, from * 4 + 4), to * 4);
      if (!mask || mask[from] === 1) { outputMask[to] = 1; count++; }
    }
    if (!count) throw Error("旋转后选区没有像素，未修改贴图");
    return { width: w, height: h, data: output, ...(mask || count !== w * h ? { mask: outputMask } : {}) };
  }
  if (kind === "scaleHalf" && (width % 2 || height % 2)) throw Error("缩小需要偶数宽高");
  const factor = kind === "scale2" ? 2 : kind === "scaleHalf" ? 0.5 : 1;
  const w = kind === "resize" ? operation.width : kind === "rotate" ? height : width * factor;
  const h = kind === "resize" ? operation.height : kind === "rotate" ? width : height * factor;
  if (kind === "resize" && (![w, h].every(Number.isInteger) || w < 1 || h < 1 || w > 2048 || h > 2048)) throw Error("缩放宽高须为 1–2048 的整数像素");
  if (w > 2048 || h > 2048) throw Error("选区超出贴图范围");
  const output = new Uint8ClampedArray(w * h * 4), outputMask = mask ? new Uint8Array(w * h) : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = kind === "rotate" ? y : kind === "flipX" ? width - 1 - x : Math.floor(x * width / w);
    const sy = kind === "rotate" ? height - 1 - x : kind === "flipY" ? height - 1 - y : Math.floor(y * height / h);
    const from = sy * width + sx, to = y * w + x;
    output.set(data.subarray(from * 4, from * 4 + 4), to * 4);
    if (outputMask) outputMask[to] = mask[from];
  }
  if (outputMask && !outputMask.some(value => value === 1)) throw Error("缩小后选区没有像素，未修改贴图");
  return { width: w, height: h, data: output, ...(outputMask ? { mask: outputMask } : {}) };
}

function transformSelectedPixels(image, selection, operation) {
  const rect = selectionBounds(selection, image.width, image.height);
  const patch = paintMasked(image, selection, "keep");
  const changed = transformPixels({ ...patch, mask: selection.mask }, operation);
  const target = selectionBounds({ ...rect, w: changed.width, h: changed.height }, image.width, image.height);
  const output = new Uint8ClampedArray(image.data);
  // 先清除源选区，再写入目标选区；孔洞和透明的已选像素分别处理。
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    if (selection.mask && selection.mask[y * rect.w + x] !== 1) continue;
    const at = ((rect.y + y) * image.width + rect.x + x) * 4;
    output.fill(0, at, at + 4);
  }
  for (let y = 0; y < target.h; y++) for (let x = 0; x < target.w; x++) {
    const from = y * target.w + x;
    if (changed.mask && changed.mask[from] !== 1) continue;
    output.set(changed.data.subarray(from * 4, from * 4 + 4), ((target.y + y) * image.width + target.x + x) * 4);
  }
  return { width: image.width, height: image.height, data: output, selection: { ...target, ...(changed.mask ? { mask: changed.mask } : {}) } };
}

module.exports = { containsPixel, selectionBounds, moveSelection, transformPixels, transformSelectedPixels, connectedPixels, paintMasked, compositeSelected, lassoSelection };
