const { evaluateMolang } = require("../../../shared/molang-preview.cjs");
const { soundFrames, setSoundKey, clearSoundKey } = require("../../../shared/animation-sounds.cjs");

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function vectorOf(frame) {
  const value = Array.isArray(frame) || typeof frame === "number" || typeof frame === "string" ? frame : frame?.post ?? frame?.pre;
  const source = typeof value === "number" || typeof value === "string" ? [value, value, value] : value;
  if (!Array.isArray(source) || source.length < 3 || source.slice(0, 3).some(value => typeof value !== "number" && typeof value !== "string")) return null;
  return source.slice(0, 3).map(value => typeof value === "number" ? round(value) : value);
}

function trackOf(value) {
  if (Array.isArray(value) || typeof value === "number" || typeof value === "string") {
    const vec = vectorOf(value);
    return vec ? [[0, ...vec]] : [];
  }
  if (!value || typeof value !== "object") return [];
  const frames = [];
  for (const [time, frame] of Object.entries(value)) {
    const at = Number(time);
    const vec = vectorOf(frame);
    if (Number.isFinite(at) && vec) {
      const incoming = !Array.isArray(frame) && frame?.pre !== undefined ? vectorOf(frame.pre) : null;
      const step = !!incoming && frame?.post !== undefined && frame?.lerp_mode !== "catmullrom";
      const mode = frame?.lerp_mode === "catmullrom" ? "catmullrom" : step ? "step" : "";
      frames.push(incoming ? [round(at), ...vec, mode, incoming] : mode ? [round(at), ...vec, mode] : [round(at), ...vec]);
    }
  }
  frames.sort((a, b) => a[0] - b[0]);
  return frames;
}

function sampleTrack(keys, time, onError, context, controllerContext) {
  try {
    const value = sampleNumericTrack(keys, time, context, controllerContext);
    if (value?.some(item => !Number.isFinite(item))) throw Error("动画插值结果超出范围");
    return value;
  }
  catch (error) { onError?.(error.message); return null; }
}

