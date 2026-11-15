const { bakeNativeFrames, restoreNativeFrames } = require("./animation-bezier-exchange.cjs");
const axes = ["x", "y", "z"];
const valueKeys = ["bezier_left_value", "bezier_right_value"];
const handleKeys = ["bezier_left_time", "bezier_right_time", ...valueKeys, "bezier_linked"];
const fail = message => { throw Error("原生控制柄：" + message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);

// 工程使用 5.0 坐标，界面与动画文件使用基岩坐标；值柄和关键帧按同一轴翻转。
function flipFrames(frames, channel) {
  const flip = (value, axis) => ((channel === "position" && axis === 0) || (channel === "rotation" && axis < 2)) ? -value || 0 : value;
  return frames.map(frame => {
    const next = { ...frame, data_points: frame.data_points.map(point => Object.fromEntries(axes.map((axis, i) => [axis, flip(point[axis], i)]))) };
    for (const key of valueKeys) next[key] = frame[key].map(flip);
    return next;
  });
}

function nativeBezierDraft(animation, bone, channel) {
  const rows = animation?.dgn_native_bezier;
  if (!Array.isArray(rows)) fail("这个通道没有保存的原生控制柄");
  const records = rows.filter(row => row?.bone === bone && row.channel === channel);
  if (records.length !== 1) fail("控制柄记录缺失或重复");
  const track = animation.bones?.[bone]?.[channel];
  if (!object(track)) fail("通道不是关键帧");
  const vector = value => {
    const values = Array.isArray(value) ? value : [value, value, value];
    if (values.length !== 3 || values.some(n => typeof n !== "number" || !Number.isFinite(n))) fail("通道包含非数值帧");
    return Object.fromEntries(axes.map((axis, i) => [axis, values[i]]));
  };
  const samples = Object.entries(track).map(([time, frame]) => ({
    channel, time: Number(time), interpolation: frame?.lerp_mode || "linear",
    data_points: (object(frame) ? [frame.pre, frame.post].filter(point => point !== undefined) : [frame]).map(vector),
    bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0],
  }));
  const restored = restoreNativeFrames(flipFrames(samples, channel), records[0].frames);
  if (!restored) fail("采样帧已修改，不能用旧控制柄覆盖；请先撤销采样修改");
  return flipFrames(restored, channel);
}

function updateNativeBezier(animation, bone, channel, draft) {
  const original = nativeBezierDraft(animation, bone, channel);
  const checked = bakeNativeFrames(draft);
  if (original.length !== checked.frames.length) fail("不能增删原生端点");
  for (let i = 0; i < original.length; i++) {
    for (const key of ["time", "channel", "interpolation", "data_points"]) {
      if (JSON.stringify(original[i][key]) !== JSON.stringify(checked.frames[i][key])) fail("端点已变化，请重新打开控制柄编辑器");
    }
  }
  if (original.every((frame, i) => handleKeys.every(key => JSON.stringify(frame[key]) === JSON.stringify(checked.frames[i][key])))) return animation;
  const stored = bakeNativeFrames(flipFrames(checked.frames, channel));
  const samples = flipFrames(stored.sampled.map(frame => ({ ...frame, bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0] })), channel);
  let count = samples.length;
  for (const [name, tracks] of Object.entries(animation.bones || {})) for (const [kind, track] of Object.entries(tracks)) {
    if (name === bone && kind === channel) continue;
    count += object(track) ? Object.keys(track).length : 1;
  }
  for (const kind of ["sound_effects", "particle_effects", "timeline"]) count += Object.keys(animation[kind] || {}).length;
  if (count > 10000) fail("采样后整条动画超过 10000 帧");
  const oldTrack = animation.bones[bone][channel], oldKeys = new Map(Object.keys(oldTrack).map(key => [Number(key), key]));
  const track = {};
  for (const frame of samples) {
    const key = oldKeys.get(frame.time) ?? frame.time.toFixed(2);
    const old = oldTrack[key], points = frame.data_points.map(point => axes.map(axis => point[axis]));
    if (object(old)) {
      const next = { ...old };
      if (points.length === 2) { next.pre = points[0]; next.post = points[1]; }
      else if (Object.hasOwn(next, "pre") && !Object.hasOwn(next, "post")) next.pre = points[0];
      else { next.post = points[0]; delete next.pre; }
      track[key] = next;
    } else track[key] = points.length === 2 ? { pre: points[0], post: points[1] } : points[0];
  }
  const result = { ...animation, bones: { ...animation.bones, [bone]: { ...animation.bones[bone], [channel]: track } },
    dgn_native_bezier: animation.dgn_native_bezier.map(row => row.bone === bone && row.channel === channel ? { ...row, frames: stored.frames } : row) };
  if (Array.isArray(result.dgn_bezier)) {
    result.dgn_bezier = result.dgn_bezier.filter(row => row.bone !== bone || row.channel !== channel);
    if (!result.dgn_bezier.length) delete result.dgn_bezier;
  }
  return result;
}

function changeNativeHandle(frames, index, side, axis, time, value) {
  if (![0, 1, 2].includes(axis) || !["left", "right"].includes(side) || !frames[index] || !Number.isFinite(time) || !Number.isFinite(value)) fail("控制柄参数无效");
  if (side === "left" && time > 0 || side === "right" && time < 0) fail("入柄时间不能大于零，出柄时间不能小于零");
  const next = structuredClone(frames), frame = next[index];
  frame["bezier_" + side + "_time"][axis] = time;
  frame["bezier_" + side + "_value"][axis] = value;
  if (frame.bezier_linked !== false) {
    const opposite = side === "left" ? "right" : "left";
    frame["bezier_" + opposite + "_time"][axis] = -time || 0;
    frame["bezier_" + opposite + "_value"][axis] = -value || 0;
  }
  return next;
}

function linkNativeHandles(frames, index, side, linked) {
  if (!frames[index] || !["left", "right"].includes(side) || typeof linked !== "boolean") fail("联动参数无效");
  const next = structuredClone(frames), frame = next[index];
  frame.bezier_linked = linked;
  if (linked) {
    const opposite = side === "left" ? "right" : "left";
    for (const kind of ["time", "value"]) frame["bezier_" + opposite + "_" + kind] = frame["bezier_" + side + "_" + kind].map(n => -n || 0);
  }
  return next;
}

module.exports = { nativeBezierDraft, updateNativeBezier, changeNativeHandle, linkNativeHandles };
