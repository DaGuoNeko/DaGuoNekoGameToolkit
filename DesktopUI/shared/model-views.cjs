const names = ["perspective", "top", "bottom", "south", "north", "east", "west"];
const round = value => Math.round(value * 1000) / 1000;

function vector(value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== "number" || !Number.isFinite(item) || Math.abs(item) > 10000)) return null;
  return value.map(round);
}

function range(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? round(value) : null;
}

function validateSlot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("模型视角数据无效");
  const position = vector(value.position), target = vector(value.target);
  const span = range(value.span, 0.05, 10000), zoom = range(value.zoom, 0.01, 100);
  if (!names.includes(value.view) || typeof value.custom !== "boolean" || !position || !target || span == null || zoom == null) throw Error("模型视角数据无效");
  if (Object.keys(value).some(key => !["view", "custom", "position", "target", "span", "zoom"].includes(key))) throw Error("模型视角数据无效");
  return { view: value.view, custom: value.custom, position, target, span, zoom };
}

function defaultViews() {
  const slot = (view, position) => ({ view, custom: false, position, target: [0, 0, 0], span: 2, zoom: 1 });
  return {
    quad: false,
    active: 0,
    slots: [slot("perspective", [0.55, 0.35, 1]), slot("top", [0, 1, 0]), slot("south", [0, 0, 1]), slot("east", [1, 0, 0])],
  };
}

function validateViews(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("模型视角数据无效");
  if (typeof value.quad !== "boolean" || !Number.isInteger(value.active) || value.active < 0 || value.active > 3 || !Array.isArray(value.slots) || value.slots.length !== 4) throw Error("模型视角数据无效");
  if (Object.keys(value).some(key => !["quad", "active", "slots"].includes(key))) throw Error("模型视角数据无效");
  return { quad: value.quad, active: value.active, slots: value.slots.map(validateSlot) };
}

function normalizeViews(value) {
  if (value == null) return defaultViews();
  try { return validateViews(value); } catch { return defaultViews(); }
}

module.exports = { defaultViews, validateViews, normalizeViews };
