const lengths = { origin: 3, size: 3, pivot: 3, rotation: 3, uv: 2 };
const number = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6;
const { moveCubeGeometry, resizeCubeGeometry } = require("./model-vertex-edit.cjs");

function cubeProperty(cube, property) {
  if (property === "mirror") return !!cube.mirror;
  if (property === "inflate") {
    const value = cube.inflate ?? 0;
    if (!number(value)) throw Error("原膨胀数值无效");
    return value;
  }
  if (!Object.hasOwn(lengths, property)) throw Error("不支持的立方体属性");
  let value = cube[property];
  if (property === "pivot" && value === undefined) {
    const origin = cubeProperty(cube, "origin"), size = cubeProperty(cube, "size");
    value = origin.map((item, axis) => item + size[axis] / 2);
  }
  if (property === "rotation" && value === undefined) value = [0, 0, 0];
  if (!Array.isArray(value) || value.length !== lengths[property] || !value.every(number)) throw Error(property === "uv" ? "所选元素包含按面 UV，不能统一修改盒子 UV" : "原属性数值无效");
  return value;
}

function namedCube(cube, name) {
  const next = String(name ?? "").trim();
  if (next.length > 64) throw Error("立方体名称最多 64 个字符");
  if (/[\u0000-\u001f]/.test(next)) throw Error("立方体名称不能包含控制字符");
  const copy = { ...cube };
  if (next) copy.name = next;
  else delete copy.name;
  return JSON.stringify(copy) === JSON.stringify(cube) ? cube : copy;
}

function selectedCubes(bones, ids) {
  if (!Array.isArray(bones) || !Array.isArray(ids) || !ids.length || ids.length > 2000 || ids.some(id => typeof id !== "string" || !id)) throw Error("请选择有效立方体");
  const wanted = new Set(ids), cubes = new Map();
  for (const bone of bones) for (const cube of bone.cubes || []) if (wanted.has(cube.dgnId)) {
    if (cubes.has(cube.dgnId)) throw Error("所选元素标识重复，请重新打开模型");
    cubes.set(cube.dgnId, cube);
  }
  if (cubes.size !== wanted.size) throw Error("所选元素已变化，请重新选择");
  return cubes;
}

function changeCubeProperty(bones, ids, property, axis, value, mode = "set") {
  if (!["set", "add"].includes(mode)) throw Error("属性修改方式无效");
  const cubes = selectedCubes(bones, ids), changed = new Map();
  if (property === "mirror") {
    if (typeof value !== "boolean" || mode !== "set") throw Error("镜像贴图值无效");
    for (const [id, cube] of cubes) { cubeProperty(cube, "uv"); if (!!cube.mirror !== value) changed.set(id, { ...cube, mirror: value }); }
  } else {
    if (property !== "inflate" && (!Object.hasOwn(lengths, property) || !Number.isInteger(axis) || axis < 0 || axis >= lengths[property])) throw Error("属性分量无效");
    if (!number(value)) throw Error("属性值须为 -1000000 到 1000000 的有限数值");
    for (const [id, cube] of cubes) {
      const original = cubeProperty(cube, property), before = property === "inflate" ? original : original[axis];
      const next = Math.round((mode === "add" ? before + value : value) * 1000) / 1000;
      if (!number(next)) throw Error("修改后属性超出范围，未修改任何元素");
      if (next === before) continue;
      const result = property === "inflate" ? next : original.map((item, index) => index === axis ? next : item);
      const stored = { ...cube, [property]: result };
      changed.set(id, property === "origin" ? moveCubeGeometry(cube, result) : property === "size" ? resizeCubeGeometry(cube, result) : stored);
    }
  }
  if (!changed.size) return bones;
  return bones.map(bone => (bone.cubes || []).some(cube => changed.has(cube.dgnId)) ? { ...bone, cubes: bone.cubes.map(cube => changed.get(cube.dgnId) || cube) } : bone);
}

module.exports = { cubeProperty, selectedCubes, changeCubeProperty, namedCube };
