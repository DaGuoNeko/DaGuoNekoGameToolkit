import { Quaternion, Vector3 } from "three";
import { buildModel } from "../skins/npc-model-view.jsx";
import { selectedCubes } from "../../../shared/model-cube-properties.cjs";
import { inflateCubeVertices } from "../../../shared/model-vertex-edit.cjs";

export const VERTEX_SNAP_DISTANCE = 0.5;
const validVector = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
const cell = vector => [vector.x, vector.y, vector.z].map(n => Math.floor(n / VERTEX_SNAP_DISTANCE));

export function vertexSnapContext(bones, ids, hidden = []) {
  const selected = selectedCubes(bones, ids), names = new Map(), lowercaseNames = new Set(), sources = [], targets = new Map(), inverse = new Map();
  if (bones.length > 400 || bones.reduce((sum, bone) => sum + (bone.cubes || []).length, 0) > 2000) throw Error("顶点吸附最多支持 400 根骨骼、2000 个立方体");
  for (const bone of bones) {
    if (typeof bone.name !== "string" || !bone.name || lowercaseNames.has(bone.name.toLowerCase())) throw Error("骨骼名称无效或重复");
    lowercaseNames.add(bone.name.toLowerCase());
    names.set(bone.name, bone);
    if (!validVector(bone.pivot ?? [0, 0, 0]) || !validVector(bone.rotation ?? [0, 0, 0]) || bone.binding || bone.reset || bone.scale !== undefined || bone.bind_pose_rotation !== undefined) throw Error("骨骼姿态不支持可靠的顶点吸附");
    for (const cube of bone.cubes || []) if (!validVector(cube.origin) || !validVector(cube.size) || !validVector(cube.rotation ?? [0, 0, 0]) || cube.pivot !== undefined && !validVector(cube.pivot) || !Number.isFinite(cube.inflate ?? 0) || Math.abs(cube.inflate ?? 0) > 1e6) throw Error("立方体姿态数值无效");
  }
  for (const bone of bones) {
    const seen = new Set([bone.name]); let parent = bone.parent;
    while (parent) { if (!names.has(parent) || seen.has(parent) || seen.size >= 64) throw Error("骨骼层级缺失、循环或超过 64 层"); seen.add(parent); parent = names.get(parent).parent; }
  }
  const built = buildModel({ bones, tw: 64, th: 64, hidden });
  try {
    built.root.updateMatrixWorld(true);
    for (const mesh of built.meshes) {
      const key = mesh.userData.cubeKey, split = key.lastIndexOf(":"), bone = names.get(key.slice(0, split)), cube = bone.cubes[Number(key.slice(split + 1))];
      const moving = selected.has(cube.dgnId);
      if (moving) inverse.set(cube.dgnId, mesh.parent.parent.getWorldQuaternion(new Quaternion()).invert());
      const attribute = mesh.geometry.attributes.position, unique = new Set();
      for (let i = 0; i < attribute.count; i++) {
        const point = new Vector3().fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).multiplyScalar(16);
        if (!point.toArray().every(Number.isFinite)) throw Error("顶点位置无效");
        const positionKey = point.toArray().map(n => n.toFixed(8)).join(":");
        if (unique.has(positionKey)) continue; unique.add(positionKey);
        const entry = { point, bone: bone.name, cube: Number(key.slice(split + 1)), id: cube.dgnId, corner: unique.size - 1 };
        if (moving) sources.push(entry);
        else { const bucket = cell(point).join(":"); if (!targets.has(bucket)) targets.set(bucket, []); targets.get(bucket).push(entry); }
      }
    }
    // 隐藏的已选元素仍随整组移动，但不能提供吸附顶点。
    for (const bone of bones) for (const cube of bone.cubes || []) if (selected.has(cube.dgnId) && !inverse.has(cube.dgnId)) {
      const group = built.groups.get(bone.name.toLowerCase()); inverse.set(cube.dgnId, group.getWorldQuaternion(new Quaternion()).invert());
    }
    if (!sources.length) throw Error("请选择至少一个可见且有体积的立方体再使用顶点吸附");
    return { bones, selected, sources, targets, inverse };
  } finally { for (const mesh of built.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); } }
}

export function moveWithVertexSnap(context, delta) {
  if (!validVector(delta)) throw Error("移动量无效或超出范围");
  const move = new Vector3(...delta);
  let closest = null, best = VERTEX_SNAP_DISTANCE ** 2 + 1e-12;
  for (const source of context.sources) {
    const moved = source.point.clone().add(move), [x, y, z] = cell(moved);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const target of context.targets.get([x + dx, y + dy, z + dz].join(":")) || []) {
        const distance = moved.distanceToSquared(target.point);
        if (distance < best) { best = distance; closest = { source, target }; }
      }
    }
  }
  if (closest) move.copy(closest.target.point).sub(closest.source.point);
  return { bones: translatedCubes(context, move), target: closest ? { bone: closest.target.bone, cube: closest.target.cube, point: closest.target.point.toArray() } : null, delta: move.toArray() };
}

