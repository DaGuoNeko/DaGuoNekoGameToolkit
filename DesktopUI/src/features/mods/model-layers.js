import { validateLayers, layerBlendMode, maskCoverage } from "../../../shared/texture-layers.cjs";

export function layerCanvas(width, height) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}

export function maskedLayerCanvas(layer) {
  if (!layer.mask?.enabled) return layer.canvas;
  const canvas = layerCanvas(layer.canvas.width, layer.canvas.height), context = canvas.getContext("2d");
  context.drawImage(layer.canvas, 0, 0);
  const mask = layer.mask.canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < mask.data.length; i += 4) { const alpha = maskCoverage(mask.data, i); mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = 255; mask.data[i + 3] = alpha; }
  const stencil = layerCanvas(canvas.width, canvas.height); stencil.getContext("2d").putImageData(mask, 0, 0);
  context.globalCompositeOperation = "destination-in"; context.drawImage(stencil, 0, 0);
  return canvas;
}

export function invertLayerMask(canvas) {
  const inverted = layerCanvas(canvas.width, canvas.height), image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) { const value = 255 - maskCoverage(image.data, i); image.data[i] = image.data[i + 1] = image.data[i + 2] = value; image.data[i + 3] = 255; }
  inverted.getContext("2d").putImageData(image, 0, 0); return inverted;
}

export function flattenLayers(layers) {
  if (!layers.length) return null;
  const canvas = layerCanvas(layers[0].canvas.width, layers[0].canvas.height), context = canvas.getContext("2d");
  for (const layer of layers) if (layer.visible) {
    const mode = layerBlendMode(layer);
    context.globalCompositeOperation = mode === "normal" ? "source-over" : mode;
    context.globalAlpha = layer.opacity / 100; context.drawImage(maskedLayerCanvas(layer), 0, 0);
  }
  return canvas;
}

export function serializeLayers(layers, active, editTarget = "image") {
  return { version: layers.some(layer => layer.mask) ? 3 : layers.some(layer => layerBlendMode(layer) !== "normal") ? 2 : 1, active, ...(editTarget === "mask" ? { editTarget } : {}), layers: layers.map(({ canvas, mask, ...layer }) => ({ ...layer, ...(mask ? { mask: { enabled: mask.enabled, source: mask.canvas.toDataURL("image/png") } } : {}), source: canvas.toDataURL("image/png") })) };
}

export function mergeLayerDown(layers, index) {
  const upper = layers[index], lower = layers[index - 1];
  if (!lower || !upper || lower.locked || upper.locked || !lower.visible || !upper.visible) throw Error("只能合并相邻、可见且未锁定的图层");
  const canvas = flattenLayers([lower, upper]), merged = { ...lower, canvas, opacity: 100, blendMode: "normal" };
  delete merged.mask;
  if (index > 1 && (layerBlendMode(lower) !== "normal" || layerBlendMode(upper) !== "normal")) {
    // 混合依赖下方颜色时，两层独立合成未必等价，先核对整个下层前缀。
    const prefix = layers.slice(0, index - 1), before = flattenLayers(layers.slice(0, index + 1)), after = flattenLayers([...prefix, merged]);
    const a = before.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const b = after.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    if (a.some((value, i) => value !== b[i])) throw Error("这两层的混合依赖更下方图层，直接合并会改变画面；请从底部逐层合并，或改为正常模式");
  }
  return merged;
}

export async function restoreLayers(document, fallback) {
  const source = document || { version: 1, active: 0, layers: [{ name: "背景", visible: true, locked: false, opacity: 100, source: fallback }] };
  const decode = async src => { const image = new Image(); image.src = src; await image.decode(); return image; };
  const images = await Promise.all(source.layers.map(layer => decode(layer.source)));
  const width = images[0].width, height = images[0].height;
  const checked = validateLayers(source, width, height);
  const masks = await Promise.all(checked.layers.map(layer => layer.mask ? decode(layer.mask.source) : null));
  return { active: checked.active, editTarget: checked.editTarget || "image", layers: checked.layers.map(({ source, mask, ...layer }, i) => {
    if (images[i].width !== width || images[i].height !== height) throw Error("图层尺寸不一致");
    const canvas = layerCanvas(width, height); canvas.getContext("2d").drawImage(images[i], 0, 0);
    let restoredMask;
    if (mask) {
      if (masks[i].width !== width || masks[i].height !== height) throw Error("蒙版尺寸不一致");
      const maskCanvas = layerCanvas(width, height); maskCanvas.getContext("2d").drawImage(masks[i], 0, 0); restoredMask = { enabled: mask.enabled, canvas: maskCanvas };
    }
    return { ...layer, canvas, ...(restoredMask ? { mask: restoredMask } : {}) };
  }) };
}
