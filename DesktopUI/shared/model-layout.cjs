const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const layoutModes = ["edit", "paint", "solid", "animate", "display"];

function validateLayout(mode, value) {
  if (!layoutModes.includes(mode)) throw Error("模型布局模式无效");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["left", "right", "split"].includes(key))) throw Error("模型布局数据无效");
  for (const key of ["left", "right", "split"]) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > (key === "split" ? 1 : 480)) throw Error("模型布局尺寸无效");
  }
  return { left: value.left, right: value.right, split: value.split };
}

function normalizeLayouts(value) {
  const layouts = {};
  for (const mode of layoutModes) {
    if (!value || !Object.hasOwn(value, mode)) continue;
    try { layouts[mode] = validateLayout(mode, value[mode]); } catch { /* 损坏模式回退默认，其他模式保留。 */ }
  }
  return layouts;
}

function validateLayouts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("模型布局数据无效");
  return Object.fromEntries(Object.entries(value).map(([mode, layout]) => [mode, validateLayout(mode, layout)]));
}

function defaultLayout(mode) {
  return { left: 280, right: 280, split: mode === "animate" ? 0.62 : 4 / 7 };
}

function fitLayout(value, width, height, mode) {
  const defaults = defaultLayout(mode);
  const w = Math.max(0, finite(width, 0) - 16), h = Math.max(0, finite(height, 0) - 8);
  const minSide = Math.min(180, w / 4), center = Math.min(240, w / 2);
  const maxSides = w - center;
  let left = clamp(finite(value?.left, defaults.left), minSide, 480);
  let right = clamp(finite(value?.right, defaults.right), minSide, 480);
  if (left + right > maxSides) {
    const excess = left + right - 2 * minSide;
    const ratio = excess > 0 ? (maxSides - 2 * minSide) / excess : 0;
    left = minSide + (left - minSide) * ratio;
    right = minSide + (right - minSide) * ratio;
  }
  const minTop = Math.min(160, h * 0.4), minBottom = Math.min(mode === "animate" ? 200 : 160, h * 0.4);
  const top = clamp(finite(value?.split, defaults.split) * h, minTop, h - minBottom);
  return {
    left, right, top, bottom: h - top,
    leftMin: minSide, leftMax: Math.min(480, maxSides - right),
    rightMin: minSide, rightMax: Math.min(480, maxSides - left),
    topMin: minTop, topMax: h - minBottom,
  };
}

module.exports = { defaultLayout, fitLayout, validateLayout, validateLayouts, normalizeLayouts };
