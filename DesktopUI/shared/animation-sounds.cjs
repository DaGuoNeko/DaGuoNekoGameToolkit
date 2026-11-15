const object = value => value && typeof value === "object" && !Array.isArray(value);

function soundName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(value)) throw Error("声音名称应为 1–128 个字母、数字、下划线、点、斜线、冒号或短横线");
  return value;
}

function soundLevel(value, label) {
  if (value == null || value === "") return undefined;
  const number = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 256) throw Error(label + "应为 0–256 的数字");
  return Math.round(number * 1000) / 1000;
}

function soundFrames(effects) {
  if (effects == null) return [];
  if (!object(effects)) throw Error("声音轨道数据无效");
  const entries = Object.entries(effects), used = new Set();
  if (entries.length > 1000) throw Error("声音事件最多 1000 个");
  let count = 0;
  return entries.map(([key, frame]) => {
    const time = Number(key);
    if (!key.trim() || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("声音时间无效");
    if (used.has(time)) throw Error("声音时间重复");
    used.add(time);
    const values = Array.isArray(frame) ? frame : [frame];
    if (!values.length || (count += values.length) > 1000) throw Error("声音事件为空或超过 1000 个");
    const sounds = values.map(value => {
      if (typeof value === "string") return { effect: soundName(value) };
      if (!object(value)) throw Error("声音事件数据无效");
      soundName(value.effect);
      return value;
    });
    return { key, time, sounds };
  }).sort((a, b) => a.time - b.time);
}

function targetTime(time) {
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("声音时间无效");
  return Math.round(time * 20) / 20;
}

function setSoundKey(animation, time, effect, index = 0, level) {
  const name = soundName(typeof effect === "string" ? effect.trim() : effect);
  const pitch = level && Object.hasOwn(level, "pitch") ? soundLevel(level.pitch, "音高") : undefined;
  const volume = level && Object.hasOwn(level, "volume") ? soundLevel(level.volume, "音量") : undefined;
  const at = targetTime(time), rows = soundFrames(animation?.sound_effects);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  if (!Number.isInteger(index) || index < -1 || (row ? index >= row.sounds.length : index > 0)) throw Error("声音选择已变化，请重新选择");
  const withLevel = base => {
    const next = { ...base, effect: name };
    if (level && Object.hasOwn(level, "pitch")) { if (pitch == null) delete next.pitch; else next.pitch = pitch; }
    if (level && Object.hasOwn(level, "volume")) { if (volume == null) delete next.volume; else next.volume = volume; }
    return next;
  };
  const sounds = row ? row.sounds.slice() : [];
  if (index === -1 || !row) sounds.push(withLevel({}));
  else sounds[index] = withLevel(sounds[index]);
  const effects = { ...animation?.sound_effects, [row?.key ?? at.toFixed(2)]: row && Array.isArray(animation.sound_effects[row.key]) || sounds.length > 1 ? sounds : sounds[0] };
  soundFrames(effects);
  return { ...animation, sound_effects: effects, animation_length: Math.max(Number(animation?.animation_length) || 0, row?.time ?? at) };
}

function clearSoundKey(animation, time, index = 0) {
  const at = targetTime(time), rows = soundFrames(animation?.sound_effects);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  if (!row) throw Error("这个时间没有声音");
  if (!Number.isInteger(index) || index < 0 || index >= row.sounds.length) throw Error("声音选择已变化，请重新选择");
  const sounds = row.sounds.filter((_, i) => i !== index), effects = { ...animation.sound_effects };
  if (sounds.length) effects[row.key] = Array.isArray(animation.sound_effects[row.key]) ? sounds : sounds[0];
  else delete effects[row.key];
  const next = { ...animation };
  if (Object.keys(effects).length) next.sound_effects = effects;
  else delete next.sound_effects;
  return next;
}

module.exports = { soundName, soundLevel, soundFrames, setSoundKey, clearSoundKey };
