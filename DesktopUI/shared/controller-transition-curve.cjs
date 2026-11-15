const object = value => value && typeof value === "object" && !Array.isArray(value);
const fail = message => { throw Error("过渡曲线：" + message); };
const linearPoints = () => [{ time: 0, value: 1 }, { time: 1, value: 0 }];

function checkPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 32) fail("需要 2–32 个点");
  const copy = points.map(point => {
    if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.value) || point.time < 0 || point.time > 1 || point.value < 0 || point.value > 1) fail("时间比例和权重须在 0–1 之间");
    return { time: point.time, value: point.value };
  });
  if (copy.some((point, i) => i && point.time <= copy[i - 1].time)) fail("时间须严格递增，不能重复");
  if (copy[0].time !== 0 || copy[0].value !== 1 || copy.at(-1).time !== 1 || copy.at(-1).value !== 0) fail("首点须为 0/1，末点须为 1/0");
  return copy;
}

function readTransition(state) {
  if (!object(state)) fail("状态无效");
  if (state.blend_via_shortest_path !== undefined && typeof state.blend_via_shortest_path !== "boolean") throw Error("最短旋转路径标记须为布尔值");
  const raw = state.blend_transition ?? 0, separate = state.blend_transition_curve;
  let duration, points = null;
  if (object(raw)) {
    if (separate && Object.keys(separate).length) fail("同时存在两套曲线，不能确定来源");
    const rows = Object.entries(raw);
    if (rows.length < 2 || rows.length > 32) fail("需要 2–32 个点");
    const parsed = rows.map(([key, value]) => {
      if (!key.trim() || !Number.isFinite(Number(key)) || Number(key) < 0 || Number(key) > 60 || typeof value !== "number") fail("秒数或权重无效");
      return { time: Number(key), value };
    }).sort((a, b) => a.time - b.time);
    duration = parsed.at(-1).time;
    if (duration <= 0) fail("曲线时长须大于零");
    points = checkPoints(parsed.map(point => ({ time: point.time / duration, value: point.value })));
  } else {
    duration = raw;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 60) throw Error("状态过渡时长须为 0–60 秒的数字");
    if (separate != null) {
      if (!object(separate)) fail("独立曲线格式无效");
      if (Object.keys(separate).length) {
        if (!duration) fail("曲线时长须大于零");
        points = checkPoints(Object.entries(separate).map(([key, value]) => {
          if (!key.trim()) fail("时间比例无效");
          return { time: Number(key), value };
        }).sort((a, b) => a.time - b.time));
      }
    }
  }
  return { duration, points };
}

function transitionIncoming(points, progress) {
  if (!Number.isFinite(progress)) fail("进度无效");
  const at = Math.max(0, Math.min(1, progress));
  if (!points) return at;
  const checked = checkPoints(points);
  if (at === 0 || at === 1) return at;
  const i = checked.findIndex(point => point.time >= at), before = checked[i - 1], after = checked[i];
  return 1 - (before.value + (after.value - before.value) * (at - before.time) / (after.time - before.time));
}

function writeTransition(state, duration, points) {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 60) throw Error("状态过渡时长须为 0–60 秒的数字");
  const next = { ...state };
  if (!points) next.blend_transition = duration;
  else {
    if (!duration) fail("曲线时长须大于零；请先恢复线性");
    const map = {};
    for (const point of checkPoints(points)) {
      const key = String(Number((point.time * duration).toFixed(6)));
      if (Object.hasOwn(map, key)) fail("按秒保存后时间点重合，请拉开间距");
      map[key] = point.value;
    }
    next.blend_transition = map;
  }
  delete next.blend_transition_curve;
  readTransition(next);
  return next;
}

function moveTransitionPoint(points, index, time, value) {
  const current = checkPoints(points);
  if (!Number.isInteger(index) || index <= 0 || index >= current.length - 1) fail("首尾点固定");
  current[index] = { time, value };
  return checkPoints(current);
}

function addTransitionPoint(points, after) {
  const current = checkPoints(points);
  if (!Number.isInteger(after) || after < 0 || after >= current.length - 1) fail("请选择一个有后续点的位置");
  const a = current[after], b = current[after + 1];
  current.splice(after + 1, 0, { time: (a.time + b.time) / 2, value: (a.value + b.value) / 2 });
  return checkPoints(current);
}

function removeTransitionPoint(points, index) {
  const current = checkPoints(points);
  if (!Number.isInteger(index) || index <= 0 || index >= current.length - 1) fail("首尾点固定");
  current.splice(index, 1);
  return current;
}

module.exports = { linearPoints, checkPoints, readTransition, transitionIncoming, writeTransition, moveTransitionPoint, addTransitionPoint, removeTransitionPoint };
