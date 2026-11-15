const axes = ["x", "y", "z"];
const handles = ["bezier_left_time", "bezier_right_time", "bezier_left_value", "bezier_right_value"];
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6;
const round = value => Math.round(value * 1000) / 1000;
const fail = message => { throw Error("贝塞尔：" + message); };

function checkedFrames(frames) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 10000) fail("关键帧数量无效");
  const result = frames.map(frame => {
    if (!["rotation", "position", "scale"].includes(frame.channel) || frame.channel !== frames[0].channel) fail("通道无效或混合");
    const time = frame.time;
    if (!finite(time) || time < 0 || time > 10000 || Math.abs(time * 20 - Math.round(time * 20)) > 1e-6) fail("时间须为 0.05 秒的倍数");
    if (!["linear", "bezier", undefined].includes(frame.interpolation)) fail("同一通道暂不能混用阶跃或 Catmull-Rom");
    if (!Array.isArray(frame.data_points) || !frame.data_points.length || frame.data_points.length > 2) fail("关键帧数据无效");
    const copy = { channel: frame.channel, time, interpolation: frame.interpolation || "linear", data_points: frame.data_points.map(point => {
      if (axes.some(axis => !finite(point?.[axis]))) fail("关键帧须为有限数值，暂不支持表达式");
      return Object.fromEntries(axes.map(axis => [axis, point[axis]]));
    }) };
    if (frame.bezier_linked !== undefined && typeof frame.bezier_linked !== "boolean") fail("控制柄联动标记无效");
    if (frame.bezier_linked !== undefined) copy.bezier_linked = frame.bezier_linked;
    for (const key of handles) {
      const fallback = key === "bezier_left_time" ? -0.1 : key === "bezier_right_time" ? 0.1 : 0;
      const value = frame[key] ?? [fallback, fallback, fallback];
      if (!Array.isArray(value) || value.length !== 3 || value.some(n => !finite(n))) fail("控制柄须为三维有限数值");
      copy[key] = value.slice();
    }
    return copy;
  }).sort((a, b) => a.time - b.time);
  if (result.some((frame, i) => i && frame.time === result[i - 1].time)) fail("关键帧时间重复");
  return result;
}

function cubic(t, a, b, c, d) {
  return (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
}

function sampleSegment(before, after, at, axis) {
  const span = after.time - before.time, index = axes.indexOf(axis);
  const start = before.data_points.at(-1)[axis], end = after.data_points[0][axis];
  if (before.interpolation !== "bezier" && after.interpolation !== "bezier") return start + (end - start) * at;
  const x1 = Math.max(0, Math.min(span, before.bezier_right_time[index])) / span;
  const x2 = 1 + Math.max(-span, Math.min(0, after.bezier_left_time[index])) / span;
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(mid, 0, x1, x2, 1) < at) lo = mid; else hi = mid;
  }
  const value = cubic((lo + hi) / 2, start, start + before.bezier_right_value[index], end + after.bezier_left_value[index], end);
  if (!finite(value)) fail("采样数值超限");
  return value;
}

function bakeNativeFrames(source) {
  const frames = checkedFrames(source);
  const sampled = [];
  for (let i = 0; i < frames.length; i++) {
    const current = frames[i], next = frames[i + 1];
    sampled.push({ channel: current.channel, time: current.time, interpolation: "linear", data_points: current.data_points });
    if (!next || current.interpolation !== "bezier" && next.interpolation !== "bezier") continue;
    const steps = Math.round((next.time - current.time) * 20);
    if (steps > 1000) fail("单个采样区间超过 50 秒");
    if (sampled.length + steps - 1 + frames.length - i - 1 > 10000) fail("采样后超过 10000 个关键帧");
    for (let n = 1; n < steps; n++) {
      sampled.push({ channel: current.channel, time: (Math.round(current.time * 20) + n) / 20, interpolation: "linear",
        data_points: [Object.fromEntries(axes.map(axis => [axis, round(sampleSegment(current, next, n / steps, axis))]))] });
    }
  }
  return { frames, sampled };
}

function sameSamples(left, right) {
  const sorted = right.slice().sort((a, b) => a.time - b.time);
  return left.length === sorted.length && left.every((frame, i) =>
    frame.channel === sorted[i].channel && frame.time === sorted[i].time && (sorted[i].interpolation || "linear") === "linear" &&
    frame.data_points.length === sorted[i].data_points.length &&
    frame.data_points.every((point, j) => axes.every(axis => point[axis] === sorted[i].data_points[j][axis])));
}

