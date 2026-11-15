const object = value => value && typeof value === "object" && !Array.isArray(value);

function particleName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(value)) throw Error(label + "应为 1–128 个字母、数字、下划线、点、斜线、冒号或短横线");
  return value;
}

function particleScript(value) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw Error("粒子脚本应为 1–512 个字符");
  const text = value.trim();
  if (!text || text.length > 512) throw Error("粒子脚本应为 1–512 个字符");
  if ([...text].some(char => char.charCodeAt(0) < 32)) throw Error("粒子脚本包含无法保存的控制字符");
  return text;
}

function particleBind(value) {
  if (value == null || value === false) return undefined;
  if (value === true) return true;
  throw Error("绑定到实体只能是是否");
}

function particleFrames(effects) {
  if (effects == null) return [];
  if (!object(effects)) throw Error("粒子轨道数据无效");
  const entries = Object.entries(effects), used = new Set();
  if (entries.length > 1000) throw Error("粒子事件最多 1000 个");
  return entries.map(([key, frame]) => {
    const time = Number(key);
    if (!String(key).trim() || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("粒子时间无效");
    if (used.has(time)) throw Error("粒子时间重复");
    used.add(time);
    if (Array.isArray(frame)) throw Error("同一时间暂不支持多条粒子");
    if (!object(frame)) throw Error("粒子事件数据无效");
    particleName(frame.effect, "粒子名称");
    if (frame.locator != null && frame.locator !== "") particleName(frame.locator, "定位器名称");
    if (frame.pre_effect_script != null && frame.pre_effect_script !== "") particleScript(frame.pre_effect_script);
    if (frame.bind_to_actor != null) particleBind(frame.bind_to_actor);
    return { key, time, effect: frame.effect, locator: frame.locator || "", source: frame };
  }).sort((a, b) => a.time - b.time);
}

function targetTime(time) {
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("粒子时间无效");
  return Math.round(time * 20) / 20;
}

function setParticleKey(animation, time, effect, locator = "", extra) {
  const name = particleName(typeof effect === "string" ? effect.trim() : effect, "粒子名称");
  const where = typeof locator === "string" ? locator.trim() : locator;
  if (where) particleName(where, "定位器名称");
  else if (where !== "") throw Error("定位器名称应为 1–128 个字母、数字、下划线、点、斜线、冒号或短横线");
  const script = extra && Object.hasOwn(extra, "script") ? particleScript(extra.script) : undefined;
  const bind = extra && Object.hasOwn(extra, "bind") ? particleBind(extra.bind) : undefined;
  const at = targetTime(time), rows = particleFrames(animation?.particle_effects);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  const next = { ...(row?.source || {}), effect: name };
  if (where) next.locator = where;
  else delete next.locator;
  if (extra && Object.hasOwn(extra, "script")) { if (script) next.pre_effect_script = script; else delete next.pre_effect_script; }
  if (extra && Object.hasOwn(extra, "bind")) { if (bind) next.bind_to_actor = true; else delete next.bind_to_actor; }
  const effects = { ...animation?.particle_effects, [row?.key ?? at.toFixed(2)]: next };
  particleFrames(effects);
  return { ...animation, particle_effects: effects, animation_length: Math.max(Number(animation?.animation_length) || 0, row?.time ?? at) };
}

function clearParticleKey(animation, time) {
  const at = targetTime(time), rows = particleFrames(animation?.particle_effects);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  if (!row) throw Error("这个时间没有粒子");
  const effects = { ...animation.particle_effects };
  delete effects[row.key];
  const next = { ...animation };
  if (Object.keys(effects).length) next.particle_effects = effects;
  else delete next.particle_effects;
  return next;
}

module.exports = { particleName, particleScript, particleBind, particleFrames, setParticleKey, clearParticleKey };
