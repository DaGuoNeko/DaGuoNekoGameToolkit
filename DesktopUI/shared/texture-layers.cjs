const MAX_LAYERS = 16, MAX_PIXELS = 16 * 1024 * 1024, MAX_DOCUMENT = 8 * 1024 * 1024;
const blendModes = [
  { value: "normal", label: "正常" }, { value: "multiply", label: "正片叠底" }, { value: "screen", label: "滤色" }, { value: "overlay", label: "叠加" },
  { value: "darken", label: "变暗" }, { value: "lighten", label: "变亮" }, { value: "difference", label: "差值" }, { value: "exclusion", label: "排除" },
];

function layerBlendMode(layer) {
  const mode = layer.blendMode === undefined ? "normal" : layer.blendMode;
  if (!blendModes.some(item => item.value === mode)) throw Error("不支持的图层混合模式");
  return mode;
}

function validateLayers(value, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) throw Error("图层尺寸应为 1–2048 像素");
  if (!value || ![1, 2, 3].includes(value.version) || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > MAX_LAYERS) throw Error("图层数据无效，最多 16 层");
  if (width * height * value.layers.length > MAX_PIXELS) throw Error("图层总像素超过 1600 万限制");
  if (!Number.isInteger(value.active) || value.active < 0 || value.active >= value.layers.length) throw Error("当前图层无效");
  if (value.editTarget !== undefined && !["image", "mask"].includes(value.editTarget)) throw Error("图层编辑目标无效");
  if (value.editTarget === "mask" && !value.layers[value.active]?.mask) throw Error("当前图层没有蒙版");
  let size = 0, images = value.layers.length;
  const checkSource = source => {
    if (typeof source !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) throw Error("图层和蒙版必须是内嵌 PNG");
    size += source.length;
    if (size > MAX_DOCUMENT) throw Error("图层数据超过 8MB");
  };
  const layers = value.layers.map(layer => {
    if (!layer || typeof layer.name !== "string" || !layer.name.trim() || layer.name.length > 64 || /[\0-\x1f]/.test(layer.name)
      || typeof layer.visible !== "boolean" || typeof layer.locked !== "boolean" || !Number.isInteger(layer.opacity) || layer.opacity < 0 || layer.opacity > 100) throw Error("图层属性无效");
    checkSource(layer.source);
    const blendMode = layerBlendMode(layer);
    if (blendMode !== "normal" && value.version < 2) throw Error("混合图层需要新版图层格式");
    let mask;
    if (layer.mask !== undefined) {
      if (value.version < 3) throw Error("蒙版需要新版图层格式");
      if (!layer.mask || typeof layer.mask.enabled !== "boolean") throw Error("蒙版属性无效");
      checkSource(layer.mask.source);
      if (++images * width * height > MAX_PIXELS) throw Error("图层和蒙版总像素超过 1600 万限制");
      mask = { enabled: layer.mask.enabled, source: layer.mask.source };
    }
    return { name: layer.name, visible: layer.visible, locked: layer.locked, opacity: layer.opacity, ...(layer.blendMode === undefined ? {} : { blendMode }), ...(mask ? { mask } : {}), source: layer.source };
  });
  return { version: value.version, active: value.active, ...(value.editTarget === undefined ? {} : { editTarget: value.editTarget }), layers };
}

function maskCoverage(data, index) {
  return Math.round((data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) * data[index + 3] / 255);
}

module.exports = { validateLayers, layerBlendMode, blendModes, maskCoverage, MAX_LAYERS, MAX_PIXELS, MAX_DOCUMENT };
