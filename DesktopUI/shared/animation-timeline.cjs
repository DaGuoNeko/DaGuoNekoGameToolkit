function instructionText(value) {
  if (typeof value !== "string") throw Error("指令应为 1–512 个字符");
  const text = value.trim();
  if (!text || text.length > 512) throw Error("指令应为 1–512 个字符");
  if ([...text].some(char => char.charCodeAt(0) < 32)) throw Error("指令包含无法保存的控制字符");
  return text;
}

function instructionFrames(entries) {
  if (entries == null) return [];
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw Error("指令轨道数据无效");
  const rows = Object.entries(entries), used = new Set();
  if (rows.length > 1000) throw Error("指令最多 1000 条");
  return rows.map(([key, frame]) => {
    const time = Number(key);
    if (!String(key).trim() || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("指令时间无效");
    if (used.has(time)) throw Error("指令时间重复");
    used.add(time);
    if (Array.isArray(frame)) throw Error("同一时间暂不支持多条指令");
    if (typeof frame !== "string") throw Error("指令数据无效");
    return { key, time, text: instructionText(frame) };
  }).sort((a, b) => a.time - b.time);
}

function targetTime(time) {
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 10000) throw Error("指令时间无效");
  return Math.round(time * 20) / 20;
}

function setInstructionKey(animation, time, text) {
  const command = instructionText(text);
  const at = targetTime(time), rows = instructionFrames(animation?.timeline);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  const timeline = { ...animation?.timeline, [row?.key ?? at.toFixed(2)]: command };
  instructionFrames(timeline);
  return { ...animation, timeline, animation_length: Math.max(Number(animation?.animation_length) || 0, row?.time ?? at) };
}

function clearInstructionKey(animation, time) {
  const at = targetTime(time), rows = instructionFrames(animation?.timeline);
  const row = rows.find(item => item.time === time) || rows.find(item => item.time === at);
  if (!row) throw Error("这个时间没有指令");
  const timeline = { ...animation.timeline };
  delete timeline[row.key];
  const next = { ...animation };
  if (Object.keys(timeline).length) next.timeline = timeline;
  else delete next.timeline;
  return next;
}

module.exports = { instructionText, instructionFrames, setInstructionKey, clearInstructionKey };
