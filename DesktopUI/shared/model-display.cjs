const displaySlots = [
  ["thirdperson_righthand", "第三人称右手"],
  ["thirdperson_lefthand", "第三人称左手"],
  ["firstperson_righthand", "第一人称右手"],
  ["firstperson_lefthand", "第一人称左手"],
  ["ground", "地面"],
  ["gui", "物品栏"],
  ["head", "头部"],
  ["fixed", "固定"],
];
const displayPresets = {
  thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
  thirdperson_lefthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
  firstperson_righthand: { rotation: [0, 45, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
  firstperson_lefthand: { rotation: [0, 225, 0], translation: [0, 0, 0], scale: [0.4, 0.4, 0.4] },
  ground: { rotation: [0, 0, 0], translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] },
  gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  head: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] },
  fixed: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
};

function round3(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => !Number.isFinite(Number(item)) || Math.abs(Number(item)) > 4096)) throw Error(label + "无效");
  return [0, 1, 2].map(index => Math.round(Number(value[index]) * 1000) / 1000);
}

function slotRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("显示设置无效");
  const scale = round3(value.scale, "显示缩放");
  if (scale.some(item => item === 0)) throw Error("显示缩放不能为 0");
  return { rotation: round3(value.rotation, "显示旋转"), translation: round3(value.translation, "显示位移"), scale };
}

function normalizeDisplay(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("显示设置无效");
  const next = {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(displayPresets, key)) throw Error("显示槽位无效");
    next[key] = slotRecord(value[key]);
  }
  return next;
}

function displayPose(display, slot) {
  if (!Object.hasOwn(displayPresets, slot)) throw Error("显示槽位无效");
  return (display && display[slot]) || displayPresets[slot];
}

function assignDisplay(display, slot, patch) {
  const current = normalizeDisplay(display);
  const next = slotRecord({ ...displayPose(current, slot), ...patch });
  return { ...current, [slot]: next };
}

function clearDisplay(display, slot) {
  const current = normalizeDisplay(display);
  if (!Object.hasOwn(displayPresets, slot)) throw Error("显示槽位无效");
  const next = { ...current };
  delete next[slot];
  return next;
}

module.exports = { displaySlots, displayPresets, normalizeDisplay, displayPose, assignDisplay, clearDisplay };