// 只有样本仍匹配时才用旧控制柄；任何手工改帧都优先于工程元数据。
function restoreNativeFrames(frames, records) {
  if (!records) return null;
  const saved = bakeNativeFrames(records);
  return sameSamples(saved.sampled, frames) ? saved.frames : null;
}

function collapseBakedFrames(source, records) {
  if (!records?.length) return null;
  let frames;
  try { frames = checkedFrames(source); } catch { return null; }
  if (frames.some(frame => frame.interpolation !== "linear")) return null;
  const spans = new Map();
  for (const record of records) {
    if (!record || ![0, 1, 2].includes(record.axis) || !finite(record.from) || !finite(record.to) || record.to <= record.from) fail("缓动记录无效");
    const c = record.control;
    if (!Array.isArray(c) || c.length !== 4 || c.some(n => !finite(n)) || c[0] < 0 || c[2] > 1 || c[0] > c[2] || c[1] < -2 || c[1] > 3 || c[3] < -2 || c[3] > 3) fail("缓动控制点无效");
    const key = record.from + ":" + record.to;
    const span = spans.get(key) || { from: record.from, to: record.to, controls: new Map() };
    if (span.controls.has(record.axis)) fail("缓动轴重复");
    span.controls.set(record.axis, c); spans.set(key, span);
  }
  const ordered = [...spans.values()].sort((a, b) => a.from - b.from);
  if (ordered.some((span, i) => i && span.from < ordered[i - 1].to)) fail("缓动区间重叠");
  const removed = new Set();
  for (const span of ordered) {
    const first = frames.find(frame => frame.time === span.from), last = frames.find(frame => frame.time === span.to);
    if (!first || !last) return null;
    const steps = Math.round((span.to - span.from) * 20);
    if (steps < 2 || steps > 1000) return null;
    const inside = frames.filter(frame => frame.time > span.from && frame.time < span.to);
    if (inside.length !== steps - 1) return null;
    const a = structuredClone(first), b = structuredClone(last);
    a.interpolation = b.interpolation = "bezier";
    for (let axis = 0; axis < 3; axis++) {
      const c = span.controls.get(axis) || [1 / 3, 1 / 3, 2 / 3, 2 / 3];
      const delta = b.data_points[0][axes[axis]] - a.data_points.at(-1)[axes[axis]];
      a.bezier_right_time[axis] = c[0] * (span.to - span.from);
      a.bezier_right_value[axis] = c[1] * delta;
      b.bezier_left_time[axis] = (c[2] - 1) * (span.to - span.from);
      b.bezier_left_value[axis] = (c[3] - 1) * delta;
    }
    const expected = bakeNativeFrames([a, b]).sampled.slice(1, -1);
    if (!sameSamples(expected, inside)) return null;
    inside.forEach(frame => removed.add(frame.time));
  }
  const output = frames.filter(frame => !removed.has(frame.time)).map(frame => ({ ...frame, interpolation: "bezier", bezier_linked: false,
    bezier_left_time: [0, 0, 0], bezier_right_time: [0, 0, 0], bezier_left_value: [0, 0, 0], bezier_right_value: [0, 0, 0] }));
  for (let i = 0; i < output.length - 1; i++) {
    const a = output[i], b = output[i + 1], span = spans.get(a.time + ":" + b.time);
    if (b.time - a.time > 50) return null;
    for (let axis = 0; axis < 3; axis++) {
      const c = span?.controls.get(axis) || [1 / 3, 1 / 3, 2 / 3, 2 / 3];
      const delta = b.data_points[0][axes[axis]] - a.data_points.at(-1)[axes[axis]];
      a.bezier_right_time[axis] = c[0] * (b.time - a.time);
      a.bezier_right_value[axis] = c[1] * delta;
      b.bezier_left_time[axis] = (c[2] - 1) * (b.time - a.time);
      b.bezier_left_value[axis] = (c[3] - 1) * delta;
    }
  }
  // 改为原生柄会影响相邻区间；整个通道必须仍能在现有采样预算内重新打开。
  try { bakeNativeFrames(output); } catch { return null; }
  return output;
}

module.exports = { bakeNativeFrames, restoreNativeFrames, collapseBakedFrames };
