const { previewAnimations, controllerCompletion } = require("../../../shared/animation-controller-runtime.cjs");
const { evaluateMolang } = require("../../../shared/molang-preview.cjs");
const { readTransition, transitionIncoming } = require("../../../shared/controller-transition-curve.cjs");
const { clipFromBedrock, clipTime, sampleTrack } = require("../skins/npc-clip.cjs");

function shortestRotation(from, to, amount) {
  if (![from, to, amount].every(Number.isFinite) || Math.abs(from) > 1e6 || Math.abs(to) > 1e6 || amount < 0 || amount > 1) throw Error("最短旋转参数无效");
  const delta = to - from;
  let wrapped = ((delta + 180) % 360 + 360) % 360 - 180;
  // 恰好半圈时保留原始方向，避免正负 180 度随机翻转。
  if (wrapped === -180 && delta > 0) wrapped = 180;
  return from + wrapped * amount;
}

function controllerClip(animation) {
  if (!animation || typeof animation !== "object" || Array.isArray(animation)) throw Error("动画数据无效");
  for (const key of ["blend_weight", "anim_time_update", "start_delay", "loop_delay"]) {
    if (animation[key] !== undefined) throw Error("控制器预览暂不支持动画字段 " + key);
  }
  if (![undefined, true, false, "hold_on_last_frame"].includes(animation.loop)) throw Error("控制器预览暂不支持循环表达式");
  if (animation.override_previous_animation !== undefined && typeof animation.override_previous_animation !== "boolean") throw Error("动画覆盖标记无效");
  for (const tracks of Object.values(animation.bones || {})) {
    if (!tracks || Object.keys(tracks).some(key => !["rotation", "position", "scale"].includes(key))) throw Error("控制器预览含不支持的骨骼通道");
  }
  const clip = clipFromBedrock(animation);
  let length = animation.animation_length;
  if (length === undefined) {
    length = 0;
    for (const channels of Object.values(clip.bones)) for (const keys of Object.values(channels)) for (const frame of keys) length = Math.max(length, frame[0]);
    for (const kind of ["sound_effects", "particle_effects", "timeline"]) for (const key of Object.keys(animation[kind] || {})) {
      const at = Number(key);
      if (!key.trim() || !Number.isFinite(at) || at < 0) throw Error("动画效果时间无效");
      length = Math.max(length, at);
    }
  }
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0 || length > 10000) throw Error("动画时长须为 0–10000 秒的数字");
  return { ...clip, length, override: animation.override_previous_animation === true };
}

function controllerPose(controller, state, clips, time, transition = null, context) {
  if (!Number.isFinite(time) || time < 0) throw Error("控制器时间无效");
  if (transition && (!Number.isFinite(transition.duration) || transition.duration <= 0 || transition.duration > 60 || !Number.isFinite(transition.time) || transition.time < 0)) throw Error("状态过渡参数无效");
  const progress = transition ? Math.min(1, time / transition.duration) : 1;
  const incoming = transition ? transitionIncoming(readTransition(controller.states[transition.state]).points, progress) : 1;
  const shortest = transition && incoming > 0 && incoming < 1 && controller.states[transition.state].blend_via_shortest_path === true;
  const rotations = { from: Object.create(null), to: Object.create(null) };
  const layers = previewAnimations(controller, state).map(layer => ({ ...layer, state, time, factor: incoming, side: "to" }));
  if (transition && incoming < 1) {
    layers.push(...previewAnimations(controller, transition.state).map(layer => ({ ...layer, state: transition.state, time: transition.time, factor: 1 - incoming, side: "from" })));
  }
  const bones = Object.create(null), weights = [];
  const completion = controllerCompletion(controller, state, clips, time);
  const leaving = transition && incoming < 1 ? controllerCompletion(controller, transition.state, clips, transition.time) : null;
  for (const layer of layers) {
    const clip = clips[layer.id];
    if (!clip) throw Error("动画未加载：" + layer.id);
    let weight;
    const runtime = layer.side === "from" ? leaving.queries : completion.queries;
    try { weight = evaluateMolang(layer.weight, layer.time, context, runtime); }
    catch (reason) { throw Error(layer.id + " 权重：" + reason.message); }
    if (weight < 0 || weight > 1) throw Error(layer.id + " 权重结果须在 0–1 之间");
    const stateWeight = weight;
    weight *= layer.factor;
    weights.push({ id: layer.id, weight });
    if (!weight) continue;
    const at = clipTime(clip, layer.time);
    for (const [name, channels] of Object.entries(clip.bones)) {
      const target = bones[name] ||= {};
      for (const [channel, keys] of Object.entries(channels)) {
        const value = sampleTrack(keys, at, message => { throw Error(layer.id + " / " + name + "：" + message); }, context, runtime);
        if (!value) continue;
        if (shortest && channel === "r") {
          const previous = !clip.override && rotations[layer.side][name] ? rotations[layer.side][name] : [0, 0, 0];
          const mixed = value.map((item, axis) => previous[axis] + item * stateWeight);
          if (mixed.some(item => !Number.isFinite(item) || Math.abs(item) > 1e6)) throw Error("混合姿势数值超限");
          rotations[layer.side][name] = mixed;
          continue;
        }
        const base = channel === "s" ? 1 : 0;
        const previous = !clip.override && target[channel] ? target[channel][0].slice(1) : [base, base, base];
        // 与 Blockbench 一致：位移/欧拉角加权相加，缩放按相对 1 的倍率相乘。
        const mixed = value.map((item, axis) => channel === "s" ? previous[axis] * (1 + (item - 1) * weight) : previous[axis] + item * weight);
        if (mixed.some(item => !Number.isFinite(item) || Math.abs(item) > 1e6)) throw Error("混合姿势数值超限");
        target[channel] = [[0, ...mixed]];
      }
    }
  }
  if (shortest) {
    for (const name of new Set([...Object.keys(rotations.from), ...Object.keys(rotations.to)])) {
      const from = rotations.from[name] || [0, 0, 0], to = rotations.to[name] || [0, 0, 0];
      (bones[name] ||= {}).r = [[0, ...from.map((value, axis) => shortestRotation(value, to[axis], incoming))]];
    }
  }
  return { clip: { bones, length: 1, loop: false }, time: 0, weights, completion,
    transition: transition && progress < 1 ? { from: transition.state, to: state, progress } : null };
}

module.exports = { controllerClip, controllerPose, shortestRotation };