function sampleNumericTrack(keys, time, context, controllerContext) {
  // 表达式按当前播放时间求值，不能在导入时冻结成数字。
  if (!keys?.length) return null;
  const vec = (key, incoming = false) => (incoming && key[5] ? key[5] : key.slice(1, 4)).map(value => evaluateMolang(value, time, context, controllerContext));
  if (time < keys[0][0]) return vec(keys[0], true);
  if (time === keys[0][0]) return vec(keys[0]);
  const last = keys[keys.length - 1];
  if (time >= last[0]) return vec(last);
  let index = 1;
  while (keys[index][0] < time) index += 1;
  const from = keys[index - 1];
  const to = keys[index];
  const span = to[0] - from[0] || 1;
  const amount = (time - from[0]) / span;
  if (time === to[0]) return vec(to);
  if (to[4] === "step" && !to[5]) return vec(from);
  const start = vec(from);
  const end = vec(to, true);
  if (to[4] !== "catmullrom") return start.map((value, axis) => value + (end[axis] - value) * amount);
  const before = vec(keys[index - 2] || from);
  const after = vec(keys[index + 1] || to);
  return [0, 1, 2].map(axis => {
    const p0 = before[axis];
    const p1 = start[axis];
    const p2 = end[axis];
    const p3 = after[axis];
    const t2 = amount * amount;
    const t3 = t2 * amount;
    return 0.5 * (2 * p1 + (-p0 + p2) * amount + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  });
}

function hasExpressions(channel) {
  if (typeof channel === "string") return true;
  if (Array.isArray(channel)) return channel.some(value => typeof value === "string");
  if (!channel || typeof channel !== "object") return false;
  return Object.values(channel).some(frame => Array.isArray(frame) || typeof frame === "string"
    ? hasExpressions(frame) : hasExpressions(frame?.pre) || hasExpressions(frame?.post));
}

function curveSamples(keys, length, axis) {
  if (!keys.length || !Number.isFinite(length) || length <= 0 || ![0, 1, 2].includes(axis)) return [];
  const times = new Set(Array.from({ length: 121 }, (_, index) => length * index / 120));
  for (const key of keys) if (key[0] >= 0 && key[0] <= length) times.add(key[0]);
  const points = [];
  const byTime = new Map(keys.map((key, index) => [key[0], { key, index }]));
  for (const time of [...times].sort((a, b) => a - b)) {
    const entry = byTime.get(time);
    if (entry && time > 0 && (entry.key[5] || entry.key[4] === "step")) {
      // 跳变处保留左右两个值，避免把阶跃画成斜线。
      const previousTime = keys[entry.index - 1]?.[0] ?? 0;
      const before = sampleTrack(keys, time - Math.min(1e-7, (time - previousTime) / 2));
      if (before) points.push([time, before[axis]]);
    }
    const value = sampleTrack(keys, time);
    if (value) points.push([time, value[axis]]);
  }
  return points;
}

function requireNumericChannel(animation, bone, channel) {
  if (hasExpressions(animation?.bones?.[bone]?.[channel])) throw Error("当前通道含 Molang，请在源文件中编辑表达式，数值编辑不会覆盖它");
}

function clipTime(clip, seconds) {
  const length = clip?.length || 0;
  if (length <= 0) return 0;
  if (clip.loop) return seconds % length;
  return Math.min(seconds, length);
}

function corresponds(animId, short) {
  const lower = animId.toLowerCase();
  const name = short.toLowerCase();
  if (lower.includes(name)) return true;
  const stem = name.replace(/_dlcnpc$/, "");
  return stem.length >= 3 && lower.split(".").includes(stem);
}

function rank(name) {
  const value = name.toLowerCase();
  if (value === "idle") return 0;
  if (value === "general" || value === "setup") return 1;
  if (value === "walk" || value === "move") return 2;
  if (value.includes("kill") || value === "death") return 8;
  return 4;
}

function pickDefault(names) {
  return names.slice().sort((a, b) => rank(a) - rank(b) || a.length - b.length)[0] || "";
}

function clipFromBedrock(animation) {
  const bones = {};
  for (const [name, channels] of Object.entries(animation?.bones || {})) {
    if (!channels || typeof channels !== "object") continue;
    const entry = {};
    const rotation = trackOf(channels.rotation);
    const position = trackOf(channels.position);
    const scale = trackOf(channels.scale);
    if (rotation.length) entry.r = rotation;
    if (position.length) entry.p = position;
    if (scale.length) entry.s = scale;
    if (Object.keys(entry).length) bones[name.toLowerCase()] = entry;
  }
  const length = Number(animation?.animation_length);
  return { length: length > 0 ? length : 1, loop: repeats(animation?.loop), bones };
}

function earlierVec(frames, at) {
  let best = -1;
  let value = null;
  for (const key of Object.keys(frames || {})) {
    const time = Number(key);
    if (!Number.isFinite(time) || time >= Number(at) || time < best) continue;
    const vec = vectorOf(frames[key]);
    if (!vec) continue;
    best = time;
    value = vec;
  }
  return value;
}

function keptLoop(loop) {
  if (loop === false || loop === 'hold_on_last_frame') return loop;
  return true;
}

function repeats(loop) {
  return keptLoop(loop) === true;
}

function setBoneKey(animation, bone, channel, time, vector) {
  const kind = channel === "position" || channel === "scale" ? channel : "rotation";
  requireNumericChannel(animation, bone, kind);
  const snapped = Math.max(0, Math.round(Number(time) * 20) / 20);
  const at = Object.keys(animation?.bones?.[bone]?.[kind] || {}).find(key => Number(key) === snapped) ?? snapped.toFixed(2);
  const next = {
    ...animation,
    loop: keptLoop(animation?.loop),
    animation_length: Number(animation?.animation_length) > 0 ? Number(animation.animation_length) : 1,
    bones: { ...(animation?.bones || {}) },
  };
  const current = next.bones[bone] && typeof next.bones[bone] === "object" ? { ...next.bones[bone] } : {};
  const frames = current[kind] && typeof current[kind] === "object" && !Array.isArray(current[kind]) ? { ...current[kind] } : {};
  frames[at] = [0, 1, 2].map(index => Math.round((Number(vector?.[index]) || 0) * 1000) / 1000);
  const previous = current[kind]?.[at];
  if (previous && !Array.isArray(previous) && typeof previous === "object") frames[at] = { ...previous, post: frames[at] };
  current[kind] = frames;
  next.bones[bone] = current;
  next.animation_length = Math.max(next.animation_length, ...Object.keys(frames).map(Number), 1);
  next.animation_length = Math.round(next.animation_length * 20) / 20;
  return next;
}

function setRotationKey(animation, bone, time, rotation) {
  return setBoneKey(animation, bone, "rotation", time, rotation);
}

function keyMode(animation, bone, channel, time) {
  const kind = channel === "position" || channel === "scale" ? channel : "rotation";
  const frame = animation?.bones?.[bone]?.[kind]?.[snapTime(time)];
  if (!frame || Array.isArray(frame)) return "linear";
  if (frame.lerp_mode === "catmullrom") return "catmullrom";
  if (Array.isArray(frame.pre) && Array.isArray(frame.post)) return "step";
  return "linear";
}

function setKeyMode(animation, bone, channel, time, mode) {
  const kind = channel === "position" || channel === "scale" ? channel : "rotation";
  requireNumericChannel(animation, bone, kind);
  const at = snapTime(time);
  const frames = animation?.bones?.[bone]?.[kind];
  if (!frames || typeof frames !== "object" || Array.isArray(frames) || !Object.prototype.hasOwnProperty.call(frames, at)) return animation;
  const wanted = mode === "catmullrom" ? "catmullrom" : mode === "step" ? "step" : "linear";
  if (keyMode(animation, bone, channel, time) === wanted) return animation;
  const vec = vectorOf(frames[at]);
  if (!vec) return animation;
  const next = {
    ...animation,
    loop: keptLoop(animation?.loop),
    animation_length: Number(animation?.animation_length) > 0 ? Number(animation.animation_length) : 1,
    bones: { ...(animation?.bones || {}) },
  };
  const current = { ...next.bones[bone] };
  const kept = { ...frames };
  kept[at] = wanted === "catmullrom" ? { post: vec, lerp_mode: "catmullrom" } : wanted === "step" ? { pre: earlierVec(frames, at) || vec, post: vec } : vec;
  current[kind] = kept;
  next.bones[bone] = current;
  return next;
}

function snapTime(time) {
  return Math.max(0, Math.round((Number(time) || 0) * 20) / 20).toFixed(2);
}

function frameEntries(animation, bone, channel) {
  if (!["rotation", "position", "scale"].includes(channel)) throw Error("动画通道无效");
  const frames = animation?.bones?.[bone]?.[channel];
  if (frames === undefined) return [];
  if (!frames || typeof frames !== "object" || Array.isArray(frames)) throw Error("常量通道不能进行关键帧批量操作");
  const seen = new Set();
  return Object.entries(frames).map(([key, frame]) => {
    const time = Number(key);
    if (!key.trim() || !Number.isFinite(time) || time < 0 || time > 10000 || seen.has(time)) throw Error("关键帧时间无效或重复");
    seen.add(time);
    return { key, time, frame };
  }).sort((a, b) => a.time - b.time);
}

function chosenFrames(entries, times) {
  if (!Array.isArray(times) || !times.length || times.some(time => !Number.isFinite(time))) throw Error("先选择关键帧");
  const unique = new Set(times);
  const chosen = entries.filter(entry => unique.has(entry.time));
  if (chosen.length !== unique.size) throw Error("所选关键帧已变化，请重新选择");
  return chosen;
}

function validateBezier(control) {
  if (!Array.isArray(control) || control.length !== 4 || control.some(value => !Number.isFinite(value))
    || control[0] < 0 || control[0] > 1 || control[2] < control[0] || control[2] > 1
    || control[1] < -2 || control[1] > 3 || control[3] < -2 || control[3] > 3) throw Error("控制点时间须按顺序在 0–1 之间，数值比例须在 -2–3 之间");
}

function bezierAmount(time, control) {
  validateBezier(control);
  if (!Number.isFinite(time) || time < 0 || time > 1) throw Error("缓动时间比例无效");
  if (time === 0 || time === 1) return time;
  const cubic = (t, a, b) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let low = 0, high = 1;
  for (let i = 0; i < 40; i++) {
    const t = (low + high) / 2;
    if (cubic(t, control[0], control[2]) < time) low = t; else high = t;
  }
  return cubic((low + high) / 2, control[1], control[3]);
}

function bezierSegment(animation, bone, channel, start) {
  requireNumericChannel(animation, bone, channel);
  const entries = frameEntries(animation, bone, channel), index = entries.findIndex(entry => entry.time === start);
  const from = entries[index], to = entries[index + 1];
  if (index < 0 || !to) throw Error("选择一个带后续关键帧的起点");
  if ([from, to].some(entry => Math.abs(entry.time * 20 - Math.round(entry.time * 20)) > 1e-6)) throw Error("区间端点须位于 0.05 秒步长上");
  const steps = Math.round((to.time - from.time) * 20);
  if (steps < 2 || steps > 1000) throw Error("贝塞尔采样区间须在 0.1–50 秒之间");
  if (to.frame?.lerp_mode && to.frame.lerp_mode !== "linear") throw Error("当前区间须使用线性插值，再生成贝塞尔关键帧");
  if ((index > 0 && from.frame?.lerp_mode === "catmullrom") || entries[index + 2]?.frame?.lerp_mode === "catmullrom") throw Error("相邻区间使用平滑插值，插入关键帧会改变其曲线；请先改为线性");
  const first = vectorOf(from.frame), last = vectorOf(to.frame?.pre ?? to.frame);
  if (!first || !last || [...first, ...last].some(value => !Number.isFinite(value) || Math.abs(value) > 1e6)) throw Error("区间端点须为有限数值，不能包含表达式");
  return { from: from.time, to: to.time, first, last, steps };
}

function bakeBezier(animation, bone, channel, start, axis, control) {
  if (![0, 1, 2].includes(axis)) throw Error("曲线轴无效");
  validateBezier(control);
  const existing = bezierRecords(animation).filter(item => item.bone === bone && item.channel === channel && sameTime(item.from, start));
  const prepared = existing.length ? withoutSpan(animation, bone, channel, existing[0].from, existing[0].to) : animation;
  const segment = bezierSegment(prepared, bone, channel, start);
  if (existing.length && !sameTime(existing[0].to, segment.to)) throw Error("已记录的贝塞尔区间已变化");
  let count = 0;
  for (const item of Object.values(prepared.bones || {})) for (const kind of ["rotation", "position", "scale"]) {
    const track = item?.[kind];
    if (track && typeof track === "object" && !Array.isArray(track)) count += Object.keys(track).length;
  }
  if (count + segment.steps - 1 > 10000) throw Error("采样后动画超过 10000 个关键帧");
  const controls = new Map(existing.map(item => [item.axis, item.control]));
  controls.set(axis, control.map(Number));
  const frames = { ...prepared.bones[bone][channel] };
  for (let i = 1; i < segment.steps; i++) {
    const amount = i / segment.steps;
    const vector = segment.first.map((value, index) => round(value + (segment.last[index] - value) * (controls.has(index) ? bezierAmount(amount, controls.get(index)) : amount)));
    if (vector.some(value => !Number.isFinite(value) || Math.abs(value) > 1e6)) throw Error("贝塞尔采样数值超出范围");
    const time = ((Math.round(segment.from * 20) + i) / 20).toFixed(2);
    if (Object.hasOwn(frames, time)) throw Error("目标时间已有关键帧，未覆盖任何帧");
    frames[time] = vector;
  }
  const kept = bezierRecords(animation).filter(item => !(item.bone === bone && item.channel === channel && sameTime(item.from, segment.from)));
  for (const [axisIndex, value] of controls) kept.push({ bone, channel, axis: axisIndex, from: segment.from, to: segment.to, control: value.slice() });
  if (kept.length > 400) throw Error("贝塞尔记录超过 400 条");
  return { ...prepared, bones: { ...prepared.bones, [bone]: { ...prepared.bones[bone], [channel]: frames } }, dgn_bezier: kept };
}

function sameTime(left, right) { return Math.abs(Number(left) - Number(right)) < 1e-6; }

function bezierRecords(animation) { return Array.isArray(animation?.dgn_bezier) ? animation.dgn_bezier : []; }

function withoutSpan(animation, bone, channel, from, to) {
  const frames = { ...(animation.bones?.[bone]?.[channel] || {}) };
  for (const time of Object.keys(frames)) {
    const value = Number(time);
    if (value > Number(from) + 1e-6 && value < Number(to) - 1e-6) delete frames[time];
  }
  return { ...animation, bones: { ...animation.bones, [bone]: { ...animation.bones[bone], [channel]: frames } } };
}

function bezierDraft(animation, bone, channel, axis, time) {
  const records = bezierRecords(animation).filter(item => item.bone === bone && item.channel === channel);
  const interior = value => records.some(item => item.from + 1e-6 < value && value < item.to - 1e-6);
  const starts = keyTimes(animation, bone, channel).filter(value => !interior(value));
  const usable = starts.slice(0, -1);
  const cover = records.find(item => item.axis === axis && item.from - 1e-6 <= time && time < item.to - 1e-6);
  const start = cover ? cover.from : (usable.filter(value => value <= time).at(-1) ?? usable[0]);
  const saved = records.find(item => item.axis === axis && sameTime(item.from, start));
  return { start, starts: usable, control: saved ? saved.control.slice() : null };
}

function bezierPreviewSegment(animation, bone, channel, start) {
  const saved = bezierRecords(animation).filter(item => item.bone === bone && item.channel === channel && sameTime(item.from, start));
  const prepared = saved.length ? withoutSpan(animation, bone, channel, saved[0].from, saved[0].to) : animation;
  return bezierSegment(prepared, bone, channel, start);
}

function soundEntries(animation) {
  return soundFrames(animation?.sound_effects).flatMap(row => row.sounds.map(sound => ({ time: row.time, effect: sound.effect })));
}

function destinationTime(value) {
  if (!Number.isFinite(value) || value < 0 || value > 10000) throw Error("关键帧时间必须在 0–10000 秒之间");
  return Math.round(value * 1e6) / 1e6;
}

function destinationKey(time) {
  return Math.abs(time * 100 - Math.round(time * 100)) < 1e-6 ? time.toFixed(2) : String(time);
}

function withFrames(animation, bone, channel, frames) {
  const current = { ...animation?.bones?.[bone] };
  const bones = { ...animation?.bones };
  if (Object.keys(frames).length) current[channel] = frames;
  else delete current[channel];
  if (Object.keys(current).length) bones[bone] = current;
  else delete bones[bone];
  const length = Math.max(Number(animation?.animation_length) || 1, ...Object.keys(frames).map(Number));
  return { ...animation, bones, animation_length: length };
}

function moveBoneKeys(animation, bone, channel, times, delta) {
  if (!Number.isFinite(delta)) throw Error("移动时间无效");
  const entries = frameEntries(animation, bone, channel);
  const chosen = chosenFrames(entries, times);
  if (!delta) return animation;
  const selected = new Set(chosen.map(entry => entry.key));
  const occupied = new Set(entries.filter(entry => !selected.has(entry.key)).map(entry => entry.time));
  const destinations = chosen.map(entry => destinationTime(entry.time + delta));
  if (new Set(destinations).size !== destinations.length || destinations.some(time => occupied.has(time))) throw Error("目标时间已有关键帧，未覆盖任何帧");
  const frames = Object.fromEntries(entries.filter(entry => !selected.has(entry.key)).map(entry => [entry.key, entry.frame]));
  chosen.forEach((entry, index) => { frames[destinationKey(destinations[index])] = entry.frame; });
  return withFrames(animation, bone, channel, frames);
}

function copyBoneKeys(animation, bone, channel, times) {
  const chosen = chosenFrames(frameEntries(animation, bone, channel), times);
  return { channel, frames: chosen.map(entry => ({ offset: destinationTime(entry.time - chosen[0].time), frame: structuredClone(entry.frame) })) };
}

function pasteBoneKeys(animation, bone, clipboard, at) {
  if (typeof bone !== "string" || !bone || ["__proto__", "constructor", "prototype"].includes(bone)) throw Error("目标骨骼无效");
  destinationTime(at);
  if (!clipboard?.frames?.length || clipboard.frames.length > 10000) throw Error("没有可粘贴的关键帧");
  const entries = frameEntries(animation, bone, clipboard.channel);
  const occupied = new Set(entries.map(entry => entry.time));
  const destinations = clipboard.frames.map(entry => destinationTime(at + entry.offset));
  if (new Set(destinations).size !== destinations.length || destinations.some(time => occupied.has(time))) throw Error("目标时间已有关键帧，未覆盖任何帧");
  const frames = Object.fromEntries(entries.map(entry => [entry.key, entry.frame]));
  clipboard.frames.forEach((entry, index) => { frames[destinationKey(destinations[index])] = structuredClone(entry.frame); });
  return withFrames(animation, bone, clipboard.channel, frames);
}

function clearBoneKeys(animation, bone, channel, times) {
  const entries = frameEntries(animation, bone, channel);
  const removed = new Set(chosenFrames(entries, times).map(entry => entry.key));
  return withFrames(animation, bone, channel, Object.fromEntries(entries.filter(entry => !removed.has(entry.key)).map(entry => [entry.key, entry.frame])));
}

function selectionTracks(selection) {
  if (!Array.isArray(selection) || !selection.length || selection.length > 10000) throw Error("请选择 1–10000 个关键帧");
  const tracks = new Map();
  for (const item of selection) {
    if (typeof item?.bone !== "string" || !item.bone || ["__proto__", "constructor", "prototype"].includes(item.bone)) throw Error("目标骨骼无效");
    if (!["rotation", "position", "scale"].includes(item.channel)) throw Error("动画通道无效");
    destinationTime(item.time);
    const id = JSON.stringify([item.bone, item.channel]);
    if (!tracks.has(id)) tracks.set(id, { bone: item.bone, channel: item.channel, times: [] });
    const track = tracks.get(id);
    if (track.times.includes(item.time)) throw Error("选择中存在重复关键帧");
    track.times.push(item.time);
  }
  return [...tracks.values()];
}

function moveKeySelection(animation, selection, delta) {
  // 各轨道仅生成新对象，任一轨道失败时不会提交局部结果。
  let next = animation;
  for (const track of selectionTracks(selection)) next = moveBoneKeys(next, track.bone, track.channel, track.times, delta);
  return next;
}

function clearKeySelection(animation, selection) {
  let next = animation;
  for (const track of selectionTracks(selection)) next = clearBoneKeys(next, track.bone, track.channel, track.times);
  return next;
}

function copyKeySelection(animation, selection) {
  const tracks = selectionTracks(selection);
  const start = Math.min(...selection.map(item => item.time));
  return { tracks: tracks.map(track => {
    const copy = copyBoneKeys(animation, track.bone, track.channel, track.times);
    const offset = Math.min(...track.times) - start;
    return { bone: track.bone, channel: track.channel, frames: copy.frames.map(frame => ({ ...frame, offset: destinationTime(frame.offset + offset) })) };
  }) };
}

function pasteKeySelection(animation, clipboard, at, boneNames, targetBone) {
  if (!Array.isArray(clipboard?.tracks) || !clipboard.tracks.length || clipboard.tracks.length > 10000) throw Error("没有可粘贴的轨道");
  const tracks = clipboard.tracks.map(track => ({ ...track, bone: clipboard.tracks.length === 1 && targetBone ? targetBone : track.bone }));
  const selection = [];
  for (const track of tracks) {
    if (!boneNames.includes(track.bone)) throw Error("目标模型缺少骨骼 " + track.bone + "，未粘贴任何帧");
    if (!Array.isArray(track.frames) || !track.frames.length || track.frames.length > 10000) throw Error("没有可粘贴的关键帧");
    for (const frame of track.frames) {
      destinationTime(frame.offset);
      selection.push({ bone: track.bone, channel: track.channel, time: destinationTime(at + frame.offset) });
      if (selection.length > 10000) throw Error("最多粘贴 10000 个关键帧");
    }
  }
  selectionTracks(selection);
  let next = animation;
  for (const track of tracks) next = pasteBoneKeys(next, track.bone, track, at);
  return { animation: next, selection };
}

function moveBoneKey(animation, bone, channel, from, to) {
  if (!keyTimes(animation, bone, channel).includes(from)) return animation;
  return moveBoneKeys(animation, bone, channel, [from], to - from);
}

function moveCurveKey(animation, bone, channel, from, to, axis, value, part = "post") {
  requireNumericChannel(animation, bone, channel);
  if (!["pre", "post"].includes(part)) throw Error("曲线端点无效");
  if (![0, 1, 2].includes(axis) || !Number.isFinite(value) || Math.abs(value) > 1e6) throw Error("曲线值无效或超出范围");
  destinationTime(from); destinationTime(to);
  const source = animation?.bones?.[bone]?.[channel], constant = typeof source === "number" || Array.isArray(source);
  const base = constant ? { ...animation, bones: { ...animation.bones, [bone]: { ...animation.bones[bone], [channel]: { "0.00": source } } } } : animation;
  const entries = frameEntries(base, bone, channel), entry = chosenFrames(entries, [from])[0];
  const frame = entry.frame;
  if (part === "pre" && (!frame || Array.isArray(frame) || typeof frame !== "object" || !Object.hasOwn(frame, "pre") || !Object.hasOwn(frame, "post"))) throw Error("此帧没有独立入点，请重新选择");
  const raw = part === "pre" ? frame.pre : Array.isArray(frame) || typeof frame === "number" ? frame : frame?.post ?? frame?.pre;
  const vector = typeof raw === "number" ? [raw, raw, raw] : raw?.slice();
  if (!vector || vector.length !== 3 || vector.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) throw Error("曲线关键帧不是可编辑的数值");
  if (from === to && vector[axis] === round(value)) return animation;
  const next = moveBoneKeys(base, bone, channel, [from], to - from);
  const key = from === to ? entry.key : destinationKey(to);
  vector[axis] = round(value);
  const frames = { ...next.bones[bone][channel] };
  frames[key] = Array.isArray(frame) || typeof frame === "number" ? vector : { ...frame, [part]: vector };
  return curveFrames(next, bone, channel, frames);
}

function curveFrames(animation, bone, channel, frames) {
  const next = withFrames(animation, bone, channel, frames);
  // 手工改帧后不再复用旧缓动记录，避免再次生成时覆盖用户修改。
  if (Array.isArray(next.dgn_bezier)) {
    next.dgn_bezier = next.dgn_bezier.filter(item => item.bone !== bone || item.channel !== channel);
    if (!next.dgn_bezier.length) delete next.dgn_bezier;
  }
  return next;
}

function insertCurveKey(animation, bone, channel, time) {
  if (typeof bone !== "string" || !bone || ["__proto__", "constructor", "prototype"].includes(bone)) throw Error("目标骨骼无效");
  if (!["rotation", "position", "scale"].includes(channel)) throw Error("动画通道无效");
  requireNumericChannel(animation, bone, channel); destinationTime(time);
  if (Math.abs(time * 20 - Math.round(time * 20)) > 1e-6) throw Error("插入时间须按 0.05 秒对齐");
  const source = animation?.bones?.[bone]?.[channel], constant = typeof source === "number" || Array.isArray(source);
  const entries = constant ? [{ key: "0.00", time: 0, frame: source }] : frameEntries(animation, bone, channel);
  if (entries.some(entry => entry.time === time)) throw Error("目标时间已有关键帧，未覆盖任何帧");
  const vector = source === undefined ? [channel === "scale" ? 1 : 0, channel === "scale" ? 1 : 0, channel === "scale" ? 1 : 0] : sampleTrack(trackOf(source), time);
  if (!vector || vector.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) throw Error("曲线关键帧不是可编辑的数值");
  let count = 0;
  for (const tracks of Object.values(animation?.bones || {})) for (const name of ["rotation", "position", "scale"]) {
    const track = tracks?.[name];
    if (track !== undefined) count += typeof track === "number" || typeof track === "string" || Array.isArray(track) ? 1 : Object.keys(track).length;
  }
  if (count >= 10000) throw Error("动画超过 10000 个关键帧");
  return curveFrames(animation, bone, channel, { ...Object.fromEntries(entries.map(entry => [entry.key, entry.frame])), [destinationKey(time)]: vector.map(round) });
}

function deleteCurveKey(animation, bone, channel, time) {
  requireNumericChannel(animation, bone, channel);
  const source = animation?.bones?.[bone]?.[channel], constant = typeof source === "number" || Array.isArray(source);
  if (constant && time === 0) return curveFrames(animation, bone, channel, {});
  const entries = frameEntries(animation, bone, channel), removed = chosenFrames(entries, [time])[0];
  return curveFrames(animation, bone, channel, Object.fromEntries(entries.filter(entry => entry !== removed).map(entry => [entry.key, entry.frame])));
}

function setAnimSpan(animation, length, loop) {
  const nextLength = Math.max(0.05, Math.round((Number(length) || 0) * 20) / 20);
  const nextLoop = loop === 'hold_on_last_frame' || loop === false ? loop : true;
  const currentLength = Number(animation?.animation_length) > 0 ? Number(animation.animation_length) : 1;
  if (nextLength === currentLength && keptLoop(animation?.loop) === nextLoop) return animation;
  return { ...(animation || {}), loop: nextLoop, animation_length: nextLength };
}

function clearBoneKey(animation, bone, channel, time) {
  if (!keyTimes(animation, bone, channel).includes(time)) return animation;
  return clearBoneKeys(animation, bone, channel, [time]);
}

function keyTimes(animation, bone, channel) {
  const kind = channel === "position" || channel === "scale" ? channel : "rotation";
  const frames = animation?.bones?.[bone]?.[kind];
  if (!frames || typeof frames !== "object" || Array.isArray(frames)) return [];
  return Object.keys(frames).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

module.exports = { trackOf, sampleTrack, curveSamples, clipTime, corresponds, pickDefault, clipFromBedrock, setRotationKey, setBoneKey, moveBoneKey, moveCurveKey, insertCurveKey, deleteCurveKey, moveBoneKeys, copyBoneKeys, pasteBoneKeys, clearBoneKeys, moveKeySelection, clearKeySelection, copyKeySelection, pasteKeySelection, setKeyMode, keyMode, setAnimSpan, clearBoneKey, keyTimes, hasExpressions, bezierAmount, bezierSegment, bakeBezier, bezierDraft, bezierPreviewSegment, soundEntries, setSoundKey, clearSoundKey };
