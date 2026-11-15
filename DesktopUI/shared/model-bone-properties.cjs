const number = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6;

function boneProperty(bone, property) {
  if (!["pivot", "rotation"].includes(property)) throw Error("不能批量修改这个骨骼属性");
  const value = bone?.[property];
  if (value === undefined) return [0, 0, 0];
  if (!Array.isArray(value) || value.length !== 3 || !value.every(number)) throw Error("骨骼原属性数值无效");
  return value;
}

function selectedBones(bones, names) {
  if (!Array.isArray(bones) || bones.length > 400 || !Array.isArray(names) || !names.length || names.length > 400 || names.some(name => typeof name !== "string" || !name)) throw Error("请选择 1–400 根有效骨骼");
  const selected = new Set(names), found = new Map();
  const allNames = new Set();
  for (const bone of bones) {
    if (!bone || typeof bone.name !== "string" || allNames.has(bone.name.toLowerCase())) throw Error("骨骼名称无效或重复，请重新打开模型");
    allNames.add(bone.name.toLowerCase());
    if (selected.has(bone.name)) found.set(bone.name, bone);
  }
  if (found.size !== selected.size) throw Error("选择已变化，请重新选择");
  return found;
}

function changeBoneProperty(bones, names, property, axis, value, mode) {
  if (!["pivot", "rotation"].includes(property) || ![0, 1, 2].includes(axis)) throw Error("不能批量修改这个骨骼属性");
  if (!["set", "add"].includes(mode)) throw Error("批量修改方式无效");
  if (!number(value)) throw Error("属性值须为 -1000000 到 1000000 的有限数值");
  const found = selectedBones(bones, names), changed = new Map();
  for (const [name, bone] of found) {
    const current = boneProperty(bone, property);
    const next = current.slice();
    next[axis] = Math.round(((mode === "add" ? current[axis] : 0) + value) * 1000) / 1000;
    if (!number(next[axis])) throw Error("修改后属性超出范围，未修改任何骨骼");
    if (next[axis] !== current[axis]) changed.set(name, { ...bone, [property]: next });
  }
  return changed.size ? bones.map(bone => changed.get(bone.name) || bone) : bones;
}

module.exports = { boneProperty, selectedBones, changeBoneProperty };
