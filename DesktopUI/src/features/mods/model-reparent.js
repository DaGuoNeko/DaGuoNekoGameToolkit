import { Euler, Matrix4, Quaternion, Vector3, MathUtils } from "three";
import { moveCubes } from "../../../shared/model-cube-operations.cjs";

const vector = (value, fallback) => {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length !== 3 || result.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) throw Error("姿态转换需要有效的三维坐标，范围为 ±1000000");
  return new Vector3(...result);
};
const rotation = (value, sign = 1) => {
  const v = vector(value, [0, 0, 0]).multiplyScalar(sign * MathUtils.DEG2RAD);
  return new Quaternion().setFromEuler(new Euler(v.x, v.y, v.z, "ZYX"));
};
const rigid = (position, quaternion) => new Matrix4().compose(position, quaternion, new Vector3(1, 1, 1));
const output = vector => vector.toArray().map(value => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e6) throw Error("转换后的坐标超出范围，未移动任何元素");
  return Number(value.toFixed(10));
});

export function moveCubesKeepingPose(bones, ids, targetName, beforeId = null) {
  const moved = moveCubes(bones, ids, targetName, beforeId);
  if (moved.bones === bones) return moved;
  const wanted = new Set(ids), byName = new Map(), frames = new Map(), visiting = new Set();
  if (bones.length > 400) throw Error("骨骼数量超过 400");
  for (const bone of bones) {
    if (typeof bone.name !== "string" || !bone.name || byName.has(bone.name)) throw Error("骨骼名称无效或重复");
    byName.set(bone.name, bone);
  }
  const frame = name => {
    if (frames.has(name)) return frames.get(name);
    const bone = byName.get(name);
    if (!bone || visiting.has(name) || visiting.size >= 64) throw Error("骨骼层级缺失、循环或超过 64 层");
    if (bone.binding || bone.reset || bone.bind_pose_rotation !== undefined || bone.scale !== undefined) throw Error("当前骨骼包含额外姿态属性，不能可靠保持静止姿态");
    visiting.add(name);
    const pivot = vector(bone.pivot, [0, 0, 0]);
    const parent = bone.parent ? frame(bone.parent) : null;
    const parentPivot = bone.parent ? vector(byName.get(bone.parent).pivot, [0, 0, 0]) : new Vector3();
    const matrix = rigid(pivot.clone().sub(parentPivot), rotation(bone.rotation));
    if (parent) matrix.premultiply(parent);
    visiting.delete(name); frames.set(name, matrix); return matrix;
  };
  const target = byName.get(targetName), targetInverse = frame(targetName).clone().invert(), targetPivot = vector(target.pivot, [0, 0, 0]);
  const converted = new Map();
  for (const bone of bones) for (const cube of bone.cubes || []) {
    if (!wanted.has(cube.dgnId) || bone.name === targetName) continue;
    const origin = vector(cube.origin), size = vector(cube.size);
    const pivot = vector(cube.pivot, origin.clone().addScaledVector(size, 0.5).toArray());
    const local = rigid(pivot.clone().sub(vector(bone.pivot, [0, 0, 0])), rotation(cube.rotation, -1));
    const transformed = targetInverse.clone().multiply(frame(bone.name)).multiply(local);
    const nextPivot = new Vector3().setFromMatrixPosition(transformed).add(targetPivot);
    // ZYX 分解在接近万向锁时仍保留可确定的角度，立方体旋转与骨骼符号相反。
    const m = transformed.elements, cosY = Math.hypot(m[0], m[1]);
    const angles = new Vector3(cosY > 1e-10 ? Math.atan2(m[6], m[10]) : 0, Math.atan2(-m[2], cosY), cosY > 1e-10 ? Math.atan2(m[1], m[0]) : Math.atan2(-m[4], m[5])).multiplyScalar(-MathUtils.RAD2DEG);
    const next = { ...cube, origin: output(nextPivot.clone().add(origin).sub(pivot)), pivot: output(nextPivot), rotation: output(angles) };
    if (cube.dgn_vertices !== undefined) next.dgn_vertices = cube.dgn_vertices.map(point => output(nextPivot.clone().add(vector(point)).sub(pivot)));
    converted.set(cube.dgnId, next);
  }
  return { ...moved, bones: moved.bones.map(bone => bone.name === targetName ? { ...bone, cubes: bone.cubes.map(cube => converted.get(cube.dgnId) || cube) } : bone) };
}