function translatedCubes(context, move) {
  if (!move.toArray().every(Number.isFinite)) throw Error("顶点移动量无效");
  if (move.lengthSq() < 1e-20) return context.bones;
  const converted = new Map();
  for (const [id, cube] of context.selected) {
    const local = move.clone().applyQuaternion(context.inverse.get(id));
    const shift = value => value.map((n, axis) => {
      const next = n + local.getComponent(axis);
      if (!Number.isFinite(next) || Math.abs(next) > 1e6) throw Error("吸附后坐标超出范围，未修改任何元素");
      return Number(next.toFixed(10));
    });
    converted.set(id, { ...cube, origin: shift(cube.origin), ...(cube.pivot ? { pivot: shift(cube.pivot) } : {}) });
    if (cube.dgn_vertices !== undefined) converted.get(id).dgn_vertices = cube.dgn_vertices.map(shift);
  }
  return context.bones.map(bone => (bone.cubes || []).some(cube => converted.has(cube.dgnId)) ? { ...bone, cubes: bone.cubes.map(cube => converted.get(cube.dgnId) || cube) } : bone);
}

export function alignVertexPoints(context, source, target, axis = "all") {
  if (!["all", "x", "y", "z"].includes(axis)) throw Error("顶点对齐轴无效");
  if (!context.sources.includes(source) || ![...context.targets.values()].some(points => points.includes(target))) throw Error("顶点选择已变化，请重新选择源点与目标点");
  const delta = target.point.clone().sub(source.point);
  if (axis !== "all") for (let i = 0; i < 3; i++) if (i !== "xyz".indexOf(axis)) delta.setComponent(i, 0);
  return { bones: translatedCubes(context, delta), delta: delta.toArray(), point: source.point.clone().add(delta).toArray() };
}

export function pickProjectedVertex(points, camera, x, y, width, height) {
  let nearest = null, distance = 100, depth = Infinity;
  for (const vertex of points || []) {
    const point = vertex.point.clone().multiplyScalar(1 / 16).project(camera);
    if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
    const d = ((point.x + 1) * width / 2 - x) ** 2 + ((1 - point.y) * height / 2 - y) ** 2;
    if (d <= 100 && (d < distance - 0.01 || Math.abs(d - distance) <= 0.01 && point.z < depth)) { nearest = vertex; distance = d; depth = point.z; }
  }
  return nearest;
}

export function cubeVertexMarkers(bones, boneName, cubeIndex, hidden = []) {
  const bone = bones.find(item => item.name === boneName);
  const cube = bone?.cubes?.[cubeIndex];
  if (!bone || !cube) return [];
  const points = inflateCubeVertices(cube);
  const origin = Array.isArray(cube.origin) ? cube.origin : [0, 0, 0];
  const size = Array.isArray(cube.size) ? cube.size : [0, 0, 0];
  const pivot = Array.isArray(cube.pivot) ? cube.pivot : origin.map((value, axis) => (Number(value) || 0) + (Number(size[axis]) || 0) / 2);
  const built = buildModel({ bones, tw: 64, th: 64, hidden });
  try {
    built.root.updateMatrixWorld(true);
    const mesh = built.meshes.find(item => item.userData.cubeKey === boneName + ":" + cubeIndex);
    if (!mesh?.parent) return [];
    return points.map((point, index) => ({ index, bone: boneName, cube: cubeIndex, point: mesh.parent.localToWorld(new Vector3((point[0] - pivot[0]) / 16, (point[1] - pivot[1]) / 16, (point[2] - pivot[2]) / 16)).multiplyScalar(16) }));
  } finally { for (const mesh of built.meshes) { mesh.geometry.dispose(); mesh.material.dispose?.(); } }
}
export function meshVertexMarkers(bones, boneName, hidden = []) {
  const bone = bones.find(item => item.name === boneName);
  const welds = bone?.dgn_mesh_welds || [];
  if (!bone?.poly_mesh || welds.length !== bone.poly_mesh.positions?.length) return [];
  const built = buildModel({ bones, tw: 64, th: 64, hidden });
  try {
    built.root.updateMatrixWorld(true);
    const mesh = built.meshes.find(item => item.userData.cubeKey === boneName + ":mesh");
    const space = mesh || built.groups.get(boneName.toLowerCase());
    if (!space) return [];
    const pivot = bone.pivot || [0, 0, 0];
    const seen = new Set();
    const markers = [];
    welds.forEach((weld, index) => {
      if (seen.has(weld)) return;
      seen.add(weld);
      const point = bone.poly_mesh.positions[index];
      markers.push({ index: weld, bone: boneName, mesh: true, point: space.localToWorld(new Vector3((point[0] - pivot[0]) / 16, (point[1] - pivot[1]) / 16, (point[2] - pivot[2]) / 16)).multiplyScalar(16) });
    });
    return markers;
  } finally { for (const mesh of built.meshes) { mesh.geometry.dispose(); mesh.material.dispose?.(); } }
}
