const { selectedCubes } = require("./model-cube-properties.cjs");

function duplicateCubes(bones, ids) {
  const selected = selectedCubes(bones, ids);
  const all = bones.flatMap(bone => bone.cubes || []);
  if (all.length + selected.size > 2000) throw Error("复制后超过 2000 个立方体，未修改模型");
  const used = new Set(all.map(cube => cube.dgnId)), created = []; let serial = 1, picked = null;
  const next = bones.map(bone => {
    const copies = (bone.cubes || []).filter(cube => selected.has(cube.dgnId)).map(cube => {
      while (used.has("c" + serial)) serial++;
      const copy = structuredClone(cube); copy.dgnId = "c" + serial++; used.add(copy.dgnId); created.push(copy.dgnId); return copy;
    });
    if (!copies.length) return bone;
    picked = { bone: bone.name, cube: bone.cubes.length + copies.length - 1 };
    return { ...bone, cubes: [...bone.cubes, ...copies] };
  });
  return { bones: next, ids: created, picked };
}

function deleteCubes(bones, ids) {
  const selected = selectedCubes(bones, ids);
  return bones.map(bone => (bone.cubes || []).some(cube => selected.has(cube.dgnId))
    ? { ...bone, cubes: bone.cubes.filter(cube => !selected.has(cube.dgnId)) } : bone);
}

function moveCubes(bones, ids, targetName, beforeId = null) {
  const selected = selectedCubes(bones, ids);
  const targets = bones.filter(bone => bone.name === targetName);
  if (targets.length !== 1) throw Error("目标骨骼不存在或名称重复，未移动任何元素");
  const target = targets[0], targetCubes = target.cubes || [];
  if (beforeId !== null && targetCubes.filter(cube => cube.dgnId === beforeId).length !== 1) throw Error("目标位置已变化，请重新拖动");
  if (beforeId !== null && selected.has(beforeId)) return { bones, ids: [...selected.keys()], picked: null };
  const moving = bones.flatMap(bone => (bone.cubes || []).filter(cube => selected.has(cube.dgnId)));
  const remaining = targetCubes.filter(cube => !selected.has(cube.dgnId));
  const at = beforeId === null ? remaining.length : remaining.findIndex(cube => cube.dgnId === beforeId);
  const destination = [...remaining.slice(0, at), ...moving, ...remaining.slice(at)];
  let changed = false;
  const next = bones.map(bone => {
    const previous = bone.cubes || [];
    const cubes = bone === target ? destination : previous.filter(cube => !selected.has(cube.dgnId));
    if (cubes.length === previous.length && cubes.every((cube, index) => cube === previous[index])) return bone;
    changed = true; return { ...bone, cubes };
  });
  return { bones: changed ? next : bones, ids: moving.map(cube => cube.dgnId), picked: { bone: targetName, cube: at + moving.length - 1 } };
}

module.exports = { duplicateCubes, deleteCubes, moveCubes };
