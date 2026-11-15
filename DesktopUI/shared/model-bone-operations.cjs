const { selectedBones } = require("./model-bone-properties.cjs");
const { ensureCubeIds, reparentBone, removeBone } = require("./model-edit.cjs");

function boneSelection(bones, names) {
  const selected = selectedBones(bones, names), all = new Map(bones.map(bone => [bone.name, bone]));
  const roots = [], tree = new Set();
  for (const bone of bones) {
    const ancestors = new Set([bone.name]);
    let parent = bone.parent, belowSelection = false;
    while (parent) {
      if (!all.has(parent) || ancestors.has(parent) || ancestors.size > 64) throw Error("骨骼层级无效，未修改模型");
      ancestors.add(parent);
      if (selected.has(parent)) belowSelection = true;
      parent = all.get(parent).parent;
    }
    if (selected.has(bone.name) || belowSelection) tree.add(bone.name);
    if (selected.has(bone.name) && !belowSelection) roots.push(bone.name);
  }
  return { selected, roots, tree };
}

function duplicateBones(bones, names) {
  const { selected, tree } = boneSelection(bones, names);
  if (bones.length + tree.size > 400) throw Error("复制后超过 400 根骨骼，未修改模型");
  const cubes = bones.reduce((sum, bone) => sum + (bone.cubes?.length || 0) * (tree.has(bone.name) ? 2 : 1), 0);
  if (cubes > 2000) throw Error("复制后超过 2000 个立方体，未修改模型");
  const used = new Set(bones.map(bone => bone.name.toLowerCase())), renamed = new Map();
  for (const name of tree) {
    let serial = 2, next;
    do { const suffix = String(serial++); next = name.slice(0, 64 - suffix.length) + suffix; } while (used.has(next.toLowerCase()));
    used.add(next.toLowerCase()); renamed.set(name, next);
  }
  const copies = bones.filter(bone => tree.has(bone.name)).map(bone => {
    const copy = structuredClone(bone);
    copy.name = renamed.get(bone.name);
    if (renamed.has(bone.parent)) copy.parent = renamed.get(bone.parent);
    for (const cube of copy.cubes || []) delete cube.dgnId;
    return copy;
  });
  return { bones: ensureCubeIds([...bones, ...copies]), names: [...selected.keys()].map(name => renamed.get(name)) };
}

function deleteBones(bones, names) {
  const { selected } = boneSelection(bones, names);
  // 沿用单骨骼删除规则：保留未选中的子骨骼，挂到最近的存续父级。
  return [...selected.keys()].reduce((next, name) => removeBone(next, name), bones);
}

function reparentBones(bones, names, parent) {
  const { roots, tree } = boneSelection(bones, names);
  if (parent && tree.has(parent)) throw Error("不能把骨骼挂到自己或所选骨骼的子级上");
  if (typeof parent !== "string" || (parent && !bones.some(bone => bone.name === parent))) throw Error("父级骨骼不存在");
  return roots.reduce((next, name) => (next.find(bone => bone.name === name).parent || "") === parent ? next : reparentBone(next, name, parent), bones);
}

module.exports = { boneSelection, duplicateBones, deleteBones, reparentBones };
